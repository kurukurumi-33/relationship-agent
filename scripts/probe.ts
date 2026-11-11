/**
 * 长上下文召回探针。
 *
 * 造一个 50 轮的会话：前 10 轮里埋 10 条事实，后 40 轮是无关闲聊。
 * 把上下文阈值压到 20 条，让早期事实必然被压缩掉，然后一次性问 10 个问题。
 *
 * 三个臂分开跑，才能说清楚"摘要"和"检索"各自值多少：
 *   A 截断：压缩后什么都不留（改造前的行为）
 *   B 截断 + 检索：原文可用 recall_history 找到
 *   C 摘要 + 检索：本次新做的完整方案
 *
 * 只用真实模型跑。脚本模型不会回答开放问题，测出来全是 0。
 *
 *   npm run probe
 *   npm run probe -- --rounds 50 --max-context 20
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { Store } from "../src/store/store.js";
import { seedState } from "../src/data/seed.js";
import { runSession } from "../src/session/run.js";
import { Outbox } from "../src/runtime/outbox.js";
import { MockDevice } from "../src/runtime/device.js";
import { loadEnv, resolveModel } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Probe {
  id: string;
  question: string;
  /** 任一关键词出现即算命中（词都做过去空格/小写归一） */
  expects: string[];
  /** 埋事实的那一轮对话 */
  statement: string;
  ack: string;
}

const PROBES: Probe[] = [
  {
    id: "birthday",
    question: "张三的生日是哪一天？",
    expects: ["3月14"],
    statement: "提醒我一下，张三的生日是 3 月 14 日。",
    ack: "记下了，张三的生日是 3 月 14 日。",
  },
  {
    id: "recheck",
    question: "张三下次复查在哪家医院、什么时间？",
    expects: ["北院区", "北院"],
    statement: "他 11 月 2 日上午九点要在医院北院区复查。",
    ack: "好的，11 月 2 日上午九点，北院区。",
  },
  {
    id: "allergy",
    question: "张三对什么药过敏？",
    expects: ["青霉素"],
    statement: "别忘了，他对青霉素过敏。",
    ack: "记住了，青霉素过敏。",
  },
  {
    id: "daughter",
    question: "张三的女儿小名叫什么？",
    expects: ["豆豆"],
    statement: "他女儿小名叫豆豆，今年六岁。",
    ack: "好的，豆豆，六岁。",
  },
  {
    id: "coffee",
    question: "张三喝咖啡有什么习惯？",
    expects: ["冰美式", "美式"],
    statement: "他喝咖啡只喝冰美式，不加糖。",
    ack: "明白，冰美式不加糖。",
  },
  {
    id: "flight",
    question: "张三下周去成都坐的是哪个航班？",
    expects: ["CA4301", "4301"],
    statement: "下周三他飞成都，航班号 CA4301。",
    ack: "记下了，CA4301。",
  },
  {
    id: "cat",
    question: "张三养的猫叫什么名字？",
    expects: ["年糕"],
    statement: "他家那只橘猫叫年糕。",
    ack: "记住了，年糕。",
  },
  {
    id: "mother",
    question: "张三的妈妈住在哪里？",
    expects: ["佛山"],
    statement: "他妈妈现在住在佛山禅城。",
    ack: "好的，佛山禅城。",
  },
  {
    id: "book",
    question: "张三说要还我哪本书？",
    expects: ["人类简史"],
    statement: "他上次说要把《人类简史》还我。",
    ack: "记下了，《人类简史》。",
  },
  {
    id: "quiet-hours",
    question: "张三说过什么时间之后不要联系他？",
    expects: ["十点", "10点", "22点", "22:00"],
    statement: "他说工作日的晚上十点以后别联系他。",
    ack: "好的，工作日晚十点后不打扰。",
  },
];

const FILLER: string[] = [
  "今天有点热，中午吃了碗面。",
  "地铁上人太多了，站了一路。",
  "刚开完一个会，脑子有点乱。",
  "周末打算在家躺着，哪都不去。",
  "楼下新开了家面包店，排队排很长。",
  "电脑又卡了，重装了个系统。",
  "昨晚追剧追到两点，今天好困。",
  "公司楼下在修路，绕了十分钟。",
  "中午外卖送错了，只好将就吃。",
  "刚洗完衣服，晾在阳台上。",
  "最近在学做饭，炒了个青菜。",
  "下班路上下了点小雨。",
  "手机屏幕摔裂了，还没去修。",
  "同事请了年假，活都堆我这儿了。",
  "早上闹钟没响，差点迟到。",
  "买了个新键盘，手感还不错。",
  "今天食堂的菜有点咸。",
  "晚上去跑了三公里，腿有点酸。",
  "把抽屉收拾了一遍，扔了一堆东西。",
  "咖啡机坏了，只能喝速溶。",
  "会议改到了下午三点。",
  "刚收到快递，是个台灯。",
  "楼上装修，一上午都在敲。",
  "中午没睡午觉，下午眼睛睁不开。",
  "把旧手机里的照片导出来了。",
  "今天的邮件特别多。",
  "打游戏输了一晚上。",
  "楼下有人遛狗，挺可爱。",
  "周末想去爬山，还没定。",
  "刚把冰箱里的菜清了一遍。",
  "看了一篇挺长的文章，没看完。",
  "今天的风好大。",
  "把数据线换了根新的。",
  "中午去银行排了半小时队。",
  "同事带了老家的特产过来。",
  "晚上煮了个汤，味道还行。",
  "下午茶点了杯奶茶。",
  "刚装了个新软件，还在摸索。",
  "这个月的账单出来了，比预想的多。",
  "把阳台的花搬回屋里了。",
];

function userMessage(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp } as AgentMessage;
}

function assistantMessage(content: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "probe",
    provider: "probe",
    model: "probe",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp,
  } as unknown as AgentMessage;
}

/**
 * 开头先放两轮寒暄，再埋事实。
 * 压缩规则会永久保留最早一条用户消息；如果事实就埋在那儿，
 * A 臂会白白答对一题，把"截断后什么都记不住"的结论冲淡。
 */
function buildArchive(rounds: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  let ts = 1_700_000_000_000;
  messages.push(userMessage("在吗？想跟你聊聊最近的事。", ts));
  messages.push(assistantMessage("在的，你说。", ts + 1));
  ts += 1000;
  for (let round = 0; round < rounds; round += 1) {
    const probe = PROBES[round];
    if (probe) {
      messages.push(userMessage(probe.statement, ts));
      messages.push(assistantMessage(probe.ack, ts + 1));
    } else {
      const filler = FILLER[(round - PROBES.length) % FILLER.length]!;
      messages.push(userMessage(filler, ts));
      messages.push(assistantMessage("嗯，我在。", ts + 1));
    }
    ts += 1000;
  }
  return messages;
}

const GOAL = [
  "（这是新的一轮对话，前面是之前聊过的内容）",
  "请回答下面 10 个问题，每题一行，格式「序号. 答案」。",
  "答案必须来自对话或工具结果；确实不知道就写「不知道」，不要猜。",
  "",
  ...PROBES.map((p, i) => `${i + 1}. ${p.question}`),
].join("\n");

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s，。、：:；;,.\-—_（）()《》"'“”‘’]/g, "");
}

function score(answer: string): boolean[] {
  const norm = normalize(answer);
  return PROBES.map((p) => p.expects.some((k) => norm.includes(normalize(k))));
}

interface ArmResult {
  label: string;
  hits: boolean[];
  recall: number;
  tools: string[];
  tokens: number;
  cost: number;
  durationMs: number;
  compacted: boolean;
  answer: string;
}

async function runArm(opts: {
  label: string;
  archive: AgentMessage[];
  model: Model<any>;
  maxContext: number;
  summarize: boolean;
  recall: boolean;
}): Promise<ArmResult> {
  const { label } = opts;
  const statePath = join(root, "data", `probe-${label}.db`);
  const ledgerPath = join(root, "data", `probe-${label}.jsonl`);
  await Store.reset(statePath);
  await rm(ledgerPath, { force: true });

  const store = await Store.open(statePath);
  await store.seedIfEmpty(seedState);
  const started = Date.now();

  const result = await runSession({
    store,
    personId: "p_001",
    goal: GOAL,
    model: opts.model,
    survey: async () => ({}),
    confirm: async () => false,
    review: async () => false,
    outbox: new Outbox(store, new MockDevice(ledgerPath)),
    resumeMessages: opts.archive,
    maxContextMessages: opts.maxContext,
    summarizeContext: opts.summarize ? { model: opts.model, minNewMessages: 1 } : undefined,
    disableTools: opts.recall
      ? ["ask_user", "propose_action", "propose_memory"]
      : ["ask_user", "propose_action", "propose_memory", "recall_history"],
  });

  const session = await store.getSession(result.sessionId);
  const toolNames = ((session?.messages ?? []) as Array<{ role: string; content?: unknown }>)
    .flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? m.content
            .filter((b): b is { type: string; name?: string } => (b as { type?: string }).type === "toolCall")
            .map((b) => b.name ?? "")
        : [],
    );
  const compaction = await store.getCompaction(result.sessionId);
  await store.close();

  // pi 把 API 失败记成带 errorMessage 的 assistant 消息，prompt 不抛错。
  // 不主动查的话，一次全 0 的结果会被误读成"摘要没用"。
  const failure = ((session?.messages ?? []) as Array<{ role?: string; errorMessage?: string }>)
    .find((m) => m.role === "assistant" && m.errorMessage)?.errorMessage;
  if (failure) throw new Error(`${label} 臂模型调用失败：${failure}`);

  const hits = score(result.text);
  return {
    label,
    hits,
    recall: hits.filter(Boolean).length,
    tools: toolNames,
    tokens: result.usage.totalTokens,
    cost: result.usage.cost,
    durationMs: Date.now() - started,
    compacted: Boolean(compaction && compaction.droppedMessages > 0),
    answer: result.text,
  };
}

async function main(): Promise<void> {
  const rounds = Number(arg("rounds") ?? 50);
  const maxContext = Number(arg("max-context") ?? 20);
  loadEnv();
  const model = resolveModel();
  console.log(`\n探针：${rounds} 轮会话，上下文上限 ${maxContext} 条，模型 ${model.name}\n`);

  const archive = buildArchive(rounds);
  const planted = Math.min(PROBES.length, rounds);
  console.log(`会话存档 ${archive.length} 条消息，前 ${planted} 轮埋了 ${planted} 条事实\n`);

  const arms: ArmResult[] = [];
  for (const spec of [
    { label: "A", summarize: false, recall: false },
    { label: "B", summarize: false, recall: true },
    { label: "C", summarize: true, recall: true },
  ]) {
    const result = await runArm({
      ...spec,
      archive,
      model,
      maxContext,
    });
    arms.push(result);
    console.log(`${spec.label} 臂完成：${result.recall}/${PROBES.length}`);
  }

  const labelOf: Record<string, string> = {
    A: "截断",
    B: "截断+检索",
    C: "摘要+检索",
  };

  console.log("\n逐题（✓ 命中 / ✗ 没答出）\n");
  console.log(`  ${"问题".padEnd(4)} ${"A".padEnd(3)} ${"B".padEnd(3)} ${"C".padEnd(3)}  期望关键词`);
  for (let i = 0; i < PROBES.length; i += 1) {
    const row = arms.map((a) => (a.hits[i] ? "✓" : "✗"));
    console.log(
      `  ${String(i + 1).padEnd(5)} ${row.map((r) => r.padEnd(4)).join("")} ${PROBES[i]!.expects[0]}`,
    );
  }

  console.log("\n" + "─".repeat(72));
  console.log(`  ${"臂".padEnd(12)} ${"召回".padEnd(8)} ${"工具调用".padEnd(10)} ${"tokens".padEnd(9)} ${"成本(元)".padEnd(10)} 压缩`);
  for (const a of arms) {
    console.log(
      `  ${labelOf[a.label]!.padEnd(12)} ${`${a.recall}/10`.padEnd(8)} ${String(a.tools.length).padEnd(10)} ${String(a.tokens).padEnd(9)} ${a.cost.toFixed(4).padEnd(10)} ${a.compacted ? "是" : "否"}`,
    );
  }
  const b = arms[1]!;
  const c = arms[2]!;
  console.log(
    `\n摘要带来的增量：B ${b.recall}/10 → C ${c.recall}/10（${c.recall - b.recall >= 0 ? "+" : ""}${c.recall - b.recall}）`,
  );
  console.log("注：C 臂生成摘要的那次模型调用已计入上表 tokens 和成本。");

  await mkdir(join(root, "evals"), { recursive: true });
  await writeFile(
    join(root, "evals", "probe.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: model.name,
        rounds,
        maxContext,
        probes: PROBES.map((p) => ({ id: p.id, question: p.question, expects: p.expects })),
        arms: arms.map((a) => ({
          arm: a.label,
          label: labelOf[a.label],
          recall: a.recall,
          hits: a.hits,
          tools: a.tools,
          tokens: a.tokens,
          cost: a.cost,
          durationMs: a.durationMs,
          compacted: a.compacted,
          answer: a.answer,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log("\n明细写到 evals/probe.json");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});