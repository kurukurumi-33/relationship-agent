import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ActionCard, ActionKind, MemoryCandidate, SurveyQuestion } from "../domain/types.js";
import type { Store } from "../store/store.js";
import { ingestEvidence } from "../ingest/evidence.js";
import { PermissionDeniedError } from "../errors.js";

export type { SurveyQuestion };

/** 问卷回答：由 host 提供（CLI 读 stdin，demo 用脚本答案）。 */
export type SurveyHandler = (questions: SurveyQuestion[]) => Promise<Record<string, string>>;

export interface ToolContext {
  store: Store;
  /** 会话绑定的联系人：工具不接受 personId 参数，从根上禁止跨人读取。 */
  personId: string;
  /** 会话 ID：问卷等需要持久化的东西都挂在会话上 */
  sessionId: string;
  survey: SurveyHandler;
  /** 提案回调：host 用它收集本轮产生的行动卡/候选记忆，用于后续确认。 */
  onProposedAction: (card: ActionCard) => void;
  onProposedMemory: (candidate: MemoryCandidate) => void;
  /** 权限边界拦下一次调用时回调，host 用它统计越界尝试 */
  onDenied?: () => void;
  /**
   * 会话的"当前时间"锚点。过期判断用它，评测才能测"刚好在保留期内"。
   * 缺省用真实时间，线上行为不变。
   */
  now?: Date;
}

const text = (value: unknown) => [
  { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
];

const ACTION_KINDS: ActionKind[] = ["reminder", "calendar_event", "draft_message"];

/**
 * 在工具执行处统计越界，而不是事后翻 tool_result 的文案。
 *
 * pi 会把异常转成只有文字的 isError 结果，类型信息到不了外层；
 * 但工具是我们自己写的，在抛出的地方按 instanceof 数最靠得住。
 */
export function withDeniedCount<T extends AgentTool<any>>(tool: T, onDenied?: () => void): T {
  if (!onDenied) return tool;
  const execute = tool.execute as (...args: any[]) => Promise<unknown>;
  return {
    ...tool,
    execute: async (...args: any[]) => {
      try {
        return await execute(...args);
      } catch (err) {
        if (err instanceof PermissionDeniedError) onDenied();
        throw err;
      }
    },
  } as T;
}

const EvidenceTextParams = Type.Object({
  evidenceId: Type.String({ description: "快照里给出的 evidenceId" }),
});

const SearchParams = Type.Object({
  query: Type.String({ description: "关键词，例如 生日、会议、工作" }),
});

const AskParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      id: Type.String({ description: "简短英文/数字标识，用于回填答案" }),
      question: Type.String(),
      options: Type.Array(Type.String()),
    }),
    { minItems: 1, maxItems: 3 },
  ),
});

const ProposeActionParams = Type.Object({
  kind: Type.Union(ACTION_KINDS.map((k) => Type.Literal(k))),
  title: Type.String({ description: "一句话说清楚要做什么" }),
  payload: Type.Record(Type.String(), Type.Any(), {
    description: "动作参数，例如 {at: '2026-11-02T10:00:00+08:00', text: '...'}",
  }),
  reason: Type.String({ description: "为什么建议这么做，给用户看" }),
  sourceIds: Type.Array(Type.String(), { minItems: 1 }),
});

const ProposeMemoryParams = Type.Object({
  text: Type.String({ description: "一句话事实，例如 他有过敏性鼻炎，别约火锅" }),
  sourceIds: Type.Array(Type.String(), { minItems: 1 }),
});

const RecallParams = Type.Object({
  query: Type.String({
    description: "要回忆的线索关键词，多个词用空格分隔，例如 复查 医院；多关键词时会为每个词各取一条",
  }),
  limit: Type.Optional(
    Type.Number({ description: "最多返回几条；单关键词默认 3，多关键词按词数增加，上限 8" }),
  ),
});

/** 从一条消息里抽纯文本：工具结果也参与检索，否则"我上次让你查的东西"就断了。 */
function messageText(message: unknown): string {
  const m = message as { content?: unknown };
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter((b): b is { type: "text"; text: string } => {
      const block = b as { type?: string; text?: unknown };
      return block.type === "text" && typeof block.text === "string";
    })
    .map((b) => b.text)
    .join("\n");
}

/** 命中位置前后各取一段，避免把整条长消息塞回上下文。 */
function excerptAround(text: string, keyword: string): string {
  const at = text.indexOf(keyword);
  if (text.length <= 240) return text;
  const start = Math.max(0, at - 120);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 240)}…`;
}

/**
 * 工具分三类，边界写在类型上：
 *   - 只读：只能返回内容，无法改 store；
 *   - 追问：只能问，不写；
 *   - 提案：写 store 里"待确认"的提案对象，但改不了任何已确认状态。
 * 真正的写入动作在 src/runtime/outbox.ts 和 src/session/run.ts，工具层拿不到那些 API。
 */
export function createTools(ctx: ToolContext): AgentTool<any>[] {
  const getEvidenceText: AgentTool<typeof EvidenceTextParams> = {
    name: "get_evidence_text",
    label: "读取证据正文",
    description:
      "按 evidenceId 取一条证据的完整正文（聊天记录、日历、笔记）。只能取当前联系人的证据。",
    parameters: EvidenceTextParams,
    execute: async (_toolCallId, params) => {
      const ev = await ctx.store.getEvidence(params.evidenceId);
      if (ev.personId !== ctx.personId) {
        throw new PermissionDeniedError(`证据 ${params.evidenceId} 不属于当前联系人，拒绝跨人读取`);
      }
      if ((ev.status ?? "active") !== "active") {
        throw new Error(`证据 ${params.evidenceId} 尚未通过人工确认，暂时不可读`);
      }
      await ctx.store.logAccess({
        sessionId: ctx.sessionId,
        personId: ctx.personId,
        kind: "read",
        evidenceId: ev.evidenceId,
        actor: "agent",
      });
      // 过了保留期只给摘要。TTL 的承诺是"正文不再进上下文"，只挡快照挡不住按 ID 直接读。
      if (ctx.store.isExpired(ev, ctx.now)) {
        return {
          content: text({
            evidenceId: ev.evidenceId,
            kind: ev.kind,
            capturedAt: ev.capturedAt,
            title: ev.title,
            sourceRef: ev.sourceRef,
            expired: true,
            content: ev.summary ?? "（原始材料已过期，无摘要）",
            note: "原始材料已过保留期，正文不可读，以上是入库时生成的摘要",
          }),
          details: { evidenceId: ev.evidenceId, expired: true },
        };
      }
      return {
        content: text({
          evidenceId: ev.evidenceId,
          kind: ev.kind,
          capturedAt: ev.capturedAt,
          title: ev.title,
          sourceRef: ev.sourceRef,
          content: ev.content,
        }),
        details: { evidenceId: ev.evidenceId },
      };
    },
  };

  const searchEvidence: AgentTool<typeof SearchParams> = {
    name: "search_evidence",
    label: "检索证据",
    description: "在当前联系人的证据里按关键词检索，返回命中的 evidenceId、标题和片段。",
    parameters: SearchParams,
    execute: async (_toolCallId, params) => {
      const hits = (await ctx.store.searchEvidence(ctx.personId, params.query)).slice(0, 10);
      await ctx.store.logAccess({
        sessionId: ctx.sessionId,
        personId: ctx.personId,
        kind: "search",
        query: params.query,
        actor: "agent",
      });
      return {
        content: text({
          query: params.query,
          count: hits.length,
          hits: hits.map((e) => {
            const expired = ctx.store.isExpired(e, ctx.now);
            return {
              evidenceId: e.evidenceId,
              kind: e.kind,
              capturedAt: e.capturedAt,
              title: e.title,
              expired,
              // 过期证据的正文不能从检索结果里漏出去，片段也换成摘要
              snippet: expired ? (e.summary ?? "（原始材料已过期，无摘要）") : e.content.slice(0, 160),
            };
          }),
        }),
        details: { count: hits.length },
      };
    },
  };

  const askUser: AgentTool<typeof AskParams> = {
    name: "ask_user",
    label: "结构化追问",
    description:
      "信息不足时向用户提问。一次最多 3 个问题，每个问题带 2~4 个选项。返回用户的选择；" +
      "每个非空回答会存成一条证据，返回里的 sources 给出对应 evidenceId，后续 propose_action / propose_memory 可以引用。",
    executionMode: "sequential",
    parameters: AskParams,
    execute: async (toolCallId, params) => {
      // 先落库再问：进程在等用户回答时挂掉，靠 surveyId + toolCallId 才能续上
      const survey = await ctx.store.createSurvey({
        sessionId: ctx.sessionId,
        toolCallId,
        personId: ctx.personId,
        questions: params.questions,
      });
      const answers = await ctx.survey(params.questions);
      await ctx.store.answerSurvey(survey.surveyId, answers);

      // 用户的回答也是一种证据。不落成证据的话，模型问完时间再建提醒会因为
      // "口头信息没有 evidenceId" 被 sourceIds 校验拒掉，等于让追问白问。
      // 只存真正给了信息的回答，"没有更多信息"这类拒绝不占证据位。
      const sources: Record<string, string> = {};
      for (const question of params.questions) {
        const answer = answers[question.id]?.trim();
        if (!answer || answer === "没有更多信息") continue;
        const { evidence } = await ingestEvidence(
          ctx.store,
          {
            personId: ctx.personId,
            kind: "note",
            capturedAt: (ctx.now ?? new Date()).toISOString(),
            title: `用户回答：${question.question}`.slice(0, 80),
            content: `问题：${question.question}\n回答：${answer}`,
            sourceRef: `survey://${survey.surveyId}#${question.id}`,
            ttlMs: 0,
          },
          ctx.now ?? new Date(),
        );
        sources[question.id] = evidence.evidenceId;
      }

      return {
        content: text({
          surveyId: survey.surveyId,
          answers,
          sources,
          note: "sources 是这些回答对应 evidenceId，提案时可以直接引用；没有列出的回答表示用户没有再提供信息。",
        }),
        details: { asked: params.questions.length, surveyId: survey.surveyId, sources },
      };
    },
  };

  const proposeAction: AgentTool<typeof ProposeActionParams> = {
    name: "propose_action",
    label: "提出行动卡",
    description:
      "提出一个需要用户确认的动作（提醒/日程/草稿消息）。只生成行动卡，不会执行；" +
      "用户确认后由宿主提交给设备。必须给出来源证据 sourceIds 和一句给用户看的理由。",
    executionMode: "sequential",
    parameters: ProposeActionParams,
    execute: async (_toolCallId, params) => {
      const card = await ctx.store.createAction({
        personId: ctx.personId,
        sessionId: ctx.sessionId,
        kind: params.kind,
        title: params.title,
        payload: params.payload,
        reason: params.reason,
        sourceIds: params.sourceIds,
      });
      ctx.onProposedAction(card);
      return {
        content: text({
          requestId: card.requestId,
          cardVersion: card.cardVersion,
          status: card.status,
          note: "行动卡已生成，等待用户确认。用户确认前不要声称已执行。",
        }),
        details: { requestId: card.requestId },
      };
    },
  };

  const proposeMemory: AgentTool<typeof ProposeMemoryParams> = {
    name: "propose_memory",
    label: "提出记忆候选",
    description:
      "提出一条值得长期记住的事实，附上支撑它的证据 sourceIds。进入待审核队列，不会直接写入长期记忆。",
    executionMode: "sequential",
    parameters: ProposeMemoryParams,
    execute: async (_toolCallId, params) => {
      const candidate = await ctx.store.createCandidate({
        personId: ctx.personId,
        text: params.text,
        sourceIds: params.sourceIds,
        origin: "main",
        sessionId: ctx.sessionId,
      });
      ctx.onProposedMemory(candidate);
      return {
        content: text({
          candidateId: candidate.candidateId,
          status: candidate.status,
          note: "已进入待审核队列，审核通过后才算写入长期记忆。",
        }),
        details: { candidateId: candidate.candidateId },
      };
    },
  };

  const recallHistory: AgentTool<typeof RecallParams> = {
    name: "recall_history",
    label: "检索会话存档",
    description:
      "当上下文里的摘要没有你要的细节时，按关键词检索本次会话的完整存档（包括已被压缩掉的早期对话）。返回命中的原文片段。",
    parameters: RecallParams,
    execute: async (_toolCallId, params) => {
      const keywords = params.query
        .split(/[\s,，、]+/)
        .map((k) => k.trim())
        .filter(Boolean);
      if (keywords.length === 0) {
        throw new Error("query 至少要给一个关键词，例如：复查 医院");
      }
      const session = await ctx.store.getSession(ctx.sessionId);
      if (!session) throw new Error("会话存档不存在，无法检索");
      const messages = session.messages as unknown[];
      // 多关键词查询最容易死在"最早几条把额度吃光"：十个词一起问，后面的词一条都看不到。
      // 所以有多个词时默认额度按词数放大，下面再保证每个词至少占一个位置。
      const maxReturn = 8;
      const defaultLimit = keywords.length > 1 ? Math.min(keywords.length, maxReturn) : 3;
      const limit = Math.min(Math.max(params.limit ?? defaultLimit, 1), maxReturn);

      const hits: Array<{ index: number; role: string; excerpt: string; matched: string[] }> = [];
      for (let i = 0; i < messages.length; i += 1) {
        const body = messageText(messages[i]);
        if (!body) continue;
        const matched = keywords.filter((k) => body.includes(k));
        if (matched.length === 0) continue;
        hits.push({
          index: i,
          role: (messages[i] as { role?: string }).role ?? "unknown",
          excerpt: excerptAround(body, matched[0]!),
          matched,
        });
      }

      const picked: typeof hits = [];
      const seen = new Set<number>();
      // 第一轮：每个关键词各拿一条最早命中
      for (const keyword of keywords) {
        if (picked.length >= limit) break;
        const hit = hits.find((h) => h.matched.includes(keyword) && !seen.has(h.index));
        if (!hit) continue;
        picked.push(hit);
        seen.add(hit.index);
      }
      // 第二轮：还有额度就按时间顺序补
      for (const hit of hits) {
        if (picked.length >= limit) break;
        if (seen.has(hit.index)) continue;
        picked.push(hit);
        seen.add(hit.index);
      }
      picked.sort((a, b) => a.index - b.index);
      const missing = hits.length - picked.length;

      return {
        content: text({
          totalMatches: hits.length,
          returned: picked.length,
          truncated: missing > 0,
          hits: picked,
          note:
            picked.length === 0
              ? "存档里没有匹配的内容。不要据此编造，直接说明没找到。"
              : missing > 0
                ? `共匹配 ${hits.length} 条，本次只返回 ${picked.length} 条。要更多就换更具体的关键词，或把 limit 调大（上限 8）。引用时说明出自哪一轮。`
                : "这些是对话原文片段，引用时说明出自哪一轮。",
        }),
        details: { totalMatches: hits.length, returned: picked.length, truncated: missing > 0 },
      };
    },
  };

  return [
    getEvidenceText,
    searchEvidence,
    askUser,
    proposeAction,
    proposeMemory,
    recallHistory,
  ].map((tool) => withDeniedCount(tool, ctx.onDenied));
}