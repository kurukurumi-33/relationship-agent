import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Evidence } from "../domain/types.js";
import type { Store } from "../store/store.js";
import { ingestEvidence } from "./evidence.js";

/**
 * 截图入库。
 *
 * 解析器是注入的：没有多模态 key 时也能跑通失败路径。抽不出正文的截图不会丢，
 * 会落成 pending_review 的证据，带来源指针等待人工确认；去重按图片字节哈希，
 * 与文件名和入库时间无关。
 */

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
};

export interface ScreenshotExtraction {
  /** 截图拍摄时间；取不到就用文件修改时间 */
  capturedAt?: string;
  title?: string;
  content: string;
}

export interface ScreenshotExtractor {
  extract(input: { filePath: string; bytes: Buffer; mime: string }): Promise<ScreenshotExtraction>;
}

export interface ScreenshotIngestOptions {
  personId: string;
  filePath: string;
  extractor?: ScreenshotExtractor;
  now?: Date;
}

export interface ScreenshotIngestResult {
  evidence: Evidence;
  created: boolean;
  status: NonNullable<Evidence["status"]>;
  /** pending_review 的原因，成功时为 undefined */
  reason?: string;
}

export async function ingestScreenshot(
  store: Store,
  opts: ScreenshotIngestOptions,
): Promise<ScreenshotIngestResult> {
  const ext = extname(opts.filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  const [bytes, info] = await Promise.all([readFile(opts.filePath), stat(opts.filePath)]);
  const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  let extraction: ScreenshotExtraction | undefined;
  let reason: string | undefined;

  if (!mime) {
    reason = `不支持的图片格式：${ext || "(无扩展名)"}`;
  } else if (!opts.extractor) {
    reason = "未配置 OCR 提取器";
  } else {
    try {
      extraction = await opts.extractor.extract({ filePath: opts.filePath, bytes, mime });
      if (!extraction.content.trim()) {
        reason = "OCR 未返回正文";
        extraction = undefined;
      }
    } catch (err) {
      reason = `OCR 失败：${err instanceof Error ? err.message : String(err)}`;
      extraction = undefined;
    }
  }

  const status: NonNullable<Evidence["status"]> = extraction ? "active" : "pending_review";
  const capturedAt = extraction?.capturedAt ?? info.mtime.toISOString();
  const fileName = basename(opts.filePath);

  const result = await ingestEvidence(
    store,
    {
      personId: opts.personId,
      kind: "screenshot",
      capturedAt,
      title: extraction?.title?.trim() || (status === "active" ? fileName : `待确认：${fileName}`),
      content: extraction?.content ?? "",
      sourceRef: opts.filePath,
      status,
      contentHash,
      // 待确认材料不设过期，否则人工还没看，原文引用就先失效了
      ttlMs: status === "pending_review" ? 0 : undefined,
      summary: status === "pending_review" ? reason : undefined,
    },
    opts.now,
  );

  return { ...result, status, reason };
}