/**
 * 从旧的 state.json 迁移到 SQLite。
 *
 *   npm run migrate-json -- --from data/state.json --to data/state.db
 *
 * 迁移而不是双写：两套真值来源必然漂移。这里一次性导入，旧文件保留不动（当备份）。
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/store/store.js";
import type { AppState } from "../src/domain/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const from = arg("from") ?? join(root, "data", "state.json");
  const to = arg("to") ?? join(root, "data", "state.db");

  const raw = await readFile(from, "utf8");
  const state = JSON.parse(raw) as Partial<AppState>;

  const store = await Store.open(to);
  await store.importState(state);

  console.log(`已迁移 → ${to}`);
  console.log(`  联系人 ${Object.keys(state.persons ?? {}).length}`);
  console.log(`  证据   ${Object.keys(state.evidence ?? {}).length}`);
  console.log(`  记忆   ${Object.values(state.memoryDocs ?? {}).reduce((n, d) => n + d.items.length, 0)} 条`);
  console.log(`  行动卡 ${Object.keys(state.actions ?? {}).length}`);
  console.log(`  会话   ${Object.keys(state.sessions ?? {}).length}`);
  console.log(`\n旧文件 ${from} 未改动，确认无误后可自行删除。`);
  store.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});