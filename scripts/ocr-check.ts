/**
 * 手工验收截图 OCR：只调模型，不写库。
 *
 *   npm run ocr-check -- --image D:\path\to\chat.png
 *   npm run ocr-check -- --image chat.png --model qwen-vl-plus
 *   npm run ocr-check -- --image chat.png --show-raw
 *
 * key 从 RELATIONSHIP_OCR_API_KEY 或 DASHSCOPE_API_KEY 读，不打印内容，只报是否存在。
 * 想直接入库用 `npm run ingest -- --image ... --person p_001 --ocr`。
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { loadEnv } from "../src/config.js";
import { createVisionExtractor } from "../src/ingest/ocr.js";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnv();
  const file = arg("image");
  if (!file) {
    console.log("用法: npm run ocr-check -- --image <图片路径> [--model qwen-vl-max]");
    return;
  }

  const mime = MIME_BY_EXT[extname(file).toLowerCase()];
  if (!mime) {
    console.error(`不支持的图片格式：${extname(file) || "(无扩展名)"}`);
    process.exitCode = 1;
    return;
  }

  const key = process.env.RELATIONSHIP_OCR_API_KEY ?? process.env.DASHSCOPE_API_KEY;
  console.log(`API key：${key ? `已配置（${key.length} 字符）` : "未配置"}`);
  if (!key) {
    console.log("设置 DASHSCOPE_API_KEY 之后再跑。");
    process.exitCode = 1;
    return;
  }

  const modelId = arg("model") ?? process.env.RELATIONSHIP_OCR_MODEL ?? "qwen-vl-max";
  const baseUrl = process.env.RELATIONSHIP_OCR_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
  console.log(`端点：${baseUrl}`);
  console.log(`模型：${modelId}`);
  console.log(`图片：${file}`);

  const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
  console.log(`大小：${(bytes.length / 1024).toFixed(1)}KB\n`);

  const extractor = createVisionExtractor({ modelId });
  const startedAt = Date.now();
  const result = await extractor.extract({ filePath: file, bytes, mime });
  const elapsed = Date.now() - startedAt;

  console.log(`耗时：${(elapsed / 1000).toFixed(1)}s`);
  console.log(`capturedAt：${result.capturedAt ?? "(模型没给，入库时回落到文件修改时间)"}`);
  console.log(`title：${result.title ?? "(模型没给，入库时用文件名)"}`);
  console.log(`confidence：${result.confidence ?? "(模型没给)"}`);
  if (arg("show-raw")) {
    console.log("content 原文：");
    console.log(result.content);
  } else {
    const lines = result.content.split("\n").filter((l) => l.trim());
    console.log(`content：${lines.length} 行，${result.content.length} 字符`);
    for (const line of lines.slice(0, 5)) console.log(`  ${line}`);
    if (lines.length > 5) console.log(`  ...另有 ${lines.length - 5} 行，加 --show-raw 看全文`);
  }

  console.log("\n这只是验收，没有写库。入库用：");
  console.log(`  npm run ingest -- --image "${file}" --person p_001 --ocr`);
  console.log(`文件修改时间：${info.mtime.toISOString()}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});