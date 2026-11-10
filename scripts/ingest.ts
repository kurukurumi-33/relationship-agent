/**
 * 批量导入证据。
 *
 *   npm run ingest -- --file data/inbox/evidence.json
 *   npm run ingest -- --file data/inbox/evidence.json --now 2026-10-31T12:00:00+08:00
 *
 * 文件格式：RawEvidenceInput[] 或 { items: RawEvidenceInput[] }
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/store/store.js";
import { seedState } from "../src/data/seed.js";
import { ingestEvidence, type RawEvidenceInput } from "../src/ingest/evidence.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const file = arg("file");
  if (!file) {
    console.log("用法: npm run ingest -- --file data/inbox/evidence.json");
    return;
  }

  const raw = JSON.parse(await readFile(file, "utf8")) as
    | RawEvidenceInput[]
    | { items: RawEvidenceInput[] };
  const items = Array.isArray(raw) ? raw : raw.items;
  const now = arg("now") ? new Date(arg("now")!) : new Date();

  const store = await Store.open(arg("store") ?? join(root, "data", "state.db"));
  // 空库先补种子：外键要求证据必须挂在已存在的联系人上
  await store.seedIfEmpty(seedState);

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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});