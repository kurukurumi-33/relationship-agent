/**
 * 前缀缓存实测：滑动窗口 vs 滞回式压缩。
 *
 * 两套策略跑同一段递增对话，每轮把当前上下文原样发给真模型，记录 input / cacheRead。
 * 不接工具、不做摘要调用（摘要内容固定），只隔离"保留窗口动不动"这一个变量。
 *
 *   npm run cache-probe
 *   npm run cache-probe -- --turns 30 --high 20 --low 12
 *
 * 判读：滑窗每次触发后窗口整体前移，可复用前缀只剩系统提示和开头几条；
 * 滞回压缩一次压到低水位，之后几轮只在末尾追加，整段上一次请求都能命中缓存。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { completeSimple, type Model } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { compactMessages, type SessionSummary } from "../src/session/summary.js";
import { loadEnv, resolveModel } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SYSTEM = "你是前缀缓存实验的陪练。只回复“收到”两个字，不要展开。";

// 单条消息就要有几百字，否则整个前缀够不到缓存的最小单元
const FILLER =
  "这是一段用来把前缀撑过缓存最小单元的填充文本，措辞和顺序在实验期间保持不变。".repeat(4);

// 固定的摘要内容：避免摘要重新生成本身成为前缀变化的变量
const FIXED_SUMMARY: SessionSummary = {
  facts: [{ text: "用户在做前缀缓存实验", evidenceIds: [] }],
  openThreads: [],
  coveredMessages: 0,
  generatedAt: "2026-11-11T00:00:00.000Z",
};

interface TurnStat {
  turn: number;
  messages: number;
  compacted: boolean;
  input: number;
  cacheRead: number;
  output: number;
}

interface PolicyResult {
  label: string;
  lowWater: number;
  compactions: number;
  input: number;
  cacheRead: number;
  turns: TurnStat[];
}

async function runPolicy(
  model: Model<any>,
  label: string,
  lowWater: number,
  turns: number,
  high: number,
): Promise<PolicyResult> {
  const history: AgentMessage[] = [];
  const stats: TurnStat[] = [];
  let compactions = 0;

  for (let t = 0; t < turns; t += 1) {
    history.push({
      role: "user",
      content: `第 ${t + 1} 轮。${FILLER}`,
      timestamp: Date.now(),
    } as AgentMessage);

    const compacted = await compactMessages(history, {
      maxMessages: high,
      lowWater,
      previous: FIXED_SUMMARY,
    });
    if (compacted.dropped > 0) compactions += 1;

    const response = (await completeSimple(model, {
      systemPrompt: SYSTEM,
      messages: compacted.messages,
    })) as unknown as AgentMessage & { errorMessage?: string; usage?: Record<string, number> };

    if (response.errorMessage) throw new Error(`${label} 策略模型调用失败：${response.errorMessage}`);

    const usage = response.usage ?? {};
    stats.push({
      turn: t + 1,
      messages: compacted.messages.length,
      compacted: compacted.dropped > 0,
      input: usage.input ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      output: usage.output ?? 0,
    });
    history.push(response);
  }

  return {
    label,
    lowWater,
    compactions,
    input: stats.reduce((s, x) => s + x.input, 0),
    cacheRead: stats.reduce((s, x) => s + x.cacheRead, 0),
    turns: stats,
  };
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const turns = Number(arg("turns") ?? 24);
  const high = Number(arg("high") ?? 20);
  const low = Number(arg("low") ?? Math.max(4, Math.floor(high * 0.6)));

  loadEnv();
  const model = resolveModel();
  console.log(`\n前缀缓存实验：${turns} 轮，高水位 ${high}，低水位 ${low}，模型 ${model.name}\n`);

  const policies: PolicyResult[] = [];
  for (const spec of [
    { label: "滑窗", lowWater: high },
    { label: "滞回", lowWater: low },
  ]) {
    console.log(`跑 ${spec.label}（低水位 ${spec.lowWater}）...`);
    policies.push(await runPolicy(model, spec.label, spec.lowWater, turns, high));
  }

  for (const p of policies) {
    console.log(`\n${p.label} 逐轮`);
    console.log("  轮  消息数  压缩  input  cacheRead");
    for (const t of p.turns) {
      console.log(
        `  ${String(t.turn).padStart(2)}  ${String(t.messages).padStart(5)}  ${
          t.compacted ? "是" : "  "
        }  ${String(t.input).padStart(5)}  ${String(t.cacheRead).padStart(9)}`,
      );
    }
  }

  console.log("\n汇总");
  console.log("  策略  压缩次数  prompt tokens  cacheRead  命中率");
  for (const p of policies) {
    const prompt = p.input + p.cacheRead;
    console.log(
      `  ${p.label}  ${String(p.compactions).padStart(6)}  ${String(prompt).padStart(13)}  ${String(
        p.cacheRead,
      ).padStart(9)}  ${pct(p.cacheRead, prompt)}`,
    );
  }

  const sliding = policies[0]!;
  const hysteretic = policies[1]!;
  const slidingPrompt = sliding.input + sliding.cacheRead;
  const hystereticPrompt = hysteretic.input + hysteretic.cacheRead;
  console.log(
    `\n滞回相比滑窗：压缩 ${sliding.compactions} → ${hysteretic.compactions} 次，prompt tokens ${slidingPrompt} → ${hystereticPrompt}，` +
      `命中率 ${pct(sliding.cacheRead, slidingPrompt)} → ${pct(hysteretic.cacheRead, hystereticPrompt)}`,
  );

  await mkdir(join(root, "evals"), { recursive: true });
  await writeFile(
    join(root, "evals", "cache-probe.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), model: model.name, turns, high, low, policies },
      null,
      2,
    ),
  );
  console.log("\n明细写到 evals/cache-probe.json");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});