import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ActionCard, ActionKind, MemoryCandidate, SurveyQuestion } from "../domain/types.js";
import type { Store } from "../store/store.js";

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
}

const text = (value: unknown) => [
  { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
];

const ACTION_KINDS: ActionKind[] = ["reminder", "calendar_event", "draft_message"];

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
        throw new Error(`证据 ${params.evidenceId} 不属于当前联系人，拒绝跨人读取`);
      }
      await ctx.store.logAccess({
        sessionId: ctx.sessionId,
        personId: ctx.personId,
        kind: "read",
        evidenceId: ev.evidenceId,
        actor: "agent",
      });
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
          hits: hits.map((e) => ({
            evidenceId: e.evidenceId,
            kind: e.kind,
            capturedAt: e.capturedAt,
            title: e.title,
            snippet: e.content.slice(0, 160),
          })),
        }),
        details: { count: hits.length },
      };
    },
  };

  const askUser: AgentTool<typeof AskParams> = {
    name: "ask_user",
    label: "结构化追问",
    description:
      "信息不足时向用户提问。一次最多 3 个问题，每个问题带 2~4 个选项。返回用户的选择。",
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
      return {
        content: text({ surveyId: survey.surveyId, answers }),
        details: { asked: params.questions.length, surveyId: survey.surveyId },
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

  return [getEvidenceText, searchEvidence, askUser, proposeAction, proposeMemory];
}