import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { ActionCard, MemoryCandidate, PageContext, Receipt } from "../domain/types.js";
import type { Store } from "../store/store.js";
import { GenerationConflictError } from "../store/store.js";
import { buildMemorySnapshot } from "../agent/snapshot.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import { createTools, type SurveyHandler } from "../agent/tools.js";
import { DEFAULT_BUDGET, RunGuard, type Budget, type GuardStats } from "../agent/guard.js";
import { checkToolRules } from "../agent/rules.js";
import type { ConfirmHandler, ReviewHandler } from "../runtime/survey.js";
import type { Outbox } from "../runtime/outbox.js";
import { makeContextPruner, repairToolPairing } from "./resume.js";
import { runInsight, type InsightOptions } from "../agent/insight.js";

export interface RunSessionOptions {
  store: Store;
  personId: string;
  goal: string;
  model: Model<any>;
  survey: SurveyHandler;
  confirm: ConfirmHandler;
  review: ReviewHandler;
  outbox: Outbox;
  budget?: Budget;
  sessionId?: string;
  /** 请求级幂等键：同一个 requestID 重放不会产生第二次执行 */
  requestId?: string;
  /** 页面上下文：让"帮我改一下"这类指代有落点 */
  pageContext?: PageContext;
  /** 断点续跑：传入上次持久化的消息（内部会先修 toolCall/toolResult 配对） */
  resumeMessages?: AgentMessage[];
  /** 会话压缩阈值（消息条数）；0 或未设置表示不压缩 */
  maxContextMessages?: number;
  /** 洞察 Agent：提供后，候选记忆必须先过它这一关才能到用户面前 */
  insight?: InsightOptions;
  /**
   * 异步确认：提议阶段结束后不动行动卡，确认留给日后的 CLI / 接口。
   * 动作和记忆分开开关，因为两者的审核人可能不是同一个人。
   */
  deferConfirm?: boolean;
  deferReview?: boolean;
  onEvent?: (event: AgentEvent) => void;
}

export interface RunResult {
  sessionId: string;
  text: string;
  proposedCards: ActionCard[];
  finalCards: ActionCard[];
  receipts: Receipt[];
  candidates: MemoryCandidate[];
  appliedMemories: string[];
  stats: GuardStats;
  repairedOnResume: number;
  /** true 表示这次是同一个 requestID 的重放，没有真的跑模型 */
  replayed: boolean;
  /** 洞察 Agent 的审核摘要（仅在启用了 insight 时存在） */
  insight?: {
    reviewed: number;
    rejected: number;
    conflicts: number;
    stats: { turns: number; toolCalls: number; blocked: number };
  };
  /** 本次会话的模型用量（来自 assistant 消息上的 usage） */
  usage: SessionUsage;
  /** 需要人工接管的原因（护栏中断、设备失败等） */
  handoffs: string[];
}

export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export function sumUsage(messages: AgentMessage[]): SessionUsage {
  const total: SessionUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const usage = (m as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } }).usage;
    if (!usage) continue;
    total.input += usage.input ?? 0;
    total.output += usage.output ?? 0;
    total.cacheRead += usage.cacheRead ?? 0;
    total.cacheWrite += usage.cacheWrite ?? 0;
    total.totalTokens += usage.totalTokens ?? 0;
    total.cost += usage.cost?.total ?? 0;
  }
  return total;
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const content = (m as { content: Array<{ type: string; text?: string }> }).content;
    return content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * 一次会话的完整宿主侧编排。
 *
 *   MemorySnapshot 装配 → 模型循环（只读工具 + 追问 + 提案）
 *     → 用户确认 → Outbox 提交 → 设备回执 → 候选记忆审核 → generation CAS 写入
 *
 * 模型负责"说什么"，这里负责"能不能做"。两者之间只通过 ActionCard / MemoryCandidate 交接。
 */
export async function runSession(opts: RunSessionOptions): Promise<RunResult> {
  const { store, personId } = opts;

  // ---- 请求级幂等：同一个 requestID 重放直接回放上次结果 ----
  if (opts.requestId) {
    const previous = await store.getSessionByRequest(opts.requestId);
    if (previous) {
      const messages = repairToolPairing(previous.messages as AgentMessage[]).messages;
      const previousActions = await store.listActions(personId);
      return {
        sessionId: previous.sessionId,
        text: lastAssistantText(messages),
        proposedCards: [],
        finalCards: previousActions.filter((a) => a.status === "executed"),
        receipts: previousActions
          .map((a) => a.receipt)
          .filter((r): r is Receipt => Boolean(r)),
        candidates: [],
        appliedMemories: [],
        stats: { turns: 0, toolCalls: 0, blockedCalls: 0, failedToolCalls: 0 },
        repairedOnResume: 0,
        replayed: true,
        insight: undefined,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
        handoffs: [],
      };
    }
  }

  const sessionId = opts.sessionId ?? store.newSessionId();
  const budget = opts.budget ?? DEFAULT_BUDGET;

  const snapshot = await buildMemorySnapshot(store, personId);
  // 快照本身也是一次"读取"：谁在哪个会话里拿到了这个人的全部索引，要留痕
  await store.logAccess({
    sessionId,
    personId,
    kind: "snapshot",
    actor: "host",
  });
  const proposedCards: ActionCard[] = [];
  const candidates: MemoryCandidate[] = [];

  let agent: Agent;
  const guard = new RunGuard(budget, () => agent.abort());

  const tools = createTools({
    store,
    personId,
    sessionId,
    survey: opts.survey,
    onProposedAction: (card) => proposedCards.push(card),
    onProposedMemory: (candidate) => candidates.push(candidate),
  });

  let repairedOnResume = 0;
  let messages: AgentMessage[] = [];
  if (opts.resumeMessages?.length) {
    const repaired = repairToolPairing(opts.resumeMessages);
    messages = repaired.messages;
    repairedOnResume = repaired.repaired;
  }

  // 会话在开跑前就落库：跑到一半崩了，至少能看到跑到哪一步
  const now = new Date().toISOString();
  await store.saveSession({
    sessionId,
    personId,
    requestId: opts.requestId,
    pageContext: opts.pageContext,
    messages,
    createdAt: now,
    updatedAt: now,
  });

  const prune =
    opts.maxContextMessages && opts.maxContextMessages > 0
      ? makeContextPruner(opts.maxContextMessages)
      : undefined;

  agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(snapshot),
      model: opts.model,
      tools,
      messages,
    },
    beforeToolCall: async (ctx) => {
      const blocked = guard.beforeToolCall({ toolCall: ctx.toolCall, args: ctx.args });
      if (blocked?.block) return blocked;

      // 预算过了再看参数。拦下的原因会作为 isError 的 tool_result 回到模型，
      // 带上规则名是为了能按规则统计拦截率，不写进给模型看的主句里。
      const violation = checkToolRules(ctx.toolCall.name, ctx.args);
      if (!violation) return undefined;
      guard.recordBlock();
      return { block: true, reason: `${violation.reason}（规则 ${violation.rule}）` };
    },
    afterToolCall: async (ctx) => guard.afterToolCall({ isError: ctx.isError }),
    // 压缩：切割点落在 user 消息前，压缩本身也记账（带 generation CAS）
    transformContext: prune
      ? async (msgs) => {
          const before = msgs.length;
          const pruned = await prune(msgs);
          if (pruned.length < before) {
            const generation = (await store.getCompaction(sessionId))?.generation ?? 0;
            try {
              await store.recordCompaction(sessionId, generation, {
                droppedMessages: before - pruned.length,
                keptMessages: pruned.length,
                at: new Date().toISOString(),
              });
            } catch (err) {
              // 压缩账本冲突不应阻断对话，但要留痕
              opts.onEvent?.({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: `[compaction-conflict] ${(err as Error).message}`,
                    },
                  ],
                  api: "internal",
                  provider: "internal",
                  model: "internal",
                  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
                  stopReason: "stop",
                  timestamp: Date.now(),
                },
              } as AgentEvent);
            }
          }
          return pruned;
        }
      : undefined,
    // 工具按顺序执行：行动卡/记忆候选都是写提案，并行没有收益，还会让日志难读
    toolExecution: "sequential",
  });

  agent.subscribe(async (event) => {
    guard.observe(event);
    opts.onEvent?.(event);
    // 每条消息落一次盘：中断恢复的前提是"崩之前的东西已经在盘上"
    if (event.type === "message_end") {
      await store.appendSessionMessages(sessionId, agent.state.messages);
    }
  });

  guard.startClock();
  try {
    await agent.prompt(opts.goal);
  } finally {
    guard.stopClock();
  }

  // 会话消息最终再做一次配对自检后落盘
  const persisted = repairToolPairing(agent.state.messages);
  await store.appendSessionMessages(sessionId, persisted.messages);

  // ---- 提案 → 确认 → 提交 → 回执 ----
  const receipts: Receipt[] = [];
  const finalCards: ActionCard[] = [];
  for (const card of proposedCards) {
    if (opts.deferConfirm) {
      // 确认与执行拆到别的进程：这里只把库里的事实原样带回去
      finalCards.push(await store.getAction(card.requestId));
      continue;
    }
    const approved = await opts.confirm(card);
    if (!approved) {
      const rejected = await store.updateAction(card.requestId, card.cardVersion, {
        status: "rejected",
      });
      finalCards.push(rejected);
      continue;
    }

    const confirmed = await store.updateAction(card.requestId, card.cardVersion, {
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
    });
    const result = await opts.outbox.submit(confirmed);
    receipts.push(result.receipt);
    finalCards.push(result.card);
  }

  // ---- 需要人工接管的场景：卡住了要说出来，不能让用户只看到"服务出错" ----
  const handoffReasons: string[] = [];
  if (guard.stats.exceededReason) {
    const handoff = await store.createHandoff({
      sessionId,
      personId,
      reason: "guard-exceeded",
      detail: guard.stats.exceededReason,
    });
    handoffReasons.push(`护栏中断：${handoff.detail}`);
  }
  for (const receipt of receipts) {
    if (receipt.status === "failed") {
      const handoff = await store.createHandoff({
        sessionId,
        personId,
        reason: "device-failed",
        detail: `${receipt.requestId}: ${receipt.detail ?? ""}`,
      });
      handoffReasons.push(`设备失败：${handoff.detail}`);
    }
  }

  // ---- 洞察审核（独立 Agent）→ 用户审核 → CAS 写入 ----
  let reviewable: MemoryCandidate[] = candidates;
  let insightSummary: RunResult["insight"];

  if (opts.insight) {
    const insight = await runInsight({
      store,
      personId,
      sessionId,
      model: opts.insight.model,
      transcript: agent.state.messages,
      receipts,
      budget: opts.insight.budget,
      onEvent: opts.insight.onEvent,
    });
    const merged = new Map<string, MemoryCandidate>();
    for (const c of [...candidates, ...insight.candidates]) merged.set(c.candidateId, c);
    reviewable = [...merged.values()];
    insightSummary = {
      reviewed: reviewable.length,
      rejected: 0,
      conflicts: insight.conflicts.length,
      stats: insight.stats,
    };
  }

  const appliedMemories: string[] = [];
  for (const candidate of reviewable) {
    const fresh = await store.getCandidate(candidate.candidateId);

    // 洞察 Agent 没有放行的，直接落 rejected，不打扰用户
    if (opts.insight && fresh.insightDecision !== "approve") {
      await store.reviewCandidate(
        fresh.candidateId,
        "rejected",
        fresh.insightReason ?? "洞察 Agent 未通过",
      );
      if (insightSummary) insightSummary.rejected += 1;
      continue;
    }

    if (opts.deferReview) continue;

    const approved = await opts.review(fresh);
    if (!approved) {
      await store.reviewCandidate(fresh.candidateId, "rejected", "用户在审核时拒绝");
      continue;
    }
    // 写记忆 + 标记通过，放在同一个事务里（store.commitCandidate）。
    // 分两步做，无论谁先谁后，都会在某一步失败时留下半截状态。
    appliedMemories.push(await applyCandidate(store, fresh));
  }

  const finalCandidates = await Promise.all(
    candidates.map((c) => store.getCandidate(c.candidateId)),
  );

  return {
    sessionId,
    text: lastAssistantText(agent.state.messages),
    proposedCards,
    finalCards,
    receipts,
    candidates: finalCandidates,
    appliedMemories,
    stats: guard.stats,
    repairedOnResume,
    replayed: false,
    insight: insightSummary,
    usage: sumUsage(agent.state.messages),
    handoffs: handoffReasons,
  };
}

/** 带 generation CAS 的记忆写入；冲突时重读一次再试，仍冲突就抛给调用方。 */
async function applyCandidate(store: Store, candidate: MemoryCandidate): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const doc = await store.getMemoryDoc(candidate.personId);
    try {
      // 一个事务里完成：CAS 写记忆 + 标记候选 approved
      await store.commitCandidate(candidate.candidateId, doc.generation);
      return candidate.text;
    } catch (err) {
      if (!(err instanceof GenerationConflictError) || attempt === 1) throw err;
    }
  }
  throw new Error("unreachable");
}