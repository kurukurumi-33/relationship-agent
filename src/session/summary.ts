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

function renderTranscript(messages: AgentMessage[]): string {
  const lines: string[] = [];
  let budget = MAX_TRANSCRIPT_CHARS;
  for (const message of messages) {
    const body = textOf(message).trim();
    if (!body) continue;
    const who =
      message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : "工具结果";
    const clipped = body.length > MAX_MESSAGE_CHARS ? `${body.slice(0, MAX_MESSAGE_CHARS)}…` : body;
    const line = `${who}：${clipped}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

const SUMMARY_SYSTEM_PROMPT = [
  "你是会话压缩器，不是对话助手。",
  "把给定的对话片段压成结构化事实，只保留对话里明确说过的内容。",
  "不要推断、不要补充常识、不要把建议写成事实。",
  "只输出一个 JSON 对象，不要代码块以外的任何文字。",
].join("\n");

function buildSummaryPrompt(previous: SessionSummary | undefined, messages: AgentMessage[]): string {
  const parts: string[] = [];
  if (previous && previous.facts.length > 0) {
    parts.push(
      "已有摘要（请合并，不要重复条目）：",
      JSON.stringify({ facts: previous.facts, openThreads: previous.openThreads }, null, 2),
    );
  }
  parts.push(
    "新增对话片段：",
    renderTranscript(messages) || "（空）",
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

/**
 * 生成新摘要。模型调用或解析失败都返回 undefined，让上层退回"只截断"，
 * 因为压缩失败不该把整轮对话弄挂。
 */
export async function summarizeDropped(
  model: Model<any>,
  previous: SessionSummary | undefined,
  messages: AgentMessage[],
): Promise<SessionSummary | undefined> {
  if (messages.length === 0) return previous;
  try {
    const response = await completeSimple(model, {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildSummaryPrompt(previous, messages), timestamp: Date.now() }],
    });
    const raw = textOf(response as unknown as AgentMessage);
    const json = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = parseSummary(json);
    if (!parsed) return undefined;
    return { ...parsed, coveredMessages: 0, generatedAt: new Date().toISOString() };
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
 * 摘要不是每轮都重做：新裁掉的消息少于 minNewMessages 就先沿用旧摘要，
 * 否则一到阈值就会每轮调一次模型，费用和延迟都不划算。
 */
export async function compactMessages(
  messages: AgentMessage[],
  opts: {
    maxMessages: number;
    model?: Model<any>;
    minNewMessages?: number;
    previous?: SessionSummary;
  },
): Promise<CompactResult> {
  if (messages.length <= opts.maxMessages) return { messages, dropped: 0, summary: opts.previous };

  let summary = opts.previous;
  // 固定占两条：保留的第一条用户消息，以及一条摘要/截断说明
  const reserve = 2;
  let cut = messages.length - Math.max(opts.maxMessages - reserve, 1);
  while (cut < messages.length && messages[cut]?.role !== "user") cut += 1;
  if (cut >= messages.length || cut <= 1) return { messages, dropped: 0, summary };

  const newlyDropped = messages.slice(1, cut);
  if (opts.model) {
    const covered = summary?.coveredMessages ?? 1;
    const fresh = cut - covered;
    const threshold = opts.minNewMessages ?? 8;
    if (fresh > 0 && (fresh >= threshold || !summary)) {
      const next = await summarizeDropped(opts.model, summary, newlyDropped);
      // 失败就沿用旧摘要：宁可少覆盖一点，也不要因为一次 400 把压缩记录写坏
      if (next) summary = { ...next, coveredMessages: cut };
    }
  }

  const head = messages[0]!;
  const kept = messages.slice(cut);
  const out = summary
    ? [head, summaryMessage(summary, true), ...kept]
    : [head, truncationMessage(messages.length - kept.length - 1), ...kept];

  return { messages: out, dropped: messages.length - out.length, summary };
}