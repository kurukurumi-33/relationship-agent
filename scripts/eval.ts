/**
 * 评测中心（轻量版）。
 *
 *   npm run eval                     # 跑全部用例，和基线比
 *   npm run eval -- --tag boundary   # 只跑某一类
 *   npm run eval -- --update-baseline # 确认改进后更新基线
 *
 * 和"跑一遍看看"的区别：有数据集、有分维度指标、有基线、有回归判定。
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { EvalCase, CaseResult } from "../src/eval/case.js";
import { runCase } from "../src/eval/runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const casesDir = join(root, "evals", "cases");
const baselinePath = join(root, "evals", "baseline.json");
const reportPath = join(root, "evals", "report.json");
const reportMdPath = join(root, "evals", "report.md");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

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
  let cases = await loadCases();
  if (tag) cases = cases.filter((c) => c.tags.includes(tag));

  if (cases.length === 0) {
    console.log("没有匹配的用例");
    return;
  }

  const results: CaseResult[] = [];
  console.log("\n评测运行中…\n");
  for (const c of cases) {
    const result = await runCase(c, { rootDir: root });
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

  // 任务完成率：只统计"期望产生真实副作用"的用例（有卡被执行 / 有记忆写入）
  const taskIds = cases
    .filter(
      (c) =>
        (c.expect?.["cards.executed"] ?? 0) >= 1 || (c.expect?.["memory.itemsDelta"] ?? 0) >= 1,
    )
    .map((c) => c.id);
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

  console.log("【代价】");
  console.log(`  平均用量     ${avgTokens} tokens/用例（合计 ${results.reduce((n, r) => n + r.tokens, 0)}）`);
  console.log(`  平均耗时     ${avgDuration}ms/用例`);
  console.log(`  总成本       ${totalCost.toFixed(4)}`);

  // ---- 基线对比 ----
  let baseline: Baseline | undefined;
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Baseline;
  } catch {
    baseline = undefined;
  }

  let regression: string[] = [];
  if (!baseline) {
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
  await mkdir(join(root, "evals"), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
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
    `平均工具调用 ${avgToolCalls} 次/用例，工具报错 ${totalToolErrors} 次，护栏拦截 ${totalBlocked} 次。`,
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
  await writeFile(reportMdPath, md, "utf8");

  if (hasFlag("update-baseline")) {
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