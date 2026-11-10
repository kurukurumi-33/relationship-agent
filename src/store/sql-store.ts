import type { Db, Row } from "./db.js";
import type { StorePort } from "./port.js";
import { GenerationConflictError, NotFoundError } from "./port.js";
import type {
  AppState,
  AccessLogEntry,
  ActionCard,
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
import {
  newAccessLogId,
  newCandidateId,
  newConflictId,
  newHandoffId,
  newMemoryId,
  newRequestId,
  newSessionId,
  newSurveyId,
} from "../domain/ids.js";

const j = (v: unknown): string => JSON.stringify(v);
const asString = (v: unknown): string => String(v ?? "");
const asNullable = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v);

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 通用 SQL 实现：一份 SQL，同时适配 SQLite 和 PostgreSQL。
 *
 * 适配器负责占位符和事务语义，这里只管业务 SQL。
 * 48 个公开方法没有一处知道底下是哪个数据库。
 */
export class SqlStore implements StorePort {
  private constructor(private readonly db: Db) {}

  static async fromDb(db: Db): Promise<SqlStore> {
    return new SqlStore(db);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  private run(sql: string, ...params: unknown[]): Promise<number> {
    return this.db.run(sql, params);
  }

  private first(sql: string, ...params: unknown[]): Promise<Row | undefined> {
    return this.db.one(sql, params);
  }

  private all(sql: string, ...params: unknown[]): Promise<Row[]> {
    return this.db.all(sql, params);
  }

  // ---------- 只读区 ----------

  async getPerson(personId: PersonId): Promise<Person> {
    const row = await this.first("SELECT * FROM person WHERE person_id = ?", personId);
    if (!row) throw new NotFoundError(`person ${personId}`);
    return this.toPerson(row);
  }

  async listPersons(): Promise<Person[]> {
    return (await this.all("SELECT * FROM person ORDER BY created_at")).map((r) => this.toPerson(r));
  }

  async listEvidence(personId: PersonId): Promise<Evidence[]> {
    return (await this.all(
      "SELECT * FROM evidence WHERE person_id = ? ORDER BY captured_at",
      personId,
    )).map((r) => this.toEvidence(r));
  }

  async getEvidence(evidenceId: EvidenceId): Promise<Evidence> {
    const row = await this.first("SELECT * FROM evidence WHERE evidence_id = ?", evidenceId);
    if (!row) throw new NotFoundError(`evidence ${evidenceId}`);
    return this.toEvidence(row);
  }

  async searchEvidence(personId: PersonId, query: string): Promise<Evidence[]> {
    const q = query.trim().toLowerCase();
    const all = await this.listEvidence(personId);
    if (!q) return all;
    return all.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q) ||
        e.kind.includes(q),
    );
  }

  async getMemoryDoc(personId: PersonId): Promise<MemoryDoc> {
    const row = await this.first("SELECT * FROM memory_doc WHERE person_id = ?", personId);
    const items = (await this.all(
      "SELECT * FROM memory_item WHERE person_id = ? ORDER BY confirmed_at",
      personId,
    )).map((r) => this.toMemoryItem(r));

    if (!row) {
      return {
        personId,
        generation: 0,
        version: 0,
        items,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      personId,
      generation: Number(row.generation),
      version: Number(row.version),
      items,
      updatedAt: asString(row.updated_at),
    };
  }

  async listActions(personId?: PersonId): Promise<ActionCard[]> {
    const rows = personId
      ? await this.all("SELECT * FROM action WHERE person_id = ? ORDER BY created_at", personId)
      : await this.all("SELECT * FROM action ORDER BY created_at");
    return rows.map((r) => this.toAction(r));
  }

  async getAction(requestId: RequestId): Promise<ActionCard> {
    const row = await this.first("SELECT * FROM action WHERE request_id = ?", requestId);
    if (!row) throw new NotFoundError(`action ${requestId}`);
    return this.toAction(row);
  }

  /**
   * 找出"卡在 submitted、且没有**本次提交**的回执"的卡。
   *
   * 不能只看"幂等表里有没有这条 requestId"：重试过的卡可能留着上一次失败的回执。
   * 回执记的是提交前的 card_version，而 action 在提交后会 +1，
   * 所以"本轮回执"满足 receipt.card_version = action.card_version - 1。
   * 更小的版本号说明是上一轮留下的，不能拿来证明这一轮有结论。
   */
  async listStuckActions(opts: { olderThanMs?: number; now?: Date } = {}): Promise<ActionCard[]> {
    const now = opts.now ?? new Date();
    const threshold = new Date(now.getTime() - (opts.olderThanMs ?? 5 * 60 * 1000)).toISOString();
    const rows = await this.all(
      `SELECT a.* FROM action a
        WHERE a.status = 'submitted'
          AND NOT EXISTS (
            SELECT 1 FROM idempotency i
             WHERE i.request_id = a.request_id
               AND i.card_version >= a.card_version - 1
          )
          AND (a.submitted_at IS NULL OR a.submitted_at <= ?)
        ORDER BY a.submitted_at`,
      threshold,
    );
    return rows.map((r) => this.toAction(r));
  }

  async getCandidate(candidateId: string): Promise<MemoryCandidate> {
    const row = await this.first("SELECT * FROM candidate WHERE candidate_id = ?", candidateId);
    if (!row) throw new NotFoundError(`candidate ${candidateId}`);
    return this.toCandidate(row);
  }

  async listPendingCandidates(personId?: PersonId): Promise<MemoryCandidate[]> {
    const rows = personId
      ? await this.all(
          "SELECT * FROM candidate WHERE status = 'pending' AND person_id = ? ORDER BY created_at",
          personId,
        )
      : await this.all("SELECT * FROM candidate WHERE status = 'pending' ORDER BY created_at");
    return rows.map((r) => this.toCandidate(r));
  }

  async listCandidates(personId?: PersonId): Promise<MemoryCandidate[]> {
    const rows = personId
      ? await this.all("SELECT * FROM candidate WHERE person_id = ? ORDER BY created_at", personId)
      : await this.all("SELECT * FROM candidate ORDER BY created_at");
    return rows.map((r) => this.toCandidate(r));
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const row = await this.first("SELECT * FROM session WHERE session_id = ?", sessionId);
    return row ? this.toSession(row) : undefined;
  }

  async getSessionByRequest(requestId: RequestId): Promise<SessionRecord | undefined> {
    const row = await this.first("SELECT * FROM session WHERE request_id = ?", requestId);
    return row ? this.toSession(row) : undefined;
  }

  async listSessions(personId?: PersonId): Promise<SessionRecord[]> {
    const rows = personId
      ? await this.all("SELECT * FROM session WHERE person_id = ? ORDER BY updated_at DESC", personId)
      : await this.all("SELECT * FROM session ORDER BY updated_at DESC");
    return rows.map((r) => this.toSession(r));
  }

  /** 证据是否已过期（过期后正文不可见，只留摘要）。 */
  isExpired(ev: Evidence, now: Date = new Date()): boolean {
    return Boolean(ev.expiresAt) && new Date(ev.expiresAt!).getTime() <= now.getTime();
  }

  async findByContentHash(personId: PersonId, contentHash: string): Promise<Evidence | undefined> {
    const row = await this.first(
      "SELECT * FROM evidence WHERE person_id = ? AND content_hash = ?",
      personId,
      contentHash,
    );
    return row ? this.toEvidence(row) : undefined;
  }

  async listPendingSurveys(sessionId: string): Promise<SurveyRecord[]> {
    return (await this.all(
      "SELECT * FROM survey WHERE session_id = ? AND answers IS NULL ORDER BY asked_at",
      sessionId,
    )).map((r) => this.toSurvey(r));
  }

  async listSurveys(sessionId: string): Promise<SurveyRecord[]> {
    return (await this.all(
      "SELECT * FROM survey WHERE session_id = ? ORDER BY asked_at",
      sessionId,
    )).map((r) => this.toSurvey(r));
  }

  async getSurvey(surveyId: string): Promise<SurveyRecord> {
    const row = await this.first("SELECT * FROM survey WHERE survey_id = ?", surveyId);
    if (!row) throw new NotFoundError(`survey ${surveyId}`);
    return this.toSurvey(row);
  }

  async listOpenConflicts(personId: PersonId): Promise<FactConflict[]> {
    return (await this.all(
      "SELECT * FROM conflict WHERE person_id = ? AND status = 'open' ORDER BY created_at",
      personId,
    )).map((r) => this.toConflict(r));
  }

  async getCompaction(sessionId: string): Promise<CompactionRecord | undefined> {
    const row = await this.first("SELECT * FROM compaction WHERE session_id = ?", sessionId);
    if (!row) return undefined;
    return {
      sessionId,
      generation: Number(row.generation),
      droppedMessages: Number(row.dropped),
      keptMessages: Number(row.kept),
      summary: asNullable(row.summary),
      at: asString(row.at),
    };
  }

  async listAccess(filter: { personId?: string; sessionId?: string; evidenceId?: string } = {}): Promise<AccessLogEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.personId) {
      conditions.push("person_id = ?");
      params.push(filter.personId);
    }
    if (filter.sessionId) {
      conditions.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.evidenceId) {
      conditions.push("evidence_id = ?");
      params.push(filter.evidenceId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return (await this.all(`SELECT * FROM access_log ${where} ORDER BY at`, ...params)).map((r) => ({
      logId: asString(r.log_id),
      at: asString(r.at),
      sessionId: asNullable(r.session_id),
      personId: asString(r.person_id),
      kind: asString(r.kind) as AccessLogEntry["kind"],
      evidenceId: asNullable(r.evidence_id),
      query: asNullable(r.query),
      actor: asString(r.actor) as AccessLogEntry["actor"],
    }));
  }

  async listOpenHandoffs(personId?: PersonId): Promise<HandoffRecord[]> {
    const rows = personId
      ? await this.all("SELECT * FROM handoff WHERE status = 'open' AND person_id = ?", personId)
      : await this.all("SELECT * FROM handoff WHERE status = 'open'");
    return rows.map((r) => this.toHandoff(r));
  }

  // ---------- 写入区（只允许 host 调用） ----------

  /** sourceIds 校验：每条都必须存在，且属于同一个 person。 */
  async assertSourcesOwnedBy(personId: PersonId, sourceIds: EvidenceId[]): Promise<void> {
    if (sourceIds.length === 0) {
      throw new Error("sourceIds 不能为空：记忆和行动都必须可追溯到证据");
    }
    for (const id of sourceIds) {
      const row = await this.first("SELECT person_id FROM evidence WHERE evidence_id = ?", id);
      if (!row) throw new Error(`sourceIds 校验失败：证据 ${id} 不存在`);
      const owner = asString(row.person_id);
      if (owner !== personId) {
        throw new Error(`sourceIds 校验失败：证据 ${id} 属于 ${owner}，不属于 ${personId}`);
      }
    }
  }

  async createAction(
    input: Omit<ActionCard, "requestId" | "createdAt" | "status" | "cardVersion">,
  ): Promise<ActionCard> {
    await this.assertSourcesOwnedBy(input.personId, input.sourceIds);
    const card: ActionCard = {
      ...input,
      requestId: newRequestId(),
      cardVersion: 1,
      status: "proposed",
      createdAt: new Date().toISOString(),
    };
    await this.db.transaction(async () => {
      await this.run(
        `INSERT INTO action (request_id, person_id, session_id, kind, title, payload, reason,
                             source_ids, card_version, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        card.requestId,
        card.personId,
        card.sessionId ?? null,
        card.kind,
        card.title,
        j(card.payload),
        card.reason,
        j(card.sourceIds),
        card.cardVersion,
        card.status,
        card.createdAt,
      );
    });
    return card;
  }

  async updateAction(
    requestId: RequestId,
    expectedVersion: number,
    patch: Partial<ActionCard>,
  ): Promise<ActionCard> {
    const current = await this.getAction(requestId);
    if (current.cardVersion !== expectedVersion) {
      throw new Error(
        `行动卡版本冲突: requestId=${requestId} expected=${expectedVersion} actual=${current.cardVersion}`,
      );
    }
    const next: ActionCard = { ...current, ...patch, cardVersion: current.cardVersion + 1 };
    const changed = await this.run(
      `UPDATE action SET status=?, confirmed_at=?, submitted_at=?, attempts=?, receipt=?, card_version=?
        WHERE request_id=? AND card_version=?`,
      next.status,
      next.confirmedAt ?? null,
      next.submittedAt ?? null,
      next.attempts ?? null,
      next.receipt ? j(next.receipt) : null,
      next.cardVersion,
      requestId,
      expectedVersion,
    );
    if (changed === 0) {
      throw new Error(`行动卡版本冲突: requestId=${requestId} 已被并发修改`);
    }
    return next;
  }

  async amendAction(
    requestId: RequestId,
    expectedVersion: number,
    patch: Partial<Pick<ActionCard, "kind" | "title" | "payload" | "reason" | "sourceIds">>,
  ): Promise<ActionCard> {
    const current = await this.getAction(requestId);
    if (current.cardVersion !== expectedVersion) {
      throw new Error(
        `行动卡版本冲突: requestId=${requestId} expected=${expectedVersion} actual=${current.cardVersion}`,
      );
    }
    if (current.status !== "proposed") {
      throw new Error(`只有 proposed 状态的行动卡可以修改，当前是 ${current.status}`);
    }
    if (patch.sourceIds) {
      await this.assertSourcesOwnedBy(current.personId, patch.sourceIds);
    }
    const next: ActionCard = {
      ...current,
      ...patch,
      status: "proposed",
      cardVersion: current.cardVersion + 1,
      confirmedAt: undefined,
    };
    const changed = await this.run(
      `UPDATE action SET kind=?, title=?, payload=?, reason=?, source_ids=?,
                         status=?, confirmed_at=?, card_version=?
        WHERE request_id=? AND card_version=?`,
      next.kind,
      next.title,
      j(next.payload),
      next.reason,
      j(next.sourceIds),
      next.status,
      null,
      next.cardVersion,
      requestId,
      expectedVersion,
    );
    if (changed === 0) {
      throw new Error(`行动卡版本冲突: requestId=${requestId} 已被并发修改`);
    }
    return next;
  }

  async getReceipt(requestId: RequestId): Promise<Receipt | undefined> {
    const row = await this.first("SELECT receipt FROM idempotency WHERE request_id = ?", requestId);
    return row ? parseJson<Receipt | undefined>(row.receipt, undefined) : undefined;
  }

  /**
   * 写回执：request_id 主键 + ON CONFLICT DO NOTHING。
   * 返回 true 表示这次真的写进去了，false 表示已经有回执（重复提交）。
   */
  async recordReceipt(record: IdempotencyRecord): Promise<boolean> {
    const changed = await this.run(
      `INSERT INTO idempotency (request_id, card_version, submitted_at, receipt)
       VALUES (?,?,?,?) ON CONFLICT(request_id) DO NOTHING`,
      record.requestId,
      record.cardVersion,
      record.submittedAt,
      j(record.receipt),
    );
    return changed > 0;
  }

  /**
   * 对账专用：补写回执 + 推进状态，两件事必须原子。
   * 分开写会出现"有回执但状态还在 submitted"的不一致。
   */
  async adoptReceipt(card: ActionCard, receipt: Receipt): Promise<ActionCard> {
    const status = receipt.status === "failed" ? "failed" : "executed";
    return await this.db.transaction(async () => {
      await this.run(
        `INSERT INTO idempotency (request_id, card_version, submitted_at, receipt)
         VALUES (?,?,?,?) ON CONFLICT(request_id) DO NOTHING`,
        card.requestId,
        card.cardVersion,
        card.submittedAt ?? new Date().toISOString(),
        j(receipt),
      );
      const changed = await this.run(
        "UPDATE action SET status=?, receipt=?, card_version=card_version+1 WHERE request_id=? AND card_version=?",
        status,
        j(receipt),
        card.requestId,
        card.cardVersion,
      );
      if (changed === 0) {
        // 并发下卡已被别人推进过，回滚（事务内抛错会自动 ROLLBACK）
        throw new Error(`行动卡已被并发修改: ${card.requestId}`);
      }
      return { ...card, status, receipt, cardVersion: card.cardVersion + 1 };
    });
  }

  async createCandidate(input: {
    personId: PersonId;
    text: string;
    sourceIds: EvidenceId[];
    origin?: "main" | "insight";
    sessionId?: string;
  }): Promise<MemoryCandidate> {
    await this.assertSourcesOwnedBy(input.personId, input.sourceIds);
    const candidate: MemoryCandidate = {
      candidateId: newCandidateId(),
      personId: input.personId,
      text: input.text,
      sourceIds: input.sourceIds,
      status: "pending",
      createdAt: new Date().toISOString(),
      origin: input.origin ?? "main",
      sessionId: input.sessionId,
    };
    await this.run(
      `INSERT INTO candidate (candidate_id, person_id, text, source_ids, status, created_at, session_id, origin)
       VALUES (?,?,?,?,?,?,?,?)`,
      candidate.candidateId,
      candidate.personId,
      candidate.text,
      j(candidate.sourceIds),
      candidate.status,
      candidate.createdAt,
      candidate.sessionId ?? null,
      candidate.origin,
    );
    return candidate;
  }

  async reviewCandidate(
    candidateId: string,
    decision: "approved" | "rejected",
    rejectReason?: string,
  ): Promise<MemoryCandidate> {
    const current = await this.getCandidate(candidateId);
    if (current.status !== "pending") {
      throw new Error(`候选 ${candidateId} 已处理过（当前 ${current.status}），不能重复审核`);
    }
    const changed = await this.run(
      `UPDATE candidate SET status=?, reviewed_at=?, reject_reason=? WHERE candidate_id=? AND status='pending'`,
      decision,
      new Date().toISOString(),
      rejectReason ?? null,
      candidateId,
    );
    if (changed === 0) throw new Error(`候选 ${candidateId} 已处理过`);
    return this.getCandidate(candidateId);
  }

  async setInsightDecision(
    candidateId: string,
    decision: "approve" | "reject",
    reason: string,
  ): Promise<MemoryCandidate> {
    const current = await this.getCandidate(candidateId);
    if (current.status !== "pending") {
      throw new Error(`候选 ${candidateId} 已处理过（当前 ${current.status}）`);
    }
    await this.run(
      "UPDATE candidate SET insight_decision=?, insight_reason=? WHERE candidate_id=?",
      decision,
      reason,
      candidateId,
    );
    return this.getCandidate(candidateId);
  }

  /**
   * 记忆写入的唯一入口，带 generation CAS。
   * 关键那一行 UPDATE ... WHERE generation = ? —— 受影响 0 行就是有人先写过。
   */
  async commitMemory(
    personId: PersonId,
    expectedGeneration: number,
    newItems: Array<Pick<MemoryItem, "text" | "sourceIds">>,
  ): Promise<MemoryDoc> {
    for (const item of newItems) await this.assertSourcesOwnedBy(personId, item.sourceIds);

    await this.db.transaction(async () => {
      const now = new Date().toISOString();
      await this.run(
        `INSERT INTO memory_doc (person_id, generation, version, updated_at)
         VALUES (?, 0, 0, ?) ON CONFLICT(person_id) DO NOTHING`,
        personId,
        now,
      );

      const changed = await this.run(
        `UPDATE memory_doc SET generation = generation + 1, version = version + 1, updated_at = ?
          WHERE person_id = ? AND generation = ?`,
        now,
        personId,
        expectedGeneration,
      );
      if (changed === 0) {
        const actual = await this.first(
          "SELECT generation FROM memory_doc WHERE person_id = ?",
          personId,
        );
        throw new GenerationConflictError(
          personId,
          expectedGeneration,
          Number(actual?.generation ?? 0),
        );
      }

      for (const item of newItems) {
        await this.run(
          "INSERT INTO memory_item (memory_id, person_id, text, source_ids, confirmed_at) VALUES (?,?,?,?,?)",
          newMemoryId(),
          personId,
          item.text,
          j(item.sourceIds),
          now,
        );
      }
    });

    return this.getMemoryDoc(personId);
  }

  /**
   * 候选审核通过：写记忆 + 标记 approved，同一个事务。
   *
   * 为什么不能分两步：
   *   - 先标记后写 → 写失败留下"已通过但没落库"，而且永不重试（静默丢数据）
   *   - 先写后标记 → 标记失败留下"已写但还能被再写一次"（重复条目）
   * 只有放进同一个事务，才不会出现半截状态。
   */
  async commitCandidate(candidateId: string, expectedGeneration: number): Promise<MemoryDoc> {
    let personId = "";

    await this.db.transaction(async () => {
      const row = await this.first("SELECT * FROM candidate WHERE candidate_id = ?", candidateId);
      if (!row) throw new NotFoundError(`candidate ${candidateId}`);

      const candidate = this.toCandidate(row);
      if (candidate.status !== "pending") {
        throw new Error(`候选 ${candidateId} 已处理过（当前 ${candidate.status}）`);
      }
      await this.assertSourcesOwnedBy(candidate.personId, candidate.sourceIds);
      personId = candidate.personId;

      const now = new Date().toISOString();
      await this.run(
        `INSERT INTO memory_doc (person_id, generation, version, updated_at)
         VALUES (?, 0, 0, ?) ON CONFLICT(person_id) DO NOTHING`,
        personId,
        now,
      );

      const changed = await this.run(
        `UPDATE memory_doc SET generation = generation + 1, version = version + 1, updated_at = ?
          WHERE person_id = ? AND generation = ?`,
        now,
        personId,
        expectedGeneration,
      );
      if (changed === 0) {
        const actual = await this.first(
          "SELECT generation FROM memory_doc WHERE person_id = ?",
          personId,
        );
        throw new GenerationConflictError(
          personId,
          expectedGeneration,
          Number(actual?.generation ?? 0),
        );
      }

      await this.run(
        "INSERT INTO memory_item (memory_id, person_id, text, source_ids, confirmed_at) VALUES (?,?,?,?,?)",
        newMemoryId(),
        personId,
        candidate.text,
        j(candidate.sourceIds),
        now,
      );

      const marked = await this.run(
        "UPDATE candidate SET status = 'approved', reviewed_at = ? WHERE candidate_id = ? AND status = 'pending'",
        now,
        candidateId,
      );
      if (marked === 0) throw new Error(`候选 ${candidateId} 状态已变化`);
    });

    return this.getMemoryDoc(personId);
  }

  async saveSession(record: SessionRecord): Promise<void> {
    await this.run(
      `INSERT INTO session (session_id, person_id, request_id, page_context, messages, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         person_id=excluded.person_id,
         request_id=excluded.request_id,
         page_context=excluded.page_context,
         messages=excluded.messages,
         updated_at=excluded.updated_at`,
      record.sessionId,
      record.personId,
      record.requestId ?? null,
      record.pageContext ? j(record.pageContext) : null,
      j(record.messages),
      record.createdAt,
      record.updatedAt,
    );
  }

  /** 中断恢复用：只补消息，不覆盖已有的 requestId / pageContext。 */
  async appendSessionMessages(sessionId: string, messages: unknown[]): Promise<void> {
    await this.run(
      "UPDATE session SET messages = ?, updated_at = ? WHERE session_id = ?",
      j(messages),
      new Date().toISOString(),
      sessionId,
    );
  }

  /** 证据入库：同一 person 下 contentHash 相同视为同一份材料，只存一条。 */
  async importEvidence(
    input: Omit<Evidence, "evidenceId"> & { evidenceId?: EvidenceId },
  ): Promise<{ evidence: Evidence; created: boolean }> {
    if (input.contentHash) {
      const existing = await this.findByContentHash(input.personId, input.contentHash);
      if (existing) return { evidence: existing, created: false };
    }
    const evidence: Evidence = {
      ...input,
      evidenceId: input.evidenceId ?? `ev_${Math.random().toString(16).slice(2, 10)}`,
    };
    const changed = await this.run(
      `INSERT INTO evidence (evidence_id, person_id, kind, captured_at, title, content, source_ref,
                             content_hash, expires_at, summary)
       VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(evidence_id) DO NOTHING`,
      evidence.evidenceId,
      evidence.personId,
      evidence.kind,
      evidence.capturedAt,
      evidence.title,
      evidence.content,
      evidence.sourceRef,
      evidence.contentHash ?? null,
      evidence.expiresAt ?? null,
      evidence.summary ?? null,
    );
    if (changed === 0) {
      return { evidence: await this.getEvidence(evidence.evidenceId), created: false };
    }
    return { evidence, created: true };
  }

  // ---------- 问卷（可恢复暂停点） ----------

  async createSurvey(input: {
    sessionId: string;
    toolCallId: string;
    personId: PersonId;
    questions: SurveyQuestion[];
  }): Promise<SurveyRecord> {
    const survey: SurveyRecord = {
      surveyId: newSurveyId(),
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      personId: input.personId,
      questions: input.questions,
      askedAt: new Date().toISOString(),
    };
    await this.run(
      `INSERT INTO survey (survey_id, session_id, tool_call_id, person_id, questions, asked_at)
       VALUES (?,?,?,?,?,?)`,
      survey.surveyId,
      survey.sessionId,
      survey.toolCallId,
      survey.personId,
      j(survey.questions),
      survey.askedAt,
    );
    return survey;
  }

  async answerSurvey(surveyId: string, answers: Record<string, string>): Promise<SurveyRecord> {
    const current = await this.getSurvey(surveyId);
    if (current.answers) {
      throw new Error(`问卷 ${surveyId} 已回答过，不能重复提交`);
    }
    const changed = await this.run(
      "UPDATE survey SET answers = ?, answered_at = ? WHERE survey_id = ? AND answers IS NULL",
      j(answers),
      new Date().toISOString(),
      surveyId,
    );
    if (changed === 0) throw new Error(`问卷 ${surveyId} 已回答过，不能重复提交`);
    return this.getSurvey(surveyId);
  }

  // ---------- 洞察裁决 ----------

  async createConflict(input: {
    personId: PersonId;
    description: string;
    sourceIds: EvidenceId[];
  }): Promise<FactConflict> {
    await this.assertSourcesOwnedBy(input.personId, input.sourceIds);
    const conflict: FactConflict = {
      conflictId: newConflictId(),
      personId: input.personId,
      description: input.description,
      sourceIds: input.sourceIds,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    await this.run(
      `INSERT INTO conflict (conflict_id, person_id, description, source_ids, status, created_at)
       VALUES (?,?,?,?,?,?)`,
      conflict.conflictId,
      conflict.personId,
      conflict.description,
      j(conflict.sourceIds),
      conflict.status,
      conflict.createdAt,
    );
    return conflict;
  }

  /**
   * 压缩记录也走 CAS：两个 worker 同时压缩同一会话时，后写的会被拒。
   */
  async recordCompaction(
    sessionId: string,
    expectedGeneration: number,
    record: Omit<CompactionRecord, "sessionId" | "generation">,
  ): Promise<CompactionRecord> {
    const changed = await this.run(
      `INSERT INTO compaction (session_id, generation, dropped, kept, summary, at)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         generation = compaction.generation + 1,
         dropped = excluded.dropped,
         kept = excluded.kept,
         summary = excluded.summary,
         at = excluded.at
       WHERE compaction.generation = ?`,
      sessionId,
      record.droppedMessages,
      record.keptMessages,
      record.summary ?? null,
      record.at,
      expectedGeneration,
    );
    if (changed === 0) {
      const actual = (await this.getCompaction(sessionId))?.generation ?? 0;
      throw new GenerationConflictError(
        sessionId as PersonId,
        expectedGeneration,
        actual,
      );
    }
    return (await this.getCompaction(sessionId))!;
  }

  // ---------- 访问审计 ----------

  async logAccess(input: Omit<AccessLogEntry, "logId" | "at">): Promise<AccessLogEntry> {
    const entry: AccessLogEntry = {
      ...input,
      logId: newAccessLogId(),
      at: new Date().toISOString(),
    };
    await this.run(
      `INSERT INTO access_log (log_id, at, session_id, person_id, kind, evidence_id, query, actor)
       VALUES (?,?,?,?,?,?,?,?)`,
      entry.logId,
      entry.at,
      entry.sessionId ?? null,
      entry.personId,
      entry.kind,
      entry.evidenceId ?? null,
      entry.query ?? null,
      entry.actor,
    );
    return entry;
  }

  // ---------- 人工接管 ----------

  async createHandoff(input: {
    sessionId: string;
    personId: PersonId;
    reason: HandoffRecord["reason"];
    detail?: string;
  }): Promise<HandoffRecord> {
    const handoff: HandoffRecord = {
      handoffId: newHandoffId(),
      sessionId: input.sessionId,
      personId: input.personId,
      reason: input.reason,
      detail: input.detail,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    await this.run(
      `INSERT INTO handoff (handoff_id, session_id, person_id, reason, detail, status, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      handoff.handoffId,
      handoff.sessionId,
      handoff.personId,
      handoff.reason,
      handoff.detail ?? null,
      handoff.status,
      handoff.createdAt,
    );
    return handoff;
  }

  async resolveHandoff(handoffId: string): Promise<HandoffRecord> {
    const changed = await this.run(
      "UPDATE handoff SET status = 'resolved', resolved_at = ? WHERE handoff_id = ?",
      new Date().toISOString(),
      handoffId,
    );
    if (changed === 0) throw new NotFoundError(`handoff ${handoffId}`);
    const row = await this.first("SELECT * FROM handoff WHERE handoff_id = ?", handoffId);
    return this.toHandoff(row!);
  }

  /** 会话 ID 保留给 server 层生成，这里只暴露给需要稳定 ID 的调用方。 */
  newSessionId(): string {
    return newSessionId();
  }

  // ---------- 种子与迁移 ----------

  /** 首次启动导入种子数据；已经有数据就不动，避免覆盖真实状态。 */
  async seedIfEmpty(seed: Partial<AppState>): Promise<boolean> {
    const row = await this.first("SELECT COUNT(*) AS n FROM person");
    if (Number(row?.n ?? 0) > 0) return false;
    await this.importState(seed);
    return true;
  }

  /**
   * 整体导入一份状态（种子 / 从旧 JSON 迁移）。
   * 保留原始 ID 与时间戳，全表一个事务——迁移中途失败不会留下半套数据。
   */
  async importState(state: Partial<AppState>): Promise<void> {
    await this.db.transaction(async () => {
      for (const person of Object.values(state.persons ?? {})) {
        await this.run(
          `INSERT INTO person (person_id, name, relation, tags, relationship_goal, created_at)
           VALUES (?,?,?,?,?,?) ON CONFLICT(person_id) DO NOTHING`,
          person.personId, person.name, person.relation, j(person.tags),
          person.relationshipGoal ?? null, person.createdAt,
        );
      }

      for (const ev of Object.values(state.evidence ?? {})) {
        await this.run(
          `INSERT INTO evidence (evidence_id, person_id, kind, captured_at, title, content, source_ref,
                                 content_hash, expires_at, summary)
           VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(evidence_id) DO NOTHING`,
          ev.evidenceId, ev.personId, ev.kind, ev.capturedAt, ev.title, ev.content,
          ev.sourceRef, ev.contentHash ?? null, ev.expiresAt ?? null, ev.summary ?? null,
        );
      }

      for (const doc of Object.values(state.memoryDocs ?? {})) {
        await this.run(
          "INSERT INTO memory_doc (person_id, generation, version, updated_at) VALUES (?,?,?,?) ON CONFLICT(person_id) DO NOTHING",
          doc.personId, doc.generation, doc.version, doc.updatedAt,
        );
        for (const item of doc.items) {
          await this.run(
            "INSERT INTO memory_item (memory_id, person_id, text, source_ids, confirmed_at) VALUES (?,?,?,?,?) ON CONFLICT(memory_id) DO NOTHING",
            item.memoryId, doc.personId, item.text, j(item.sourceIds), item.confirmedAt,
          );
        }
      }

      for (const s of Object.values(state.sessions ?? {})) {
        await this.run(
          `INSERT INTO session (session_id, person_id, request_id, page_context, messages, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING`,
          s.sessionId, s.personId, s.requestId ?? null,
          s.pageContext ? j(s.pageContext) : null, j(s.messages), s.createdAt, s.updatedAt,
        );
      }

      for (const s of Object.values(state.surveys ?? {})) {
        await this.run(
          `INSERT INTO survey (survey_id, session_id, tool_call_id, person_id, questions, answers, asked_at, answered_at)
           VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(survey_id) DO NOTHING`,
          s.surveyId, s.sessionId, s.toolCallId, s.personId, j(s.questions),
          s.answers ? j(s.answers) : null, s.askedAt, s.answeredAt ?? null,
        );
      }

      for (const c of Object.values(state.candidates ?? {})) {
        await this.run(
          `INSERT INTO candidate (candidate_id, person_id, text, source_ids, status, created_at, session_id,
                                  origin, insight_decision, insight_reason, reviewed_at, reject_reason)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO NOTHING`,
          c.candidateId, c.personId, c.text, j(c.sourceIds), c.status, c.createdAt,
          c.sessionId ?? null, c.origin ?? "main", c.insightDecision ?? null, c.insightReason ?? null,
          c.reviewedAt ?? null, c.rejectReason ?? null,
        );
      }

      for (const a of Object.values(state.actions ?? {})) {
        await this.run(
          `INSERT INTO action (request_id, person_id, session_id, kind, title, payload, reason, source_ids,
                               card_version, status, created_at, confirmed_at, submitted_at, attempts, receipt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING`,
          a.requestId, a.personId, a.sessionId ?? null, a.kind, a.title, j(a.payload), a.reason,
          j(a.sourceIds), a.cardVersion, a.status, a.createdAt, a.confirmedAt ?? null,
          a.submittedAt ?? null, a.attempts ?? null, a.receipt ? j(a.receipt) : null,
        );
      }

      for (const r of Object.values(state.idempotency ?? {})) {
        await this.run(
          `INSERT INTO idempotency (request_id, card_version, submitted_at, receipt)
           VALUES (?,?,?,?) ON CONFLICT(request_id) DO NOTHING`,
          r.requestId, r.cardVersion, r.submittedAt, j(r.receipt),
        );
      }

      for (const c of Object.values(state.conflicts ?? {})) {
        await this.run(
          `INSERT INTO conflict (conflict_id, person_id, description, source_ids, status, created_at, resolved_at)
           VALUES (?,?,?,?,?,?,?) ON CONFLICT(conflict_id) DO NOTHING`,
          c.conflictId, c.personId, c.description, j(c.sourceIds), c.status,
          c.createdAt, c.resolvedAt ?? null,
        );
      }

      for (const c of Object.values(state.compactions ?? {})) {
        await this.run(
          `INSERT INTO compaction (session_id, generation, dropped, kept, summary, at)
           VALUES (?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING`,
          c.sessionId, c.generation, c.droppedMessages, c.keptMessages,
          c.summary ?? null, c.at,
        );
      }

      for (const a of state.accessLog ?? []) {
        await this.run(
          `INSERT INTO access_log (log_id, at, session_id, person_id, kind, evidence_id, query, actor)
           VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(log_id) DO NOTHING`,
          a.logId, a.at, a.sessionId ?? null, a.personId, a.kind,
          a.evidenceId ?? null, a.query ?? null, a.actor,
        );
      }

      for (const h of Object.values(state.handoffs ?? {})) {
        await this.run(
          `INSERT INTO handoff (handoff_id, session_id, person_id, reason, detail, status, created_at, resolved_at)
           VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(handoff_id) DO NOTHING`,
          h.handoffId, h.sessionId, h.personId, h.reason, h.detail ?? null,
          h.status, h.createdAt, h.resolvedAt ?? null,
        );
      }
    });
  }

  /**
   * 全量导出：把每张表读回领域对象。迁移和备份共用 ——
   * 目标库用 importState 写回去，ID 和时间戳原样保留。
   */
  async exportState(): Promise<AppState> {
    const persons = Object.fromEntries(
      (await this.all("SELECT * FROM person")).map((r) => [asString(r.person_id), this.toPerson(r)]),
    );
    const evidence = Object.fromEntries(
      (await this.all("SELECT * FROM evidence")).map((r) => [
        asString(r.evidence_id),
        this.toEvidence(r),
      ]),
    );

    const itemRows = await this.all("SELECT * FROM memory_item");
    const memoryDocs: Record<string, MemoryDoc> = {};
    for (const row of await this.all("SELECT * FROM memory_doc")) {
      const personId = asString(row.person_id);
      memoryDocs[personId] = {
        personId,
        generation: Number(row.generation),
        version: Number(row.version),
        updatedAt: asString(row.updated_at),
        items: itemRows
          .filter((i) => asString(i.person_id) === personId)
          .map((i) => this.toMemoryItem(i)),
      };
    }

    const candidates = Object.fromEntries(
      (await this.all("SELECT * FROM candidate")).map((r) => [
        asString(r.candidate_id),
        this.toCandidate(r),
      ]),
    );
    const actions = Object.fromEntries(
      (await this.all("SELECT * FROM action")).map((r) => [asString(r.request_id), this.toAction(r)]),
    );
    const sessions = Object.fromEntries(
      (await this.all("SELECT * FROM session")).map((r) => [
        asString(r.session_id),
        this.toSession(r),
      ]),
    );
    const surveys = Object.fromEntries(
      (await this.all("SELECT * FROM survey")).map((r) => [asString(r.survey_id), this.toSurvey(r)]),
    );
    const conflicts = Object.fromEntries(
      (await this.all("SELECT * FROM conflict")).map((r) => [
        asString(r.conflict_id),
        this.toConflict(r),
      ]),
    );
    const handoffs = Object.fromEntries(
      (await this.all("SELECT * FROM handoff")).map((r) => [
        asString(r.handoff_id),
        this.toHandoff(r),
      ]),
    );

    const idempotency: Record<string, IdempotencyRecord> = {};
    for (const row of await this.all("SELECT * FROM idempotency")) {
      const requestId = asString(row.request_id);
      idempotency[requestId] = {
        requestId,
        cardVersion: Number(row.card_version),
        submittedAt: asString(row.submitted_at),
        receipt: parseJson<Receipt>(row.receipt, {
          requestId,
          deviceId: "unknown",
          status: "failed",
          at: "",
        }),
      };
    }

    const compactions: Record<string, CompactionRecord> = {};
    for (const row of await this.all("SELECT * FROM compaction")) {
      const sessionId = asString(row.session_id);
      compactions[sessionId] = {
        sessionId,
        generation: Number(row.generation),
        droppedMessages: Number(row.dropped),
        keptMessages: Number(row.kept),
        summary: asNullable(row.summary),
        at: asString(row.at),
      };
    }

    const accessLog: AccessLogEntry[] = (await this.all("SELECT * FROM access_log ORDER BY at")).map(
      (r) => ({
        logId: asString(r.log_id),
        at: asString(r.at),
        sessionId: asNullable(r.session_id),
        personId: asString(r.person_id),
        kind: asString(r.kind) as AccessLogEntry["kind"],
        evidenceId: asNullable(r.evidence_id),
        query: asNullable(r.query),
        actor: asString(r.actor) as AccessLogEntry["actor"],
      }),
    );

    const requestIndex: Record<string, string> = {};
    for (const session of Object.values(sessions)) {
      if (session.requestId) requestIndex[session.requestId] = session.sessionId;
    }

    return {
      persons,
      evidence,
      memoryDocs,
      candidates,
      actions,
      idempotency,
      sessions,
      surveys,
      conflicts,
      compactions,
      accessLog,
      handoffs,
      requestIndex,
    };
  }

  // ---------- 行映射 ----------

  private toPerson(row: Row): Person {
    return {
      personId: asString(row.person_id),
      name: asString(row.name),
      relation: asString(row.relation),
      tags: parseJson<string[]>(row.tags, []),
      relationshipGoal: asNullable(row.relationship_goal),
      createdAt: asString(row.created_at),
    };
  }

  private toEvidence(row: Row): Evidence {
    return {
      evidenceId: asString(row.evidence_id),
      personId: asString(row.person_id),
      kind: asString(row.kind) as Evidence["kind"],
      capturedAt: asString(row.captured_at),
      title: asString(row.title),
      content: asString(row.content),
      sourceRef: asString(row.source_ref),
      contentHash: asNullable(row.content_hash),
      expiresAt: asNullable(row.expires_at),
      summary: asNullable(row.summary),
    };
  }

  private toMemoryItem(row: Row): MemoryItem {
    return {
      memoryId: asString(row.memory_id),
      text: asString(row.text),
      sourceIds: parseJson<string[]>(row.source_ids, []),
      confirmedAt: asString(row.confirmed_at),
    };
  }

  private toAction(row: Row): ActionCard {
    return {
      requestId: asString(row.request_id),
      personId: asString(row.person_id),
      sessionId: asNullable(row.session_id),
      kind: asString(row.kind) as ActionCard["kind"],
      title: asString(row.title),
      payload: parseJson<Record<string, unknown>>(row.payload, {}),
      reason: asString(row.reason),
      sourceIds: parseJson<string[]>(row.source_ids, []),
      cardVersion: Number(row.card_version),
      status: asString(row.status) as ActionCard["status"],
      createdAt: asString(row.created_at),
      confirmedAt: asNullable(row.confirmed_at),
      submittedAt: asNullable(row.submitted_at),
      attempts: row.attempts === null || row.attempts === undefined ? undefined : Number(row.attempts),
      receipt: parseJson<Receipt | undefined>(row.receipt, undefined),
    };
  }

  private toCandidate(row: Row): MemoryCandidate {
    return {
      candidateId: asString(row.candidate_id),
      personId: asString(row.person_id),
      text: asString(row.text),
      sourceIds: parseJson<string[]>(row.source_ids, []),
      status: asString(row.status) as MemoryCandidate["status"],
      createdAt: asString(row.created_at),
      sessionId: asNullable(row.session_id),
      origin: (asString(row.origin) || "main") as MemoryCandidate["origin"],
      insightDecision: asNullable(row.insight_decision) as MemoryCandidate["insightDecision"],
      insightReason: asNullable(row.insight_reason),
      reviewedAt: asNullable(row.reviewed_at),
      rejectReason: asNullable(row.reject_reason),
    };
  }

  private toSession(row: Row): SessionRecord {
    return {
      sessionId: asString(row.session_id),
      personId: asString(row.person_id),
      requestId: asNullable(row.request_id),
      pageContext: parseJson<SessionRecord["pageContext"]>(row.page_context, undefined),
      messages: parseJson<unknown[]>(row.messages, []),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  private toSurvey(row: Row): SurveyRecord {
    return {
      surveyId: asString(row.survey_id),
      sessionId: asString(row.session_id),
      toolCallId: asString(row.tool_call_id),
      personId: asString(row.person_id),
      questions: parseJson<SurveyQuestion[]>(row.questions, []),
      answers: parseJson<Record<string, string> | undefined>(row.answers, undefined),
      askedAt: asString(row.asked_at),
      answeredAt: asNullable(row.answered_at),
    };
  }

  private toConflict(row: Row): FactConflict {
    return {
      conflictId: asString(row.conflict_id),
      personId: asString(row.person_id),
      description: asString(row.description),
      sourceIds: parseJson<string[]>(row.source_ids, []),
      status: asString(row.status) as FactConflict["status"],
      createdAt: asString(row.created_at),
      resolvedAt: asNullable(row.resolved_at),
    };
  }

  private toHandoff(row: Row): HandoffRecord {
    return {
      handoffId: asString(row.handoff_id),
      sessionId: asString(row.session_id),
      personId: asString(row.person_id),
      reason: asString(row.reason) as HandoffRecord["reason"],
      detail: asNullable(row.detail),
      status: asString(row.status) as HandoffRecord["status"],
      createdAt: asString(row.created_at),
      resolvedAt: asNullable(row.resolved_at),
    };
  }
}