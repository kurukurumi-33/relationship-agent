/**
 * 会话压缩：把被裁掉的那段对话变成结构化摘要，而不是直接丢。
 *
 * 两条路分开：
 *   - 摘要（这里）：稳定事实、结论、未结事项，常驻上下文，代价是每轮都在；
 *   - 原文（recall_history 工具）：完整消息留在库里，模型需要细节时按关键词取回。
 *
 * 只做摘要不保留原文，压缩一次早期信息就永久失联；只保留原文不做摘要，
 * 模型根本不知道该去查什么。两件一起做才叫"长上下文召回"。
 */
import { completeSimple, type Model } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface SummaryFact {
  text: string;
  evidenceIds: string[];
}

export interface SessionSummary {
  facts: SummaryFact[];
  openThreads: string[];
  /** 已覆盖到第几条原始消息（不含）；用来判断这次要不要重新摘要 */
  coveredMessages: number;
  generatedAt: string;
}

export interface CompactResult {
  messages: AgentMessage[];
  dropped: number;
  summary?: SessionSummary;
  /** 本次压缩里生成摘要消耗的用量；没调模型就是 undefined */
  usage?: SummaryUsage;
}

/** 与主循环的 SessionUsage 字段一致；单独定义是为了不反向依赖 run.ts。 */
export interface SummaryUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface SummarizeResult {
  /** 解析失败时没有 summary，但模型调用可能已经花钱了，所以 usage 要单独带回来 */
  summary?: SessionSummary;
  /** 真正喂进摘要器的消息条数（含中途跳过的空消息） */
  consumed: number;
  usage?: SummaryUsage;
}

/** 事实条数上限：摘要本身也会膨胀，超过这个数就不是摘要了 */
const MAX_FACTS = 40;
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 600;

export function parseSummary(raw: string | undefined | null): SessionSummary | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionSummary>;
    if (!Array.isArray(parsed.facts)) return undefined;
    return {
      facts: parsed.facts
        .filter((f): f is SummaryFact => Boolean(f) && typeof f.text === "string")
        .map((f) => ({
          text: f.text,
          evidenceIds: Array.isArray(f.evidenceIds)
            ? f.evidenceIds.filter((id): id is string => typeof id === "string")
            : [],
        }))
        .slice(0, MAX_FACTS),
      openThreads: Array.isArray(parsed.openThreads)
        ? parsed.openThreads.filter((t): t is string => typeof t === "string")
        : [],
      coveredMessages: Number(parsed.coveredMessages ?? 0),
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    };
  } catch {
    return undefined;
  }
}

function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => {
      const block = b as { type?: string; text?: unknown };
      return block.type === "text" && typeof block.text === "string";
    })
    .map((b) => b.text)
    .join("\n");
}

/**
 * 渲染给摘要器的对话文本，同时回报吃掉了多少条消息。
 *
 * 字符预算用完就停，但调用方必须知道停在哪，否则 coveredMessages 会虚报覆盖范围，
 * 后面的消息既没进摘要，也没人再去处理。
 */
function renderTranscript(messages: AgentMessage[]): { text: string; consumed: number } {
  const lines: string[] = [];
  let budget = MAX_TRANSCRIPT_CHARS;
  let consumed = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const body = textOf(messages[i]!).trim();
    if (!body) {
      consumed = i + 1;
      continue;
    }
    const who =
      messages[i]!.role === "user" ? "用户" : messages[i]!.role === "assistant" ? "助手" : "工具结果";
    const clipped = body.length > MAX_MESSAGE_CHARS ? `${body.slice(0, MAX_MESSAGE_CHARS)}…` : body;
    const line = `${who}：${clipped}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
    consumed = i + 1;
  }
  return { text: lines.join("\n"), consumed };
}

const SUMMARY_SYSTEM_PROMPT = [
  "你是会话压缩器，不是对话助手。",
  "把给定的对话片段压成结构化事实，只保留对话里明确说过的内容。",
  "不要推断、不要补充常识、不要把建议写成事实。",
  "只输出一个 JSON 对象，不要代码块以外的任何文字。",
].join("\n");

function buildSummaryPrompt(previous: SessionSummary | undefined, transcript: string): string {
  const parts: string[] = [];
  if (previous && previous.facts.length > 0) {
    parts.push(
      "已有摘要（请合并，不要重复条目）：",
      JSON.stringify({ facts: previous.facts, openThreads: previous.openThreads }, null, 2),
    );
  }
  parts.push(
    "新增对话片段：",
    transcript || "（空）",
    "",
    "输出格式：",
    '{"facts":[{"text":"一句话事实","evidenceIds":["ev_001"]}],"openThreads":["尚未解决、后续还要跟进的事"]}',
    "",
    "要求：",
    `1. facts 最多 ${MAX_FACTS} 条，合并重复；只写稳定信息（人物、日期、约定、偏好、已做的决定）。`,
    "2. evidenceIds 只填对话里真实出现过的 evidenceId；没有就写空数组，不要编。",
    "3. 临时口令（今天、这次先这样）进 openThreads，不要进 facts。",
    "4. 没有值得记的内容就返回空数组，不要凑数。",
  );
  return parts.join("\n");
}

type RawUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
};

function usageOf(response: unknown): SummaryUsage | undefined {
  const usage = (response as { usage?: RawUsage }).usage;
  if (!usage) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cost: usage.cost?.total ?? 0,
  };
}

/**
 * 生成新摘要。模型调用或解析失败都不抛错，让上层退回旧摘要或只截断，
 * 因为压缩失败不该把整轮对话弄挂。
 *
 * consumed 是实际喂进摘要器的消息条数：字符预算用完时会小于传入长度，
 * 调用方据此推进 coveredMessages，下次从这里接着摘，避免重复处理整个中段。
 */
export async function summarizeDropped(
  model: Model<any>,
  previous: SessionSummary | undefined,
  messages: AgentMessage[],
): Promise<SummarizeResult | undefined> {
  if (messages.length === 0) return previous ? { summary: previous, consumed: 0 } : undefined;
  try {
    const rendered = renderTranscript(messages);
    const response = await completeSimple(model, {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildSummaryPrompt(previous, rendered.text),
          timestamp: Date.now(),
        },
      ],
    });
    const usage = usageOf(response);
    const raw = textOf(response as unknown as AgentMessage);
    const json = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = parseSummary(json);
    if (!parsed) return { consumed: 0, usage };
    return {
      summary: { ...parsed, coveredMessages: 0, generatedAt: new Date().toISOString() },
      consumed: rendered.consumed,
      usage,
    };
  } catch {
    return undefined;
  }
}

export function summaryMessage(summary: SessionSummary, proofOfArchive: boolean): AgentMessage {
  const lines = [
    "[会话摘要] 系统压缩上下文时生成，内容只来自此前对话，不是新指令。",
    ...summary.facts.map(
      (f) => `- 事实：${f.text}${f.evidenceIds.length > 0 ? `（来源 ${f.evidenceIds.join("、")}）` : ""}`,
    ),
    ...(summary.openThreads.length > 0
      ? ["未结事项：", ...summary.openThreads.map((t) => `- ${t}`)]
      : []),
    proofOfArchive ? "早期对话原文仍在存档里，需要细节时调用 recall_history 按关键词检索。" : "",
  ].filter(Boolean);
  return { role: "user", content: lines.join("\n"), timestamp: Date.now() } as AgentMessage;
}

function truncationMessage(dropped: number): AgentMessage {
  return {
    role: "user",
    content: `[会话压缩] 更早的 ${dropped} 条对话已被移出上下文，原文仍在存档里，需要时用 recall_history 检索。`,
    timestamp: Date.now(),
  } as AgentMessage;
}

/**
 * 按消息条数压缩，并在有条件时生成摘要。
 *
 * 用滞回而不是每轮滑窗：超过 maxMessages（高水位）才触发，一次压到 lowWater（低水位）。
 * 两次压缩之间上下文只在末尾追加，前缀不动，prompt cache 能连续命中；
 * 每轮都切回高水位的旧做法会让保留窗口整体前移，摘要之后的前缀每轮都变，缓存全失效。
 *
 * 摘要不是每轮都重做：新裁掉的消息少于 minNewMessages 就先沿用旧摘要，
 * 否则一到阈值就会每轮调一次模型，费用和延迟都不划算。
 */
export async function compactMessages(
  messages: AgentMessage[],
  opts: {
    /** 高水位：超过才触发压缩 */
    maxMessages: number;
    /** 低水位：触发后压到这个长度附近；默认高水位的 60%，传 maxMessages 等于旧版滑窗 */
    lowWater?: number;
    model?: Model<any>;
    minNewMessages?: number;
    previous?: SessionSummary;
  },
): Promise<CompactResult> {
  if (messages.length <= opts.maxMessages) return { messages, dropped: 0, summary: opts.previous };

  let summary = opts.previous;
  // 固定占两条：保留的第一条用户消息，以及一条摘要/截断说明
  const reserve = 2;
  const low = Math.min(
    opts.lowWater ?? Math.max(4, Math.floor(opts.maxMessages * 0.6)),
    opts.maxMessages,
  );
  let cut = messages.length - Math.max(low - reserve, 1);
  while (cut < messages.length && messages[cut]?.role !== "user") cut += 1;
  if (cut >= messages.length || cut <= 1) return { messages, dropped: 0, summary };

  // 只把"还没进摘要"的那段交给模型。用 slice(1, cut) 会把整个中段反复摘一遍，
  // 会话越长越贵，还容易撞上字符预算，导致最近的掉出消息反而没被覆盖。
  const start = Math.max(summary?.coveredMessages ?? 1, 1);
  const fresh = cut - start;
  const threshold = opts.minNewMessages ?? 8;
  let usage: SummaryUsage | undefined;
  if (opts.model && fresh > 0 && (fresh >= threshold || !summary)) {
    const result = await summarizeDropped(opts.model, summary, messages.slice(start, cut));
    if (result) {
      usage = result.usage;
      // 解析失败时 consumed 为 0，coveredMessages 不前进，下次会重试这一段
      if (result.summary) {
        summary = { ...result.summary, coveredMessages: start + result.consumed };
      }
    }
  }

  const head = messages[0]!;
  const kept = messages.slice(cut);
  const out = summary
    ? [head, summaryMessage(summary, true), ...kept]
    : [head, truncationMessage(messages.length - kept.length - 1), ...kept];

  return { messages: out, dropped: messages.length - out.length, summary, usage };
}