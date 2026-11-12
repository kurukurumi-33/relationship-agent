/**
 * 批量导入证据。
 *
 *   npm run ingest -- --file data/inbox/evidence.json
 *   npm run ingest -- --ics data/inbox/calendar.ics --person p_001
 *   npm run ingest -- --image data/inbox/chat.png --person p_001
 *   npm run ingest -- --image data/inbox/chat.png --person p_001 --ocr
 *   npm run ingest -- --file data/inbox/evidence.json --now 2026-10-31T12:00:00+08:00
 *
 * --ocr 才会真的调视觉模型，不加就落 pending_review。
 * JSON 文件格式：RawEvidenceInput[] 或 { items: RawEvidenceInput[] }
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/store/store.js";
import { loadEnv } from "../src/config.js";
import { seedState } from "../src/data/seed.js";
import { ingestEvidence, type RawEvidenceInput } from "../src/ingest/evidence.js";
import { ingestIcs } from "../src/ingest/calendar.js";
import { ingestScreenshot } from "../src/ingest/screenshot.js";
import { createVisionExtractor } from "../src/ingest/ocr.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnv();
  const file = arg("file");
  const ics = arg("ics");
  const image = arg("image");
  const person = arg("person");

  if (!file && !ics && !image) {
    console.log("用法:");
    console.log("  npm run ingest -- --file data/inbox/evidence.json");
    console.log("  npm run ingest -- --ics data/inbox/calendar.ics --person p_001");
    console.log("  npm run ingest -- --image data/inbox/chat.png --person p_001");
    console.log("  npm run ingest -- --image data/inbox/chat.png --person p_001 --ocr");
    return;
  }

  const now = arg("now") ? new Date(arg("now")!) : new Date();
  const useOcr = process.argv.includes("--ocr");
  const store = await Store.open(arg("store") ?? join(root, "data", "state.db"));
  // 空库先补种子：外键要求证据必须挂在已存在的联系人上
  await store.seedIfEmpty(seedState);

  try {
    if (ics) {
      await runIcs(store, ics, person, now);
    } else if (image) {
      await runImage(store, image, person, now, useOcr);
    } else if (file) {
      await runJson(store, file, now);
    }
  } finally {
    await store.close();
  }
}

async function runJson(store: Store, file: string, now: Date): Promise<void> {
  const raw = JSON.parse(await readFile(file, "utf8")) as
    | RawEvidenceInput[]
    | { items: RawEvidenceInput[] };
  const items = Array.isArray(raw) ? raw : raw.items;

  let created = 0;
  let duplicated = 0;
  let expired = 0;

  for (const item of items) {
    const result = await ingestEvidence(store, item, now);
    if (result.created) created += 1;
    else duplicated += 1;
    if (result.expiresAt && new Date(result.expiresAt) <= now) expired += 1;
    console.log(
      `  ${result.created ? "新增" : "重复跳过"}  ${result.evidence.evidenceId}  ${result.evidence.kind.padEnd(10)} ${result.evidence.title}` +
        (result.expiresAt ? `  (有效期至 ${result.expiresAt})` : "  (永不过期)"),
    );
  }

  console.log(`\n共 ${items.length} 条：新增 ${created}，重复 ${duplicated}，已过期 ${expired}`);
}

async function runIcs(
  store: Store,
  file: string,
  person: string | undefined,
  now: Date,
): Promise<void> {
  if (!person) {
    console.error("--ics 需要同时指定 --person，例如 --person p_001");
    process.exitCode = 1;
    return;
  }

  const text = await readFile(file, "utf8");
  const result = await ingestIcs(store, text, { personId: person, sourceRef: file, now });

  for (const item of result.items) {
    console.log(
      `  ${item.created ? "新增" : "重复跳过"}  ${item.evidence.evidenceId}  ` +
        `${(item.evidence.status ?? "active").padEnd(13)} ${item.evidence.capturedAt}  ${item.evidence.title}`,
    );
  }

  console.log(
    `\n共 ${result.events.length} 个事件：导入 ${result.items.length}，重复 ${result.duplicates}，` +
      `已取消 ${result.cancelled}，待人工确认 ${result.pending}`,
  );
}

async function runImage(
  store: Store,
  file: string,
  person: string | undefined,
  now: Date,
  useOcr: boolean,
): Promise<void> {
  if (!person) {
    console.error("--image 需要同时指定 --person，例如 --person p_001");
    process.exitCode = 1;
    return;
  }

  const result = await ingestScreenshot(store, {
    personId: person,
    filePath: file,
    now,
    extractor: useOcr ? createVisionExtractor() : undefined,
  });
  console.log(
    `${result.created ? "新增" : "重复跳过"}  ${result.evidence.evidenceId}  ${result.status}  ${result.evidence.title}`,
  );
  if (result.reason) console.log(`  原因：${result.reason}`);
  const expiresAt = result.evidence.expiresAt;
  if (expiresAt && new Date(expiresAt) <= now) {
    console.log(
      `  注意：这条材料入库时就已经过期（${expiresAt}）。` +
        "快照和工具里只会看到摘要，拿不到正文。",
    );
  }
  console.log(
    result.status === "pending_review"
      ? "\n这条证据不会进入快照，等人工确认后才能被模型读取。" +
          (useOcr ? "" : "\n（没加 --ocr，所以没有真的调用视觉模型）")
      : "\n已入库，可以进入快照。",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});