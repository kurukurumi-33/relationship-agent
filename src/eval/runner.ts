import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
} from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import { Store } from "../store/store.js";
import { seedState } from "../data/seed.js";
import { runSession } from "../session/run.js";
import { Outbox } from "../runtime/outbox.js";
import { MockDevice } from "../runtime/device.js";
import { DEFAULT_BUDGET, type Budget } from "../agent/guard.js";
import type { CaseResult, EvalCase, Expectations, ScriptStep } from "./case.js";

interface RunCaseOptions {
  rootDir: string;
  /** 不传则用脚本化模型；传了就跑真实模型（脚本会被忽略） */
  model?: Model<any>;
}

function toResponses(script: ScriptStep[]) {
  return script.map((step) =>
    step.toolCall
      ? fauxAssistantMessage([fauxToolCall(step.toolCall.name, step.toolCall.arguments ?? {})], {
          stopReason: "toolUse",
        })
      : fauxAssistantMessage([fauxText(step.text ?? "")]),
  );
}

function toolsCalledFrom(messages: unknown[]): string[] {
  const names: string[] = [];
  for (const m of messages as Array<{ role: string; content: unknown }>) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type: string; name?: string };
      if (b.type === "toolCall" && b.name) names.push(b.name);
    }
  }
  return names;
}

function toolErrorsFrom(messages: unknown[]): number {
  let errors = 0;
  for (const m of messages as Array<{ role: string; isError?: boolean }>) {
    if (m.role === "toolResult" && m.isError) errors += 1;
  }
  return errors;
}

function checkExpectations(
  expect: Expectations,
  observed: Record<string, number>,
  text: string,
  tools: string[],
): string[] {
  const failures: string[] = [];

  for (const [key, value] of Object.entries(expect)) {
    // 这个键名本身带点号但语义特殊（上限而不是等值），必须在通用数值分支之前处理
    if (key === "tools.maxCalls") {
      const actual = observed["tools.total"] ?? 0;
      if (actual > (value as number)) {
        failures.push(`工具调用 ${actual} 次，超过上限 ${value}（路径冗余）`);
      }
      continue;
    }
    if (typeof value === "number") {
      const actual = observed[key] ?? 0;
      if (actual !== value) failures.push(`${key} 期望 ${value}，实际 ${actual}`);
      continue;
    }
    if (key === "tools.called") {
      for (const name of value as string[]) {
        if (!tools.includes(name)) failures.push(`期望调用 ${name}，实际没调用`);
      }
      continue;
    }
    if (key === "tools.notCalled") {
      for (const name of value as string[]) {
        if (tools.includes(name)) failures.push(`不应调用 ${name}，实际调用了`);
      }
      continue;
    }
    if (key === "textContains") {
      for (const fragment of value as string[]) {
        if (!text.includes(fragment)) failures.push(`回答应包含「${fragment}」`);
      }
      continue;
    }
    if (key === "textNotContains") {
      for (const fragment of value as string[]) {
        if (text.includes(fragment)) failures.push(`回答泄漏了「${fragment}」`);
      }
    }
  }

  return failures;
}

/**
 * 跑一条用例：独立存储、独立设备、独立模型队列。
 *
 * 每条用例必须隔离——共用 store 会让"记忆条数"这类断言互相污染，
 * 前一条用例写进去的记忆会把后一条的 itemsDelta 顶掉。
 */
export async function runCase(testCase: EvalCase, opts: RunCaseOptions): Promise<CaseResult> {
  const started = Date.now();
  const statePath = join(opts.rootDir, "data", "eval", `${testCase.id}.db`);
  const ledgerPath = join(opts.rootDir, "data", "eval", `${testCase.id}.jsonl`);
  await Store.reset(statePath);
  await rm(ledgerPath, { force: true });

  const store = await Store.open(statePath);
  await store.seedIfEmpty(seedState);

  const personId = testCase.personId ?? "p_001";
  const beforeItems = (await store.getMemoryDoc(personId)).items.length;

  const device = new MockDevice(ledgerPath, testCase.device ?? {});
  const outbox = new Outbox(store, device);

  const budget: Budget = { ...DEFAULT_BUDGET, ...(testCase.budget ?? {}) };

  const usingRealModel = Boolean(opts.model);
  let registration: ReturnType<typeof registerFauxProvider> | undefined;
  let model = opts.model;
  if (!model) {
    registration = registerFauxProvider({});
    registration.setResponses(toResponses(testCase.script ?? []));
    model = registration.getModel();
  }

  const result = await runSession({
    store,
    personId,
    goal: testCase.goal,
    model,
    // 真模型跑到追问时不能给空答案：拿到空对象它会以为用户没回，然后重复追问。
    // 取每个问题的第一个选项，让对话继续往下走。
    survey: async (questions) =>
      Object.fromEntries(questions.map((q) => [q.id, q.options?.[0] ?? ""])),
    confirm: async () => true,
    review: async () => true,
    outbox,
    budget,
    insight: testCase.insight ? { model } : undefined,
  });

  registration?.unregister();

  const cards = await store.listActions(personId);
  const candidates = await store.listCandidates(personId);
  const session = await store.getSession(result.sessionId);
  const tools = toolsCalledFrom(session?.messages ?? []);
  const toolErrors = toolErrorsFrom(session?.messages ?? []);

  const observed: Record<string, number> = {
    "cards.total": cards.length,
    "cards.executed": cards.filter((c) => c.status === "executed").length,
    "cards.failed": cards.filter((c) => c.status === "failed").length,
    "candidates.approved": candidates.filter((c) => c.status === "approved").length,
    "candidates.rejected": candidates.filter((c) => c.status === "rejected").length,
    "memory.itemsDelta": (await store.getMemoryDoc(personId)).items.length - beforeItems,
    handoffs: result.handoffs.length,
    "guard.blocked": result.stats.blockedCalls,
    "tools.total": tools.length,
    "tools.errors": toolErrors,
    "tools.askUser": tools.filter((t) => t === "ask_user").length,
  };

  const failures = checkExpectations(
    usingRealModel ? { ...testCase.expect, ...testCase.expectReal } : (testCase.expect ?? {}),
    observed,
    result.text,
    tools,
  );

  return {
    id: testCase.id,
    title: testCase.title,
    tags: testCase.tags,
    passed: failures.length === 0,
    failures,
    observed,
    text: result.text,
    tools,
    tokens: result.usage.totalTokens,
    cost: result.usage.cost,
    toolCalls: tools.length,
    toolErrors,
    durationMs: Date.now() - started,
  };
}