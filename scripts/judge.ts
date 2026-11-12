/**
 * 语义评测的入口（第 3 层）。
 *
 *   npm run judge -- --session sess_xxx              # 规则 Judge，看单个会话
 *   npm run judge -- --report                       # 规则 Judge，扫最近一次真模型报告
 *   npm run judge -- --report --llm                 # 真模型 Judge，按 rubric 打语义分
 *   npm run judge -- --report --llm --limit 3       # 先试三条，控制成本
 *
 * 规则 Judge 只核对"引用是否真实存在""有没有谎称执行"，零成本、完全可复现。
 * LLM Judge 才判断"证据是否支持结论""有没有答到点上"，会花钱，也会抖。
 * 两种分数不能混着讲。
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { completeSimple } from "@mariozechner/pi-ai";
import { Store } from "../src/store/store.js";
import {
  createLlmJudge,
  createRuleJudge,
  type Judge,
  type JudgeInput,
} from "../src/eval/judge.js";
import { loadEnv, resolveModel } from "../src/config.js";
import type { EvalCase } from "../src/eval/case.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function completeWithModel(prompt: string): Promise<string> {
  const model = resolveModel();
  const response = await completeSimple(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { temperature: 0, maxTokens: 800 },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(`Judge 模型调用失败：${response.errorMessage ?? response.stopReason}`);
  }
  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!text.trim()) throw new Error("Judge 模型没有返回文字");
  return text;
}

function pickJudge(): Judge {
  if (!hasFlag("llm")) return createRuleJudge();
  const model = resolveModel();
  return createLlmJudge({
    modelId: model.id,
    rubricVersion: "v1",
    complete: completeWithModel,
  });
}

function printVerdict(
  label: string,
  verdict: Awaited<ReturnType<Judge["judge"]>>,
): void {
  console.log(
    `  ${label.padEnd(26)} groundedness=${verdict.groundedness.toFixed(2)}` +
      `  honesty=${verdict.executionHonesty.toFixed(2)}` +
      `  relevance=${verdict.relevance.toFixed(2)}`,
  );
  for (const note of verdict.notes.slice(0, 3)) console.log(`    · ${note}`);
}

async function loadCases(): Promise<Map<string, EvalCase>> {
  const dir = join(root, "evals", "cases");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const map = new Map<string, EvalCase>();
  for (const file of files) {
    const parsed = JSON.parse(await readFile(join(dir, file), "utf8")) as EvalCase;
    map.set(parsed.id, parsed);
  }
  return map;
}

interface ReportResult {
  id: string;
  title: string;
  text: string;
}

async function judgeReport(): Promise<void> {
  // `--report` 可以单独出现，也可以带路径；下一个参数是另一个 flag 时按无路径处理。
  const reportArgRaw = arg("report");
  const reportArg =
    reportArgRaw && !reportArgRaw.startsWith("--") ? reportArgRaw : undefined;
  const reportPath =
    reportArg === undefined
      ? join(root, "evals", "report-real.json")
      : isAbsolute(reportArg)
        ? reportArg
        : join(root, reportArg);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    model?: string;
    results: ReportResult[];
  };
  const cases = await loadCases();
  const judge = pickJudge();
  const limit = Number(arg("limit") ?? report.results.length);
  const results = report.results.slice(0, limit);

  console.log(`\n[judge: ${judge.name}] report=${reportPath}`);
  console.log(`  模型: ${report.model ?? "脚本模型"}  用例: ${results.length}`);
  console.log("");

  const sums = { groundedness: 0, executionHonesty: 0, relevance: 0 };
  const scores: Record<string, Awaited<ReturnType<Judge["judge"]>>> = {};
  let judged = 0;
  for (const result of results) {
    const testCase = cases.get(result.id);
    if (!testCase) {
      console.log(`  ${result.id} 找不到对应用例，跳过`);
      continue;
    }
    const store = await Store.open(join(root, "data", "eval", `${result.id}.db`));
    const personId = testCase.personId ?? "p_001";
    const input: JudgeInput = {
      goal: testCase.goal,
      answer: result.text,
      evidence: (await store.listEvidence(personId)).map((e) => ({
        evidenceId: e.evidenceId,
        title: e.title,
      })),
      cards: await store.listActions(personId),
    };
    const verdict = await judge.judge(input);
    sums.groundedness += verdict.groundedness;
    sums.executionHonesty += verdict.executionHonesty;
    sums.relevance += verdict.relevance;
    scores[result.id] = verdict;
    judged += 1;
    printVerdict(result.id, verdict);
  }

  const n = Math.max(1, judged);
  console.log("");
  console.log(
    `  平均 groundedness=${(sums.groundedness / n).toFixed(2)}` +
      `  honesty=${(sums.executionHonesty / n).toFixed(2)}` +
      `  relevance=${(sums.relevance / n).toFixed(2)}`,
  );
  console.log("\n注：LLM Judge 的分数会随模型和 rubric 变化，只能和同一 rubric 的其他轮次比。");

  const outArg = arg("out");
  if (outArg && !outArg.startsWith("--")) {
    const outPath = isAbsolute(outArg) ? outArg : join(root, outArg);
    await writeFile(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          judge: judge.name,
          model: report.model ?? null,
          rubric: "v1",
          scores,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`分数已写入 ${outPath}（用 npm run calibrate 和人工打分比相关性）`);
  }
}

async function judgeSession(sessionId: string): Promise<void> {
  const store = await Store.open(arg("store") ?? join(root, "data", "state.db"));
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`会话 ${sessionId} 不存在`);

  const messages = session.messages as Array<{
    role: string;
    content: Array<{ type: string; text?: string }>;
  }>;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const answer = (lastAssistant?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

  const evidence = (await store.listEvidence(session.personId)).map((e) => ({
    evidenceId: e.evidenceId,
    title: e.title,
  }));

  const goalMessage = messages.find((m) => m.role === "user") as
    | { content: Array<{ type: string; text?: string }> }
    | undefined;
  const goal = (goalMessage?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

  const judge = pickJudge();
  const verdict = await judge.judge({
    goal,
    answer,
    evidence,
    cards: await store.listActions(session.personId),
  });

  console.log(`\n[judge: ${judge.name}] session=${sessionId}`);
  console.log(`  目标: ${goal.slice(0, 60)}`);
  printVerdict("verdict", verdict);
}

async function main(): Promise<void> {
  loadEnv();
  const sessionId = arg("session");
  if (hasFlag("report")) {
    await judgeReport();
    return;
  }
  if (!sessionId) {
    console.log("用法:");
    console.log("  npm run judge -- --session sess_xxx");
    console.log("  npm run judge -- --report [--llm] [--limit 3]");
    return;
  }
  await judgeSession(sessionId);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});