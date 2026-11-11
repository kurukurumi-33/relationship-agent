import { createHash } from "node:crypto";
import type { Evidence } from "../domain/types.js";
import type { Store } from "../store/store.js";

/**
 * 证据入库管线（M3 的文本版）。
 *
 * 文档里"先存证据再推理"这句话，真正难的是入库这一段：
 *   - 同一张截图重复导入要能去重 → contentHash；
 *   - 原始材料不能永久可见 → TTL，过期后只剩摘要；
 *   - 摘要必须现在就生成，等过期了再生成就已经没有原文了。
 */

export interface RawEvidenceInput {
  personId: string;
  kind: Evidence["kind"];
  capturedAt: string;
  title: string;
  content: string;
  sourceRef: string;
  summary?: string;
  /** 入库状态；抽取失败的材料传 pending_review */
  status?: Evidence["status"];
  /** 覆盖默认哈希口径，例如截图按字节哈希、解析失败的事件按原文哈希 */
  contentHash?: string;
  /** 覆盖默认 TTL；传 0 表示永不过期 */
  ttlMs?: number;
  evidenceId?: string;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * 默认保留期按证据类型分：
 * 截图最敏感、信息密度最低，留 24h 够核对；聊天和日历留着做溯源；手记是用户自己写的，不设过期。
 */
const DEFAULT_TTL_MS: Record<Evidence["kind"], number | undefined> = {
  screenshot: DAY,
  message: 30 * DAY,
  calendar: 90 * DAY,
  note: undefined,
  manual: undefined,
};

export function contentHashOf(input: Pick<RawEvidenceInput, "personId" | "kind" | "content" | "capturedAt">): string {
  return createHash("sha256")
    .update(`${input.personId}|${input.kind}|${input.capturedAt}|${input.content}`)
    .digest("hex");
}

export function deriveSummary(content: string, limit = 60): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

export async function ingestEvidence(
  store: Store,
  input: RawEvidenceInput,
  now: Date = new Date(),
): Promise<{ evidence: Evidence; created: boolean; expiresAt?: string }> {
  const contentHash = input.contentHash ?? contentHashOf(input);
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS[input.kind];

  // 过期时间从"材料产生的时间"算，不是从入库时间算。
  // 否则补录一张三个月前的截图，它会从今天起再活 24 小时——那不是保留策略，是漏洞。
  const expiresAt =
    ttlMs && ttlMs > 0 ? new Date(new Date(input.capturedAt).getTime() + ttlMs).toISOString() : undefined;

  const result = await store.importEvidence({
    evidenceId: input.evidenceId,
    personId: input.personId,
    kind: input.kind,
    capturedAt: input.capturedAt,
    title: input.title,
    content: input.content,
    sourceRef: input.sourceRef,
    contentHash,
    expiresAt,
    status: input.status ?? "active",
    // 摘要必须现在生成：等原文过期了再想摘就来不及了
    summary: input.summary ?? (expiresAt ? deriveSummary(input.content) : undefined),
  });

  return { ...result, expiresAt };
}