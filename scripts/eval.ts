/**
 * 评测中心（轻量版）。
 *
 *   npm run eval                       # 脚本化模型，跑全部用例，和基线比
 *   npm run eval -- --tag boundary     # 只跑某一类
 *   npm run eval -- --update-baseline  # 确认改进后更新基线
 *   npm run eval -- --real             # 真实模型，按量计费，不参与基线对比
 *   npm run eval -- --real --limit 2   # 先花几分钱试两条
 *
 * 和"跑一遍看看"的区别：有数据集、有分维度指标、有基线、有回归判定。
 *
 * 两种模式的数字不能混着讲：
 *   脚本模式测的是"系统各层是否按设计协作"，模型行为是写死的，跑一万遍也一样；
 *   真模型模式测的才是"模型会不会越界、会不会追问、提案能不能落地"。
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { EvalCase, CaseResult } from "../src/eval/case.js";
import { runCase } from "../src/eval/runner.js";
import { loadEnv, resolveModel } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const casesDir = join(root, "evals", "cases");
const baselinePath = join(root, "evals", "baseline.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

/** 期望值的有效下限：数字原样，区间取 min，null / 缺省算 0。 */
function lowerBound(value: unknown): number {
  if (typeof value === "number") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const min = (value as { min?: unknown }).min;
    return typeof min === "number" ? min : 0;
  }
  return 0;
}

/** 当前模式下真正生效的期望：真模型下 expectReal 覆盖 expect，null 表示删掉这一条。 */
function effectiveExpect(c: EvalCase, real: boolean): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(c.expect ?? {}) };
  if (real && c.expectReal) {
    for (const [key, value] of Object.entries(c.expectReal)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
  }
  return merged;
}

async function loadCases(): Promise<EvalCase[]> {
  const files = (await readdir(casesDir)).filter((f) => f.endsWith(".json")).sort();
  const cases: EvalCase[] = [];
  for (const file of files) {
    const raw = await readFile(join(casesDir, file), "utf8");
    cases.push(JSON.parse(raw) as EvalCase);
  }
  return cases;
}

interface Baseline {
  generatedAt: string;
  passRate: number;
  cases: Record<string, boolean>;
}

function pad(text: string, width: number): string {
  // 中文字符占两格，简单按显示宽度补齐
  const w = [...text].reduce((n, ch) => n + (/[一-龥]/.test(ch) ? 2 : 1), 0);
  return text + " ".repeat(Math.max(0, width - w));
}

async function main(): Promise<void> {
  const tag = arg("tag");
  const real = hasFlag("real");
  const limit = Number(arg("limit") ?? 0);
  // 子集运行（--tag / --limit）不能覆盖完整报告，否则跑一次试水就把上一轮全量明细冲掉了
  const scoped = Boolean(tag) || limit > 0;
  const outName = `${real ? "report-real" : "report"}${scoped ? ".partial" : ""}`;

  let cases = await loadCases();
  if (tag) cases = cases.filter((c) => c.tags.includes(tag));

  // 有些用例的期望依赖"模型按剧本犯错"，真模型不会配合，跑了只会得到假失败
  const skipped = real ? cases.filter((c) => c.realModel === false) : [];
  if (real) cases = cases.filter((c) => c.realModel !== false);
  if (limit > 0) cases = cases.slice(0, limit);

  if (cases.length === 0) {
    console.log("没有匹配的用例");
    return;
  }

  let model: Model<any> | undefined;
  if (real) {
    loadEnv();
    model = resolveModel();
    console.log(`\n真实模型: ${model.name}（会真的调用 API，按量计费）`);
    if (skipped.length > 0) {
      console.log(`跳过 ${skipped.length} 条只对脚本模型成立的用例: ${skipped.map((c) => c.id).join(", ")}`);
    }
  }

  const results: CaseResult[] = [];
  console.log("\n评测运行中…\n");
  for (const c of cases) {
    const result = await runCase(c, { rootDir: root, model });
    results.push(result);
    const mark = result.passed ? "✓" : "✗";
    console.log(
      `${mark} ${pad(c.id, 26)} ${pad(c.tags.join(","), 20)} ${String(result.tokens).padStart(6)} tok  ${result.durationMs}ms`,
    );
    for (const failure of result.failures) console.log(`    ↳ ${failure}`);
  }

  // ---- 指标 ----
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const passRate = passed / total;

  const tags = [...new Set(results.flatMap((r) => r.tags))].sort();
  const byTag = Object.fromEntries(
    tags.map((t) => {
      const subset = results.filter((r) => r.tags.includes(t));
      return [t, { total: subset.length, passed: subset.filter((r) => r.passed).length }];
    }),
  );

  const avgTokens = Math.round(results.reduce((n, r) => n + r.tokens, 0) / total);
  const avgDuration = Math.round(results.reduce((n, r) => n + r.durationMs, 0) / total);
  const avgToolCalls = (results.reduce((n, r) => n + r.toolCalls, 0) / total).toFixed(1);
  const totalToolErrors = results.reduce((n, r) => n + r.toolErrors, 0);
  const totalBlocked = results.reduce((n, r) => n + (r.observed["guard.blocked"] ?? 0), 0);
  const totalCost = results.reduce((n, r) => n + r.cost, 0);
  const totalEvidenceReads = results.reduce((n, r) => n + (r.observed["evidence.reads"] ?? 0), 0);
  const totalEvidenceSearches = results.reduce(
    (n, r) => n + (r.observed["evidence.searches"] ?? 0),
    0,
  );

  // 任务完成率：只统计"期望产生真实副作用"的用例（有卡被执行 / 有记忆写入）。
  // 按当前模式合并 expect/expectReal 后再判断，否则真模型下被放宽的用例会被算错。
  const isTaskCase = (c: EvalCase) => {
    const expect = effectiveExpect(c, real);
    return lowerBound(expect["cards.executed"]) >= 1 || lowerBound(expect["memory.itemsDelta"]) >= 1;
  };
  const taskIds = cases.filter(isTaskCase).map((c) => c.id);
  const taskResults = results.filter((r) => taskIds.includes(r.id));
  const taskCompletion =
    taskResults.length === 0 ? 1 : taskResults.filter((r) => r.passed).length / taskResults.length;

  console.log("\n" + "─".repeat(72));
  console.log("【结果】");
  console.log(`  通过率      ${passed}/${total} = ${(passRate * 100).toFixed(1)}%`);
  console.log(
    `  任务完成率  ${taskResults.filter((r) => r.passed).length}/${taskResults.length} = ${(taskCompletion * 100).toFixed(1)}%  （只算期望有真实副作用的用例）`,
  );
  console.log(`  分维度      ${tags.map((t) => `${t} ${byTag[t]!.passed}/${byTag[t]!.total}`).join("  ")}`);

  console.log("【轨迹】");
  console.log(`  平均工具调用 ${avgToolCalls} 次/用例`);
  console.log(`  工具报错     ${totalToolErrors} 次`);
  console.log(`  护栏拦截     ${totalBlocked} 次`);
  console.log(`  证据读取     ${totalEvidenceReads} 次读取 / ${totalEvidenceSearches} 次检索`);

  console.log("【代价】");
  console.log(`  平均用量     ${avgTokens} tokens/用例（合计 ${results.reduce((n, r) => n + r.tokens, 0)}）`);
  console.log(`  平均耗时     ${avgDuration}ms/用例`);
  console.log(`  总成本       ${totalCost.toFixed(4)}`);

  if (real) {
    const askUser = results.reduce((n, r) => n + (r.observed["tools.askUser"] ?? 0), 0);
    const cardsProposed = results.reduce((n, r) => n + (r.observed["cards.total"] ?? 0), 0);
    const cardsExecuted = results.reduce((n, r) => n + (r.observed["cards.executed"] ?? 0), 0);
    const boundary = results.filter((r) => r.tags.includes("boundary"));
    const boundaryPassed = boundary.filter((r) => r.passed).length;
    const denied = results.reduce((n, r) => n + (r.observed["tools.denied"] ?? 0), 0);
    const totalCalls = results.reduce((n, r) => n + (r.observed["tools.total"] ?? 0), 0);
    console.log("【真模型】");
    console.log(
      boundary.length === 0
        ? "  边界用例     本轮没跑"
        : `  边界用例     ${boundaryPassed}/${boundary.length} 通过（失败 ${boundary.length - boundaryPassed} 条，原因看报告）`,
    );
    // 越界率不能用"边界用例失败数"算：边界用例会因很多原因失败，
    // 而它挂掉也不等于模型越了界。真正的越界信号是权限校验拒掉了多少次调用。
    console.log(`  越界尝试     ${denied} 次（被权限校验拒绝），共 ${totalCalls} 次工具调用`);
    console.log(`  追问次数     ${askUser}`);
    console.log(`  行动卡       ${cardsProposed} 张，执行成功 ${cardsExecuted} 张`);
    // 依据使用率：建过卡的用例里，有多少查过证据。只能算"查没查"，
    // 算不了"查到的证据是否真的支撑那张卡"（那是语义评测的事）。
    const cardCases = results.filter((r) => (r.observed["cards.total"] ?? 0) > 0);
    const groundedCases = cardCases.filter(
      (r) => (r.observed["evidence.reads"] ?? 0) > 0 || (r.observed["evidence.searches"] ?? 0) > 0,
    );
    console.log(
      cardCases.length === 0
        ? "  依据使用率   本轮没有建卡用例"
        : `  依据使用率   ${groundedCases.length}/${cardCases.length}（建卡前查过证据的用例占比）`,
    );
  }

  // ---- 基线对比 ----
  let baseline: Baseline | undefined;
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Baseline;
  } catch {
    baseline = undefined;
  }

  let regression: string[] = [];
  if (real) {
    // 真模型两次调用之间本来就不会完全一致，拿它跟脚本基线比没有意义。
    // 要比就跟"上一次真模型跑出来的报告"比，人工看。
    console.log(`\n基线: 真模型不参与脚本基线对比（报告写在 evals/${outName}.json）`);
  } else if (!baseline) {
    console.log("\n基线: 尚未建立（用 --update-baseline 建立）");
  } else if (!tag) {
    for (const r of results) {
      const was = baseline.cases[r.id];
      if (was === true && !r.passed) regression.push(r.id);
    }
    console.log(
      regression.length === 0
        ? `\n基线: 无回归（${Object.keys(baseline.cases).length} 条基线用例）`
        : `\n基线: 回归 ${regression.length} 项 → ${regression.join(", ")}`,
    );
    const delta = ((passRate - baseline.passRate) * 100).toFixed(1);
    console.log(`通过率变化: ${delta.startsWith("-") ? "" : "+"}${delta} 个百分点`);
  }

  // ---- 写报告 ----
  // 子集运行（--tag / --limit）不能覆盖完整报告，否则跑一次试水就把上一轮全量明细冲掉了
  const outPath = join(root, "evals", `${outName}.json`);
  const outMdPath = join(root, "evals", `${outName}.md`);
  await mkdir(join(root, "evals"), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: real ? "real" : "script",
        model: model?.name,
        total,
        passed,
        passRate,
        taskCompletion,
        byTag,
        avgTokens,
        avgDuration,
        avgToolCalls: Number(avgToolCalls),
        totalToolErrors,
        totalBlocked,
        totalEvidenceReads,
        totalEvidenceSearches,
        totalCost,
        regression,
        results,
      },
      null,
      2,
    ),
    "utf8",
  );

  const md = [
    "# 评测报告",
    "",
    `模式：**${real ? `真实模型 ${model?.name}` : "脚本化模型"}**`,
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    `总分：**${passed}/${total} = ${(passRate * 100).toFixed(1)}%**`,
    "",
    `任务完成率：**${(taskCompletion * 100).toFixed(1)}%**（只算期望有真实副作用的用例）`,
    "",
    "## 结果",
    "",
    "| 维度 | 通过 |",
    "|---|---|",
    ...tags.map((t) => `| ${t} | ${byTag[t]!.passed}/${byTag[t]!.total} |`),
    "",
    "## 轨迹",
    "",
    `平均工具调用 ${avgToolCalls} 次/用例，工具报错 ${totalToolErrors} 次，护栏拦截 ${totalBlocked} 次，证据读取 ${totalEvidenceReads} 次 / 检索 ${totalEvidenceSearches} 次。`,
    "",
    "## 代价",
    "",
    `平均 ${avgTokens} tokens / ${avgDuration}ms 每用例，总成本 ${totalCost.toFixed(4)}。`,
    "",
    "| 用例 | 结果 | tokens | 耗时 |",
    "|---|---|---|---|",
    ...results.map(
      (r) => `| ${r.id} | ${r.passed ? "✅" : "❌"} | ${r.tokens} | ${r.durationMs}ms |`,
    ),
    "",
    regression.length > 0 ? `**回归：${regression.join(", ")}**` : "无回归。",
    "",
  ].join("\n");
  await writeFile(outMdPath, md, "utf8");

  if (scoped) {
    console.log(`\n本次只跑了 ${total} 条子集，报告写到 evals/${outName}.json，完整报告未被覆盖`);
  }

  if (hasFlag("update-baseline")) {
    // 真模型的结果本来就抖，写成基线会让以后每次脚本跑都报"回归"
    if (real) throw new Error("真实模型的结果不能当基线，基线只属于脚本模式");
    // 子集跑出来的基线只含这几条，另存的用例会被整份覆盖掉
    if (scoped) throw new Error("子集运行不能更新基线，请跑全量 npm run eval -- --update-baseline");
    const next: Baseline = {
      generatedAt: new Date().toISOString(),
      passRate,
      cases: Object.fromEntries(results.map((r) => [r.id, r.passed])),
    };
    await writeFile(baselinePath, JSON.stringify(next, null, 2), "utf8");
    console.log("\n基线已更新");
  }

  if (regression.length > 0 || passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});