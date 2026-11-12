/**
 * 截图 OCR：把图片交给视觉模型，拿回结构化字段。
 *
 * 只负责"图片 → ScreenshotExtraction"，不碰存储。没配 key、模型报错、返回的
 * 不是 JSON，都直接抛异常，由 ingestScreenshot 落成 pending_review，
 * 所以这里不需要再兜底成空正文。
 */
import { completeSimple, type Model } from "@mariozechner/pi-ai";
import type { ScreenshotExtraction } from "./screenshot.js";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
/** 百炼各账号可见的视觉模型不同，qwen3-vl-plus 覆盖面最广；纯文字识别可用 qwen-vl-ocr */
export const DEFAULT_OCR_MODEL = "qwen3-vl-plus";
const DEFAULT_TIMEOUT_MS = 60_000;
/** DashScope 兼容模式下 base64 内联图片有上传上限，超了先拦掉，别让请求白跑 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface OcrResult extends ScreenshotExtraction {
  /** 模型自评的置信度，0~1。低于阈值时调用方可以考虑不收 */
  confidence?: number;
}

/** 比 ScreenshotExtractor 多一个 confidence 字段，便于验收时看模型自评 */
export interface VisionExtractor {
  extract(input: { filePath: string; bytes: Buffer; mime: string }): Promise<OcrResult>;
}

export interface VisionExtractorOptions {
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

const SYSTEM_PROMPT = [
  "你是聊天截图和日程截图的抽取器。",
  "只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。",
  "字段：capturedAt、title、content、confidence。",
  "content 逐条转写截图里的文字，保留说话人和时间，不要总结、不要补充截图里没有的内容。",
  "如果截图里看不出任何可读文字，content 返回空字符串。",
].join("\n");

const USER_PROMPT = [
  "读取这张截图，按下面的格式输出：",
  '{"capturedAt":"2026-11-12T15:30:00+08:00","title":"不超过 30 字的标题","content":"逐条转写的内容","confidence":0.9}',
  "capturedAt 只在截图里能看出日期时才填，格式用带时区的 ISO 8601。",
  "看不出日期就省略 capturedAt，不要猜。",
].join("\n");

function resolveApiKey(explicit?: string): string {
  const key =
    explicit ??
    process.env.RELATIONSHIP_OCR_API_KEY ??
    process.env.DASHSCOPE_API_KEY;
  if (!key?.trim()) {
    throw new Error(
      "缺少 OCR API key：设置 RELATIONSHIP_OCR_API_KEY 或 DASHSCOPE_API_KEY",
    );
  }
  return key.trim();
}

function buildModel(modelId: string, baseUrl: string, maxTokens: number): Model<"openai-completions"> {
  return {
    id: modelId,
    name: `${modelId} (ocr)`,
    api: "openai-completions",
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens,
    // dashscope 不在 pi 的自动识别表里，默认会发 max_completion_tokens 和 store，
    // 这两个它没文档化，显式收窄到它支持的那部分
    compat: { maxTokensField: "max_tokens", supportsStore: false },
  };
}

/**
 * 从模型回复里剥出 JSON。模型经常无视"不要代码块"，所以围栏要能容错。
 */
export function parseOcrJson(raw: string): OcrResult {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1]!.trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`OCR 返回的不是 JSON 对象：${snip(raw)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(
      `OCR 返回的 JSON 解析失败：${err instanceof Error ? err.message : String(err)}。原文：${snip(raw)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OCR 返回的 JSON 不是对象：${snip(raw)}`);
  }

  const obj = parsed as Record<string, unknown>;
  const content = typeof obj.content === "string" ? obj.content.trim() : "";
  if (!content) throw new Error("OCR 返回的 JSON 没有 content 字段");

  const result: OcrResult = { content };

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (title) result.title = title.slice(0, 80);

  // 只接受能解析成合法时间的 capturedAt；解析不了就当模型没给，回落到文件修改时间
  if (typeof obj.capturedAt === "string" && obj.capturedAt.trim()) {
    const parsedAt = new Date(obj.capturedAt);
    if (!Number.isNaN(parsedAt.getTime())) result.capturedAt = parsedAt.toISOString();
  }

  if (typeof obj.confidence === "number" && Number.isFinite(obj.confidence)) {
    result.confidence = Math.min(1, Math.max(0, obj.confidence));
  }

  return result;
}

function snip(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function createVisionExtractor(options: VisionExtractorOptions = {}): VisionExtractor {
  const baseUrl =
    options.baseUrl ?? process.env.RELATIONSHIP_OCR_BASE_URL?.trim() ?? DEFAULT_BASE_URL;
  const modelId =
    options.modelId ?? process.env.RELATIONSHIP_OCR_MODEL?.trim() ?? DEFAULT_OCR_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? 2048;

  return {
    async extract(input) {
      const apiKey = resolveApiKey(options.apiKey);
      if (input.bytes.length > MAX_IMAGE_BYTES) {
        throw new Error(
          `图片过大：${(input.bytes.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`,
        );
      }

      const response = await completeSimple(
        buildModel(modelId, baseUrl, maxTokens),
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: USER_PROMPT },
                { type: "image", data: input.bytes.toString("base64"), mimeType: input.mime },
              ],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens,
          temperature: 0,
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(
          `OCR 模型调用失败：${response.errorMessage ?? response.stopReason}`,
        );
      }

      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (!text.trim()) throw new Error("OCR 模型没有返回文字");

      return parseOcrJson(text);
    },
  };
}