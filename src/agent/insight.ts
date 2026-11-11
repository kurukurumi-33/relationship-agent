import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Model } from "@mariozechner/pi-ai";
import type { FactConflict, MemoryCandidate, Receipt } from "../domain/types.js";
import type { Store } from "../store/store.js";
import { PermissionDeniedError } from "../errors.js";
import { withDeniedCount } from "./tools.js";
import { DEFAULT_BUDGET, RunGuard, type Budget } from "./guard.js";

export interface InsightOptions {
  model: Model<any>;
  budget?: Budget;
  onEvent?: (event: AgentEvent) => void;
}

export interface InsightResult {
  text: string;
  /** 本轮全部候选（含主 Agent 提的、洞察新建的），status/insightDecision 以 store 为准 */
  candidates: MemoryCandidate[];
  conflicts: FactConflict[];
  stats: { turns: number; toolCalls: number; blocked: number };
}

const INSIGHT_BUDGET: Budget = {
  ...DEFAULT_BUDGET,
  maxTurns: 6,
  maxToolCalls: 12,
  maxToolCallsPerTurn: 4,
  maxWallClockMs: 60_000,
};

const text = (value: unknown) => [
  { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
];

function renderTranscript(messages: AgentMessage[], limit = 14): string {
  const tail = messages.slice(-limit);
  return tail
    .map((m) => {
      const role = m.role;
      const content = (m as { content: unknown }).content;
      if (typeof content === "string") return `${role}: ${content.slice(0, 200)}`;
      if (!Array.isArray(content)) return `${role}:`;
      const parts = content.map((block) => {
        const b = block as { type: string; text?: string; name?: string };
        if (b.type === "text") return b.text ?? "";
        if (b.type === "toolCall") return `[调用 ${b.name}]`;
        return "";
      });
      return `${role}: ${parts.filter(Boolean).join(" ").slice(0, 200)}`;
    })
    .join("\n");
}

/**
 * 洞察 Agent：独立于主 Agent，专门决定"什么能进长期记忆"。
 *
 * 为什么拆开（面试常问）：主 Agent 面向交互，要灵活；这里要的是稳定的审核规则。
 * 拆开后主 Agent 的幻觉不会直接落进记忆库，而且可以单独给这一层做评测。
 */
export async function runInsight(opts: {
  store: Store;
  personId: string;
  sessionId: string;
  model: Model<any>;
  transcript: AgentMessage[];
  receipts: Receipt[];
  budget?: Budget;
  onEvent?: (event: AgentEvent) => void;
  /** 权限边界拦下一次调用时回调，由外层累计进会话统计 */
  onDenied?: () => void;
}): Promise<InsightResult> {
  const { store, personId, sessionId } = opts;
  const created: MemoryCandidate[] = [];
  const conflicts: FactConflict[] = [];

  const tools = [
    {
      name: "list_pending_candidates",
      label: "列出待审候选",
      description: "列出本会话产生、尚未裁决的记忆候选。",
      parameters: Type.Object({}),
      execute: async () => {
        const pending = (await store.listPendingCandidates(personId)).filter(
          (c) => !c.sessionId || c.sessionId === sessionId,
        );
        return {
          content: text(
            pending.map((c) => ({
              candidateId: c.candidateId,
              text: c.text,
              sourceIds: c.sourceIds,
              origin: c.origin,
            })),
          ),
          details: { count: pending.length },
        };
      },
    },
    {
      name: "get_evidence_text",
      label: "读取证据正文",
      description: "按 evidenceId 取证据正文，用来核实候选是否真有依据。",
      parameters: Type.Object({ evidenceId: Type.String() }),
      execute: async (_id: string, params: { evidenceId: string }) => {
        const ev = await store.getEvidence(params.evidenceId);
        if (ev.personId !== personId) throw new PermissionDeniedError("证据不属于当前联系人");
        return {
          content: text(store.isExpired(ev) ? (ev.summary ?? "原始材料已过期") : ev.content),
          details: {},
        };
      },
    },
    {
      name: "review_candidates",
      label: "裁决候选",
      description:
        "对本会话的候选记忆下裁决。candidateIds 用 [\"*\"] 表示全部待审。approve 才会进入用户审核。",
      executionMode: "sequential" as const,
      parameters: Type.Object({
        candidateIds: Type.Array(Type.String(), { minItems: 1 }),
        decision: Type.Union([Type.Literal("approve"), Type.Literal("reject")]),
        reason: Type.String({ description: "一句话说明依据或拒绝理由" }),
      }),
      execute: async (
        _id: string,
        params: { candidateIds: string[]; decision: "approve" | "reject"; reason: string },
      ) => {
        const targets = params.candidateIds.includes("*")
          ? (await store.listPendingCandidates(personId)).filter(
              (c) => !c.sessionId || c.sessionId === sessionId,
            )
          : await Promise.all(params.candidateIds.map((id) => store.getCandidate(id)));
        const done: string[] = [];
        for (const c of targets) {
          if (c.status !== "pending") continue;
          await store.setInsightDecision(c.candidateId, params.decision, params.reason);
          done.push(c.candidateId);
        }
        return { content: text({ reviewed: done.length }), details: { reviewed: done.length } };
      },
    },
    {
      name: "propose_memory",
      label: "提出记忆候选",
      description: "复盘后认为值得长期保留的稳定事实。必须附证据 sourceIds。",
      executionMode: "sequential" as const,
      parameters: Type.Object({
        text: Type.String(),
        sourceIds: Type.Array(Type.String(), { minItems: 1 }),
      }),
      execute: async (_id: string, params: { text: string; sourceIds: string[] }) => {
        const candidate = await store.createCandidate({
          personId,
          text: params.text,
          sourceIds: params.sourceIds,
          origin: "insight",
          sessionId,
        });
        created.push(candidate);
        await store.setInsightDecision(candidate.candidateId, "approve", "洞察 Agent 自提");
        return { content: text({ candidateId: candidate.candidateId }), details: {} };
      },
    },
    {
      name: "report_conflict",
      label: "登记事实冲突",
      description:
        "两条证据对同一事实说法不一致时登记冲突。冲突未解决前，不要把其中任何一条写进长期记忆。",
      executionMode: "sequential" as const,
      parameters: Type.Object({
        description: Type.String(),
        sourceIds: Type.Array(Type.String(), { minItems: 2 }),
      }),
      execute: async (_id: string, params: { description: string; sourceIds: string[] }) => {
        const conflict = await store.createConflict({
          personId,
          description: params.description,
          sourceIds: params.sourceIds,
        });
        conflicts.push(conflict);
        return { content: text({ conflictId: conflict.conflictId }), details: {} };
      },
    },
  ];

  const pending = (await store.listPendingCandidates(personId)).filter(
    (c) => !c.sessionId || c.sessionId === sessionId,
  );

  const systemPrompt = [
    "你是长期记忆的审核者，不是对话助手。你只做一件事：决定本轮哪些信息值得长期记住。",
    "",
    "规则（按优先级）：",
    "1. 只接受有证据支撑的稳定事实。sourceIds 必须指向真实证据，没有证据一律拒绝。",
    "2. 临时指令（今天、这次、帮我改一下）、模型猜测、未证实的动机，一律不进长期记忆。",
    "3. 与已确认记忆或已有证据冲突的说法，用 report_conflict 登记，不要直接写入。",
    "4. 对主 Agent 提的候选，用 list_pending_candidates 看一眼，再逐个 review_candidates 裁决。",
    "5. 你写的记忆要是一句话事实，不要写过程、不要写建议。",
    "",
    `本会话 ID: ${sessionId}`,
    `行动执行结果：${
      opts.receipts.length === 0
        ? "本轮没有行动卡"
        : opts.receipts
            .map((r) => `${r.requestId}=${r.status}${r.detail ? `(${r.detail})` : ""}`)
            .join("; ")
    }`,
    "",
    "本轮对话（最近若干条）：",
    renderTranscript(opts.transcript),
    "",
    pending.length > 0
      ? `当前待审候选 ${pending.length} 条，请务必裁决。`
      : "当前没有待审候选；如果对话里有值得记住的事实，可以自己 propose_memory。",
  ].join("\n");

  let agent: Agent;
  const guard = new RunGuard(opts.budget ?? INSIGHT_BUDGET, () => agent.abort());

  agent = new Agent({
    initialState: {
      systemPrompt,
      model: opts.model,
      tools: tools.map((t) => withDeniedCount(t as AgentTool<any>, opts.onDenied)) as never[],
      messages: [],
    },
    beforeToolCall: async (ctx) => guard.beforeToolCall({ toolCall: ctx.toolCall, args: ctx.args }),
    afterToolCall: async (ctx) => guard.afterToolCall({ isError: ctx.isError }),
    toolExecution: "sequential",
  });

  agent.subscribe((event) => {
    guard.observe(event);
    opts.onEvent?.(event);
  });

  guard.startClock();
  try {
    await agent.prompt("审核本轮记忆候选，并登记需要登记的事实冲突。");
  } finally {
    guard.stopClock();
  }

  const finalCandidates = (await store.listPendingCandidates(personId)).filter(
    (c) => !c.sessionId || c.sessionId === sessionId,
  );

  return {
    text: "",
    candidates: [...created, ...finalCandidates],
    conflicts,
    stats: {
      turns: guard.stats.turns,
      toolCalls: guard.stats.toolCalls,
      blocked: guard.stats.blockedCalls,
    },
  };
}