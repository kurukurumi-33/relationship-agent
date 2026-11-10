/**
 * SQLite → PostgreSQL 数据迁移。
 *
 *   npm run migrate-pg -- --from data/demo-state.db --to postgresql://relation:relation@localhost:5432/relation
 *   npm run migrate-pg -- --to ... --force   # 目标库已有数据时，先清空再导
 *
 * 保留原始 ID 和时间戳；导完会逐表比对条数，不一致就报错。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { openStore, SqlStore, SqliteDb } from "../src/store/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const TABLES = [
  "handoff", "access_log", "compaction", "conflict", "survey", "session",
  "idempotency", "action", "candidate", "memory_item", "memory_doc", "evidence", "person",
];

async function main(): Promise<void> {
  const from = arg("from") ?? join(root, "data", "state.db");
  const to = arg("to") ?? process.env.DATABASE_URL;
  const force = process.argv.includes("--force");

  if (!to) {
    console.error("需要 --to postgresql://... 或设置 DATABASE_URL 环境变量");
    process.exitCode = 1;
    return;
  }

  console.log(`源: ${from}`);
  const source = await SqlStore.fromDb(await SqliteDb.open(from));
  const state = await source.exportState();

  const target = await openStore({ url: to });

  const existing = await target.listPersons();
  if (existing.length > 0) {
    if (!force) {
      console.error(
        `目标库已有 ${existing.length} 个联系人。确认要清空重导请加 --force。`,
      );
      process.exitCode = 1;
      return;
    }
    const client = new pg.Client({ connectionString: to });
    await client.connect();
    await client.query(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
    await client.end();
    console.log("目标库已清空（--force）");
  }

  await target.importState(state);

  // ---- 逐表比对 ----
  const sourceCounts = {
    persons: Object.keys(state.persons).length,
    evidence: Object.keys(state.evidence).length,
    memoryItems: Object.values(state.memoryDocs).reduce((n, d) => n + d.items.length, 0),
    actions: Object.keys(state.actions).length,
    sessions: Object.keys(state.sessions).length,
    candidates: Object.keys(state.candidates).length,
    surveys: Object.keys(state.surveys).length,
    accessLog: state.accessLog.length,
    handoffs: Object.keys(state.handoffs).length,
  };

  const targetPersons = await target.listPersons();
  const targetEvidence = targetPersons.length
    ? (await Promise.all(targetPersons.map((p) => target.listEvidence(p.personId)))).flat()
    : [];
  const targetDocs = await Promise.all(targetPersons.map((p) => target.getMemoryDoc(p.personId)));
  const targetCounts = {
    persons: targetPersons.length,
    evidence: targetEvidence.length,
    memoryItems: targetDocs.reduce((n, d) => n + d.items.length, 0),
    actions: (await target.listActions()).length,
    sessions: (await target.listSessions()).length,
    candidates: (await target.listCandidates()).length,
    surveys: (await Promise.all((await target.listSessions()).map((s) => target.listSurveys(s.sessionId)))).flat().length,
    accessLog: (await target.listAccess()).length,
    handoffs: (await target.listOpenHandoffs()).length,
  };

  console.log("\n表          源    目标");
  let mismatch = 0;
  for (const key of Object.keys(sourceCounts) as Array<keyof typeof sourceCounts>) {
    const ok = sourceCounts[key] === targetCounts[key];
    if (!ok) mismatch += 1;
    console.log(
      `${key.padEnd(12)}${String(sourceCounts[key]).padStart(3)}  ${String(targetCounts[key]).padStart(4)}  ${ok ? "✓" : "✗"}`,
    );
  }

  await target.close();
  await source.close();

  if (mismatch > 0) {
    console.error(`\n${mismatch} 张表条数不一致`);
    process.exitCode = 1;
  } else {
    console.log("\n迁移完成，逐表核对一致 ✅");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});