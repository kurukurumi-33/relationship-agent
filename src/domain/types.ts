/**
 * 领域模型：这个项目里所有"状态"都从这几种实体派生。
 *
 * 设计原则（对应简历里"明确只读查询、模型建议和实际写入的边界"）：
 *   1. 模型只能读 Evidence 和已确认的 MemoryItem；
 *   2. 模型想改世界，只能产出 ActionCard / MemoryCandidate —— 都是"提案"，不是写入；
 *   3. 真正的状态变更只发生在 host（src/runtime、src/session）里，且必须过确认和校验。
 */

export type PersonId = string;
export type EvidenceId = string;
export type RequestId = string;
export type SessionId = string;

export interface Person {
  personId: PersonId;
  name: string;
  relation: string;
  tags: string[];
  createdAt: string;
  /** 关系目标：这次维护这段关系的目的是什么，快照会带给模型 */
  relationshipGoal?: string;
}

/**
 * 证据：聊天截图、日历、手工笔记。只读，永不被模型改写。
 *
 * 生命周期：
 *   - 原始材料（截图/原聊天）有 expiresAt，过期后正文不再进入模型上下文；
 *   - 过期后只保留 summary + sourceRef，用于追溯"这条结论当时来自哪张图"；
 *   - 长期记忆只引用 evidenceId，不复制原文，所以原图可以放心清。
 */
export interface Evidence {
  evidenceId: EvidenceId;
  personId: PersonId;
  kind: "message" | "calendar" | "note" | "manual" | "screenshot";
  capturedAt: string;
  title: string;
  content: string;
  /** 原始来源指针（文件路径 / 日历事件 ID），用于追溯 */
  sourceRef: string;
  /** 内容哈希：同一份材料重复导入时用于去重 */
  contentHash?: string;
  /** 过期时间；过期后 content 不再对模型可见 */
  expiresAt?: string;
  /** 过期后对外可见的摘要（没有摘要的过期证据会被排除出快照） */
  summary?: string;
}

/** 一条已确认的长期记忆，必须挂证据。 */
export interface MemoryItem {
  memoryId: string;
  text: string;
  sourceIds: EvidenceId[];
  confirmedAt: string;
}

/**
 * 长期记忆文档：按 personId 一份。
 * generation 用于乐观并发控制（CAS），version 用于对外展示/客户端缓存失效。
 */
export interface MemoryDoc {
  personId: PersonId;
  generation: number;
  version: number;
  items: MemoryItem[];
  updatedAt: string;
}

/** 证据互相矛盾时登记的事实冲突，由洞察 Agent 发现；未解决前不进长期记忆。 */
export interface FactConflict {
  conflictId: string;
  personId: PersonId;
  description: string;
  sourceIds: EvidenceId[];
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
}

/** 结构化追问的单个问题（问卷与工具共用同一形状）。 */
export interface SurveyQuestion {
  id: string;
  question: string;
  options?: string[];
}

/**
 * 问卷记录：可恢复暂停点的载体。
 *
 * 关键字段是 toolCallId —— 进程在等用户回答时挂掉，恢复时靠它把答案
 * 精确塞回那条 toolCall 的 toolResult，而不是让配对修复补一条"中断"错误。
 */
export interface SurveyRecord {
  surveyId: string;
  sessionId: SessionId;
  toolCallId: string;
  personId: PersonId;
  questions: SurveyQuestion[];
  answers?: Record<string, string>;
  askedAt: string;
  answeredAt?: string;
}

/** 会话压缩记录：压缩不是静默丢消息，每次压缩留一条带 generation 的账。 */
export interface CompactionRecord {
  sessionId: SessionId;
  generation: number;
  droppedMessages: number;
  keptMessages: number;
  summary?: string;
  at: string;
}

/**
 * 证据访问审计：谁（模型还是宿主）在哪个会话里读过哪条证据。
 *
 * 文档没提这一块，但"证据带 personID、跨人隔离"是它的核心设计——
 * 有隔离就必然有"谁看过什么"的追问，否则隔离只是嘴上说说。
 */
export interface AccessLogEntry {
  logId: string;
  at: string;
  sessionId?: SessionId;
  personId: PersonId;
  kind: "snapshot" | "search" | "read";
  evidenceId?: EvidenceId;
  query?: string;
  actor: "agent" | "host";
}

/**
 * 人工接管：护栏中断、设备反复失败、洞察拿不准时，把会话交回人手里。
 * 没有这个，Agent 卡住时用户只会看到"服务出错"。
 */
export interface HandoffRecord {
  handoffId: string;
  sessionId: SessionId;
  personId: PersonId;
  reason: "guard-exceeded" | "device-failed" | "insight-uncertain" | "manual";
  detail?: string;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
}

export type CandidateStatus = "pending" | "approved" | "rejected";

/** 候选记忆：模型提出、待审核。sourceIds 必须在写入前校验。 */
export interface MemoryCandidate {
  candidateId: string;
  personId: PersonId;
  text: string;
  sourceIds: EvidenceId[];
  status: CandidateStatus;
  createdAt: string;
  sessionId?: SessionId;
  /** 谁提出的：主 Agent 的临场判断，还是洞察 Agent 复盘后的结论 */
  origin: "main" | "insight";
  /** 洞察 Agent 的裁决；只有 approve 的候选才会进入用户审核 */
  insightDecision?: "approve" | "reject";
  insightReason?: string;
  reviewedAt?: string;
  rejectReason?: string;
}

export type ActionKind = "reminder" | "calendar_event" | "draft_message";
export type ActionStatus =
  | "proposed" // 模型给出提案，未确认
  | "confirmed" // 用户点了确认
  | "submitted" // 已提交到设备，等回执
  | "executed" // 设备回执成功（视频口述里把这个叫 confirmed，我们拆开了）
  | "failed" // 设备回执失败
  | "rejected"; // 用户拒绝

/** 行动卡：一次可确认的写操作提案。requestId + cardVersion 构成幂等键。 */
export interface ActionCard {
  requestId: RequestId;
  personId: PersonId;
  /** 产生这张卡的会话，对账/接管时要挂回原会话 */
  sessionId?: SessionId;
  kind: ActionKind;
  title: string;
  payload: Record<string, unknown>;
  reason: string;
  sourceIds: EvidenceId[];
  cardVersion: number;
  status: ActionStatus;
  createdAt: string;
  confirmedAt?: string;
  submittedAt?: string;
  /** 已向设备提交过几次（失败重试计数，用于补偿策略） */
  attempts?: number;
  receipt?: Receipt;
}

/**
 * 设备回执：设备侧真实执行结果。
 * 它和"应用已提交"是两件事；partial 表示部分成功，需要后续人工跟进。
 */
export interface Receipt {
  requestId: RequestId;
  deviceId: string;
  status: "ok" | "partial" | "failed";
  at: string;
  detail?: string;
  /** 失败是否值得重试：只有冲突类（如时段被占）才重试，不明原因一律不重试 */
  retryable?: boolean;
}

/** 页面上下文：让"帮我改一下"这类指代有落点。 */
export interface PageContext {
  screen?: string;
  personId?: PersonId;
  selectedActionId?: RequestId;
  note?: string;
}

/** 会话记录：持久化 agent 消息，用于中断恢复。 */
export interface SessionRecord {
  sessionId: SessionId;
  personId: PersonId;
  /** 请求级幂等键：同一个 requestId 重放不会产生第二次执行 */
  requestId?: RequestId;
  pageContext?: PageContext;
  messages: unknown[];
  createdAt: string;
  updatedAt: string;
}

/** 幂等表：同一个 requestId + cardVersion 只允许真正提交一次。 */
export interface IdempotencyRecord {
  requestId: RequestId;
  cardVersion: number;
  submittedAt: string;
  receipt: Receipt;
}

export interface AppState {
  persons: Record<PersonId, Person>;
  evidence: Record<EvidenceId, Evidence>;
  memoryDocs: Record<PersonId, MemoryDoc>;
  candidates: Record<string, MemoryCandidate>;
  actions: Record<RequestId, ActionCard>;
  idempotency: Record<string, IdempotencyRecord>;
  sessions: Record<SessionId, SessionRecord>;
  surveys: Record<string, SurveyRecord>;
  conflicts: Record<string, FactConflict>;
  compactions: Record<SessionId, CompactionRecord>;
  /** 访问审计是追加日志，不覆盖 */
  accessLog: AccessLogEntry[];
  handoffs: Record<string, HandoffRecord>;
  /** 请求级幂等索引：requestId → sessionId */
  requestIndex: Record<RequestId, SessionId>;
}

export function emptyState(): AppState {
  return {
    persons: {},
    evidence: {},
    memoryDocs: {},
    candidates: {},
    actions: {},
    idempotency: {},
    sessions: {},
    surveys: {},
    conflicts: {},
    compactions: {},
    accessLog: [],
    handoffs: {},
    requestIndex: {},
  };
}