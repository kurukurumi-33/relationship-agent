/**
 * Judge 校准：把 LLM Judge 的分数和人打的分放在一起比。
 *
 *   npm run judge -- --report --llm --out evals/judge-scores.json
 *   npm run calibrate -- --init        # 生成待人工打分的模板
 *   npm run calibrate                  # 算相关性
 *
 * 为什么需要这一步：judge 本身也是模型，没有人工基准时它的分数不是真值。
 * 相关系数低说明 rubric 写得模糊或者 judge 模型不适合这个任务，
 * 这时候把分数写进简历只会被追问"你怎么知道它准"。
 *
 * 样本量提醒：少于 10 条时相关系数的置信区间很宽，只能当参考；
 * 20~30 条才有资格说"这个 judge 大致可用"。
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { meanAbsoluteError, pearson, spearman } from "../src/eval/stats.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const DIMENSIONS = ["groundedness", "executionHonesty", "relevance"] as const;
type Dimension = (typeof DIMENSIONS)[number];

interface ScoreFile {
  judge?: string;
  model?: string | null;
  rubric?: string;
  scores: Record<string, Record<Dimension, number>>;
}

interface LabelFile {
  rubric?: string;
  scoredBy?: string;
  labels: Record<string, Partial<Record<Dimension, number | null>>>;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function resolvePath(value: string | undefined, fallback: string): string {
  if (!value || value.startsWith("--")) return join(root, fallback);
  return isAbsolute(value) ? value : join(root, value);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** 皮尔逊、秩、斯皮尔曼都在 src/eval/stats.ts，单独抽出来是为了能用假数据测。 */
function fmt(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

async function initLabels(labelsPath: string, scorePath: string): Promise<void> {
  let existing: LabelFile | undefined;
  try {
    existing = await readJson<LabelFile>(labelsPath);
  } catch {
    existing = undefined;
  }
  if (existing) {
    console.log(`${labelsPath} 已存在，不覆盖。要重来请先删掉它。`);
    return;
  }
  const scores = await readJson<ScoreFile>(scorePath);
  const template: LabelFile = {
    rubric: scores.rubric ?? "v1",
    scoredBy: "",
    labels: Object.fromEntries(
      Object.keys(scores.scores).map((id) => [id, { groundedness: null, executionHonesty: null, relevance: null }]),
    ),
  };
  await writeFile(labelsPath, JSON.stringify(template, null, 2), "utf8");
  console.log(`已生成 ${labelsPath}，共 ${Object.keys(template.labels).length} 条。`);
  console.log("每条按 0~1 打分（可以只填你在意的维度），填完再跑 npm run calibrate。");
}

async function main(): Promise<void> {
  const scorePath = resolvePath(arg("scores"), "evals/judge-scores.json");
  const labelsPath = resolvePath(arg("labels"), "evals/judge-labels.json");

  if (hasFlag("init")) {
    await initLabels(labelsPath, scorePath);
    return;
  }

  let scores: ScoreFile;
  let labels: LabelFile;
  try {
    scores = await readJson<ScoreFile>(scorePath);
    labels = await readJson<LabelFile>(labelsPath);
  } catch (err) {
    console.error(`读不到分数或人工标注：${(err as Error).message}`);
    console.error(`先跑 npm run judge -- --report --llm --out evals/judge-scores.json，再 npm run calibrate -- --init`);
    process.exitCode = 1;
    return;
  }

  console.log(`\njudge: ${scores.judge ?? "未知"}  模型: ${scores.model ?? "未知"}  rubric: ${scores.rubric ?? "未知"}`);
  console.log(`人工标注: ${labels.scoredBy || "未署名"}  rubric: ${labels.rubric ?? "未知"}\n`);

  let usable = 0;
  for (const dim of DIMENSIONS) {
    const judgeScores: number[] = [];
    const humanScores: number[] = [];
    for (const [id, human] of Object.entries(labels.labels)) {
      const judge = scores.scores[id]?.[dim];
      const value = human?.[dim];
      if (typeof judge !== "number" || typeof value !== "number") continue;
      judgeScores.push(judge);
      humanScores.push(value);
    }
    usable = Math.max(usable, judgeScores.length);
    const r = pearson(judgeScores, humanScores);
    const rho = spearman(judgeScores, humanScores);
    const bias =
      judgeScores.length === 0
        ? null
        : judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length -
          humanScores.reduce((a, b) => a + b, 0) / humanScores.length;
    console.log(
      `${dim.padEnd(18)} n=${String(judgeScores.length).padStart(2)}  ` +
        `pearson=${fmt(r)}  spearman=${fmt(rho)}  MAE=${fmt(meanAbsoluteError(judgeScores, humanScores))}  ` +
        `偏差(judge-人)=${fmt(bias, 3)}`,
    );
  }

  console.log("");
  if (usable < 10) {
    console.log(`只有 ${usable} 条同时有 judge 分和人工分，样本太少，相关系数只能当参考。`);
  }
  console.log("判读：");
  console.log("  spearman >= 0.7 且 MAE <= 0.15：judge 可以用来排优先级，但仍不能当绝对质量。");
  console.log("  0.4 ~ 0.7：只能看方向，别把单条分数写进结论。");
  console.log("  < 0.4 或 MAE > 0.25：先改 rubric，别改 prompt 硬凑。");
  console.log("  偏差为正说明 judge 系统性偏松，为负说明偏严；偏差比相关性更容易修，调 rubric 的阈值说明即可。");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});