/**
 * 看待办：还没确认的行动卡、还没审核的记忆候选。
 *
 *   npm run pending
 *   npm run pending -- --person p_001
 *   npm run pending -- --store data/state.db
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/store/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const storePath = arg("store") ?? join(root, "data", "state.db");
  const personId = arg("person");

  const store = await Store.open(storePath);
  const cards = (await store.listActions(personId)).filter((c) => c.status === "proposed");
  const candidates = await store.listPendingCandidates(personId);

  console.log(`\n待确认行动卡 ${cards.length} 张`);
  for (const card of cards) {
    console.log(`  ${card.requestId}  v${card.cardVersion}  [${card.kind}] ${card.title}`);
    console.log(`    理由: ${card.reason}`);
    console.log(`    确认: npm run confirm -- --request ${card.requestId} --version ${card.cardVersion}`);
  }

  console.log(`\n待审核记忆候选 ${candidates.length} 条`);
  for (const c of candidates) {
    const mark = c.insightDecision === "reject" ? "（洞察已拒）" : "";
    console.log(`  ${c.candidateId}  ${c.text}${mark}`);
    console.log(`    审核: npm run confirm -- --candidate ${c.candidateId}`);
  }

  await store.close();
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});