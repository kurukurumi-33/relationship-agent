import type {
  AccessLogEntry,
  ActionCard,
  AppState,
  CompactionRecord,
  Evidence,
  EvidenceId,
  FactConflict,
  HandoffRecord,
  IdempotencyRecord,
  MemoryCandidate,
  MemoryDoc,
  MemoryItem,
  Person,
  PersonId,
  Receipt,
  RequestId,
  SessionRecord,
  SurveyQuestion,
  SurveyRecord,
} from "../domain/types.js";

/** 记忆写入时的乐观并发冲突。上层要显式处理，不能吞掉。 */
export class GenerationConflictError extends Error {
  constructor(
    readonly personId: PersonId,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`记忆文档版本冲突: personId=${personId} expected generation=${expected} actual=${actual}`);
    this.name = "GenerationConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`未找到: ${what}`);
    this.name = "NotFoundError";
  }
}

/**
 * 存储接口。上层只依赖这个，不依赖具体是 SQLite 还是 PostgreSQL。
 *
 * 方法签名在两次迁移里一次都没变过：
 *   JSON 文件 → SQLite（换实现）→ PostgreSQL（换驱动）
 * 调用方始终没改。
 */
export interface StorePort {
  close(): Promise<void>;

  // 只读
  getPerson(personId: PersonId): Promise<Person>;
  listPersons(): Promise<Person[]>;
  listEvidence(personId: PersonId): Promise<Evidence[]>;
  getEvidence(evidenceId: EvidenceId): Promise<Evidence>;
  searchEvidence(personId: PersonId, query: string): Promise<Evidence[]>;
  getMemoryDoc(personId: PersonId): Promise<MemoryDoc>;
  listActions(personId?: PersonId): Promise<ActionCard[]>;
  getAction(requestId: RequestId): Promise<ActionCard>;
  listStuckActions(opts?: { olderThanMs?: number; now?: Date }): Promise<ActionCard[]>;
  getCandidate(candidateId: string): Promise<MemoryCandidate>;
  listPendingCandidates(personId?: PersonId): Promise<MemoryCandidate[]>;
  listCandidates(personId?: PersonId): Promise<MemoryCandidate[]>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  getSessionByRequest(requestId: RequestId): Promise<SessionRecord | undefined>;
  listSessions(personId?: PersonId): Promise<SessionRecord[]>;
  isExpired(ev: Evidence, now?: Date): boolean;
  findByContentHash(personId: PersonId, contentHash: string): Promise<Evidence | undefined>;
  listPendingSurveys(sessionId: string): Promise<SurveyRecord[]>;
  listSurveys(sessionId: string): Promise<SurveyRecord[]>;
  getSurvey(surveyId: string): Promise<SurveyRecord>;
  listOpenConflicts(personId: PersonId): Promise<FactConflict[]>;
  getCompaction(sessionId: string): Promise<CompactionRecord | undefined>;
  listAccess(filter?: {
    personId?: string;
    sessionId?: string;
    evidenceId?: string;
  }): Promise<AccessLogEntry[]>;
  listOpenHandoffs(personId?: PersonId): Promise<HandoffRecord[]>;

  // 写入
  assertSourcesOwnedBy(personId: PersonId, sourceIds: EvidenceId[]): Promise<void>;
  createAction(
    input: Omit<ActionCard, "requestId" | "createdAt" | "status" | "cardVersion">,
  ): Promise<ActionCard>;
  updateAction(
    requestId: RequestId,
    expectedVersion: number,
    patch: Partial<ActionCard>,
  ): Promise<ActionCard>;
  /**
   * 修改一张还没确认的提案。
   * 版本号递增，旧版本号上发出的确认自然失效——这正是异步确认需要的语义。
   */
  amendAction(
    requestId: RequestId,
    expectedVersion: number,
    patch: Partial<Pick<ActionCard, "kind" | "title" | "payload" | "reason" | "sourceIds">>,
  ): Promise<ActionCard>;
  getReceipt(requestId: RequestId): Promise<Receipt | undefined>;
  recordReceipt(record: IdempotencyRecord): Promise<boolean>;
  adoptReceipt(card: ActionCard, receipt: Receipt): Promise<ActionCard>;
  createCandidate(input: {
    personId: PersonId;
    text: string;
    sourceIds: EvidenceId[];
    origin?: "main" | "insight";
    sessionId?: string;
  }): Promise<MemoryCandidate>;
  reviewCandidate(
    candidateId: string,
    decision: "approved" | "rejected",
    rejectReason?: string,
  ): Promise<MemoryCandidate>;
  setInsightDecision(
    candidateId: string,
    decision: "approve" | "reject",
    reason: string,
  ): Promise<MemoryCandidate>;
  commitMemory(
    personId: PersonId,
    expectedGeneration: number,
    newItems: Array<Pick<MemoryItem, "text" | "sourceIds">>,
  ): Promise<MemoryDoc>;
  /**
   * 候选审核通过：写入长期记忆 + 标记候选 approved，两件事同一个事务。
   * 分开做会出现"写了记忆但候选还在 pending"（重复写）或"标记通过但没写"（丢写）。
   */
  commitCandidate(candidateId: string, expectedGeneration: number): Promise<MemoryDoc>;
  saveSession(record: SessionRecord): Promise<void>;
  appendSessionMessages(sessionId: string, messages: unknown[]): Promise<void>;
  importEvidence(
    input: Omit<Evidence, "evidenceId"> & { evidenceId?: EvidenceId },
  ): Promise<{ evidence: Evidence; created: boolean }>;
  /** 人工审核待确认证据：改状态，必要时补正文和标题。 */
  updateEvidence(
    evidenceId: EvidenceId,
    patch: {
      status?: Evidence["status"];
      title?: string;
      content?: string;
      summary?: string;
      expiresAt?: string;
    },
  ): Promise<Evidence>;
  createSurvey(input: {
    sessionId: string;
    toolCallId: string;
    personId: PersonId;
    questions: SurveyQuestion[];
  }): Promise<SurveyRecord>;
  answerSurvey(surveyId: string, answers: Record<string, string>): Promise<SurveyRecord>;
  createConflict(input: {
    personId: PersonId;
    description: string;
    sourceIds: EvidenceId[];
  }): Promise<FactConflict>;
  recordCompaction(
    sessionId: string,
    expectedGeneration: number,
    record: Omit<CompactionRecord, "sessionId" | "generation">,
  ): Promise<CompactionRecord>;
  logAccess(input: Omit<AccessLogEntry, "logId" | "at">): Promise<AccessLogEntry>;
  createHandoff(input: {
    sessionId: string;
    personId: PersonId;
    reason: HandoffRecord["reason"];
    detail?: string;
  }): Promise<HandoffRecord>;
  resolveHandoff(handoffId: string): Promise<HandoffRecord>;
  newSessionId(): string;
  seedIfEmpty(seed: Partial<AppState>): Promise<boolean>;
  importState(state: Partial<AppState>): Promise<void>;
  /** 全量导出，用于迁移和备份 */
  exportState(): Promise<AppState>;
}