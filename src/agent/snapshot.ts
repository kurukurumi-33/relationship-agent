import type { ActionCard, Evidence, MemoryItem } from "../domain/types.js";
import type { Store } from "../store/store.js";

export interface SnapshotEvidenceRef {
  evidenceId: string;
  kind: Evidence["kind"];
  capturedAt: string;
  title: string;
  /** 过期证据不再给正文，只给摘要（没有摘要就标注不可用） */
  preview: string;
  expired: boolean;
}

export interface MemorySnapshot {
  personId: string;
  person: { name: string; relation: string; tags: string[]; relationshipGoal?: string };
  /** 当前时间与时区：相对时间（明天/这周）必须有锚点，否则模型只能猜 */
  now: string;
  timezone: string;
  /** 已确认的长期记忆，模型可以当事实用 */
  memories: Array<Pick<MemoryItem, "memoryId" | "text" | "sourceIds">>;
  /** 证据索引（正文靠 get_evidence_text 按需拉，别一次性塞进上下文） */
  evidence: SnapshotEvidenceRef[];
  /** 未结束的行动卡，避免重复提案 */
  openActions: Array<Pick<ActionCard, "requestId" | "kind" | "title" | "status">>;
  /** 尚未解决的事实冲突：模型必须知道哪些结论还不能当定论 */
  conflicts: Array<{ conflictId: string; description: string; sourceIds: string[] }>;
}

const PREVIEW_CHARS = 120;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS)}…`;
}

/**
 * 按 personID 装配快照。
 *
 * 快照只放"索引 + 已确认结论"，正文（聊天截图 OCR、日历详情）留给工具按需取。
 * 这是上下文预算的核心取舍：随证据条数线性增长的部分必须被截断，
 * 否则一个聊了两年的联系人能把上下文吃光。
 */
export async function buildMemorySnapshot(store: Store, personId: string, now: Date = new Date()): Promise<MemorySnapshot> {
  const person = await store.getPerson(personId);
  const doc = await store.getMemoryDoc(personId);

  const evidence = (await store.listEvidence(personId))
    .filter((ev) => (ev.status ?? "active") === "active")
    .map((ev) => {
    const expired = store.isExpired(ev, now);
    return {
      evidenceId: ev.evidenceId,
      kind: ev.kind,
      capturedAt: ev.capturedAt,
      title: ev.title,
      preview: expired ? (ev.summary ?? "（原始材料已过期，无摘要）") : preview(ev.content),
      expired,
    };
  });

  const openActions = (await store.listActions(personId))
    .filter((a) => a.status === "proposed" || a.status === "submitted" || a.status === "confirmed")
    .map((a) => ({ requestId: a.requestId, kind: a.kind, title: a.title, status: a.status }));

  const conflicts = (await store.listOpenConflicts(personId)).map((c) => ({
    conflictId: c.conflictId,
    description: c.description,
    sourceIds: c.sourceIds,
  }));

  return {
    personId,
    person: {
      name: person.name,
      relation: person.relation,
      tags: person.tags,
      relationshipGoal: person.relationshipGoal,
    },
    now: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    memories: doc.items.map((m) => ({ memoryId: m.memoryId, text: m.text, sourceIds: m.sourceIds })),
    evidence,
    openActions,
    conflicts,
  };
}