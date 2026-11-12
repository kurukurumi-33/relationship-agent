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
import type {
  CaseResult,
  EvalCase,
  EvalSession,
  Expectations,
  RangeExpectation,
  RealExpectations,
  ScriptStep,
} from "./case.js";

interface RunCaseOptions {
  rootDir: string;
  /** 不传则用脚本化模型；传了就跑真实模型（脚本会被忽略） */
  model?: Model<any>;
}

/** 评测统一的时间锚点：11 月 1 日上午，种子证据里的 11 月 2 日正好是"明天"。 */
const DEFAULT_EVAL_NOW = new Date("2026-11-01T08:00:00+08:00");

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

/** 把工具结果拼成一段文本，用来断言"工具到底把什么给了模型"。 */
function toolOutputFrom(messages: unknown[]): string {
  const parts: string[] = [];
  for (const m of messages as Array<{ role: string; content: unknown }>) {
    if (m.role !== "toolResult") continue;
    if (typeof m.content === "string") {
      parts.push(m.content);
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/** 合并 `expect` 与 `expectReal`；`expectReal` 里写 null 的项会被删掉。 */
function mergeExpect(scripted: Expectations, real: RealExpectations | undefined): Expectations {
  if (!real) return scripted;
  const merged: Record<string, unknown> = { ...scripted };
  for (const [key, value] of Object.entries(real)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged as Expectations;
}

function checkExpectations(
  expect: Expectations,
  observed: Record<string, number>,
  text: string,
  tools: string[],
  toolOutput: string,
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
    if (key === "tools.minCalls") {
      const actual = observed["tools.total"] ?? 0;
      if (actual < (value as number)) {
        failures.push(`工具调用 ${actual} 次，少于下限 ${value}`);
      }
      continue;
    }
    // 区间断言：对象形式 {min,max}。真模型下"至少做成一件"比"正好一条"稳。
    // 必须排在数组分支之前判断，因为数组的 typeof 也是 "object"。
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const actual = observed[key] ?? 0;
      const range = value as RangeExpectation;
      if (range.min !== undefined && actual < range.min) {
        failures.push(`${key} 期望至少 ${range.min}，实际 ${actual}`);
      }
      if (range.max !== undefined && actual > range.max) {
        failures.push(`${key} 期望不超过 ${range.max}，实际 ${actual}`);
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
      continue;
    }
    if (key === "tools.outputContains") {
      for (const fragment of value as string[]) {
        if (!toolOutput.includes(fragment)) failures.push(`工具返回里应包含「${fragment}」`);
      }
      continue;
    }
    if (key === "tools.outputNotContains") {
      for (const fragment of value as string[]) {
        if (toolOutput.includes(fragment)) {
          failures.push(`工具返回里不应包含「${fragment}」（过期正文泄漏）`);
        }
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
  // 没有 sessions 时当成单会话；有就按顺序跑，共用同一个 store（跨会话记忆靠这个）
  const sessions: EvalSession[] = testCase.sessions?.length
    ? testCase.sessions
    : [{ goal: testCase.goal }];

  const texts: string[] = [];
  const allTools: string[] = [];
  const toolOutputs: string[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  let deniedCalls = 0;
  let blockedCalls = 0;
  let handoffs = 0;
  let toolErrors = 0;

  for (const sessionSpec of sessions) {
    const surveyMode = sessionSpec.survey ?? testCase.survey;
    const nowValue = sessionSpec.now ?? testCase.now;
    const insight = sessionSpec.insight ?? testCase.insight;
    const script = sessionSpec.script ?? testCase.script ?? [];

    let registration: ReturnType<typeof registerFauxProvider> | undefined;
    let model = opts.model;
    if (!model) {
      registration = registerFauxProvider({});
      registration.setResponses(toResponses(script));
      model = registration.getModel();
    }

    const result = await runSession({
      store,
      personId,
      goal: sessionSpec.goal,
      model,
      // 真模型跑到追问时不能给空答案：拿到空对象它会以为用户没回，然后重复追问。
      // 默认取每题第一个选项让对话继续；边界用例可用 `survey: "decline"` 拒绝补充，
      // 否则模拟用户会把"不存在的人"答成已存在的联系人，边界场景直接失效。
      survey: async (questions) =>
        Object.fromEntries(
          questions.map((q) => [
            q.id,
            surveyMode === "decline" ? "没有更多信息" : (q.options?.[0] ?? ""),
          ]),
        ),
      confirm: async () => true,
      review: async () => true,
      outbox,
      budget,
      now: nowValue ? new Date(nowValue) : DEFAULT_EVAL_NOW,
      insight: insight ? { model } : undefined,
    });

    registration?.unregister();

    const session = await store.getSession(result.sessionId);
    const sessionTools = toolsCalledFrom(session?.messages ?? []);
    allTools.push(...sessionTools);
    toolOutputs.push(toolOutputFrom(session?.messages ?? []));
    toolErrors += toolErrorsFrom(session?.messages ?? []);
    texts.push(result.text);
    totalTokens += result.usage.totalTokens;
    totalCost += result.usage.cost;
    deniedCalls += result.stats.deniedCalls;
    blockedCalls += result.stats.blockedCalls;
    handoffs += result.handoffs.length;
  }

  const cards = await store.listActions(personId);
  const candidates = await store.listCandidates(personId);
  const tools = allTools;

  const evidenceReads = tools.filter((t) => t === "get_evidence_text").length;
  const evidenceSearches = tools.filter((t) => t === "search_evidence").length;

  const observed: Record<string, number> = {
    "cards.total": cards.length,
    "cards.executed": cards.filter((c) => c.status === "executed").length,
    "cards.failed": cards.filter((c) => c.status === "failed").length,
    "candidates.approved": candidates.filter((c) => c.status === "approved").length,
    "candidates.rejected": candidates.filter((c) => c.status === "rejected").length,
    "memory.itemsDelta": (await store.getMemoryDoc(personId)).items.length - beforeItems,
    handoffs,
    "guard.blocked": blockedCalls,
    "tools.total": tools.length,
    "tools.errors": toolErrors,
    "tools.denied": deniedCalls,
    "tools.askUser": tools.filter((t) => t === "ask_user").length,
    "evidence.reads": evidenceReads,
    "evidence.searches": evidenceSearches,
    sessions: sessions.length,
  };

  const text = texts.join("\n\n---\n\n");
  const toolOutput = toolOutputs.join("\n");
  const failures = checkExpectations(
    usingRealModel ? mergeExpect(testCase.expect ?? {}, testCase.expectReal) : (testCase.expect ?? {}),
    observed,
    text,
    tools,
    toolOutput,
  );

  return {
    id: testCase.id,
    title: testCase.title,
    tags: testCase.tags,
    passed: failures.length === 0,
    failures,
    observed,
    text,
    tools,
    tokens: totalTokens,
    cost: totalCost,
    toolCalls: tools.length,
    toolErrors,
    durationMs: Date.now() - started,
  };
}