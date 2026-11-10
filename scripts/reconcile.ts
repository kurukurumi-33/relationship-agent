/**
 * 对账命令：找出"设备可能执行了、但系统不知道"的卡并处理。
 *
 *   npm run reconcile
 *   npm run reconcile -- --store data/demo-state.json
 *   npm run reconcile -- --older-than 0 --resubmit
 *
 * --older-than 毫秒数：只看提交早于这么久之前的卡（默认 300000 = 5 分钟）
 * --resubmit：把"回退到 confirmed"的卡立刻重新提交一次
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/store/store.js";
import { MockDevice } from "../src/runtime/device.js";
import { Outbox } from "../src/runtime/outbox.js";
import { reconcile } from "../src/runtime/reconcile.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const storePath = arg("store") ?? join(root, "data", "state.db");
  const ledgerPath = arg("ledger") ?? join(root, "data", "ledger.jsonl");
  const olderThanMs = arg("older-than") ? Number(arg("older-than")) : undefined;

  const store = await Store.open(storePath);
  const device = new MockDevice(ledgerPath);
  const outbox = new Outbox(store, device);

  const report = await reconcile(store, device, { olderThanMs });

  console.log(`\n对账完成：扫描 ${report.scanned} 张卡`);
  console.log(`  采纳 ${report.adopted}   回退 ${report.resumed}   升级人工 ${report.escalated}`);

  for (const item of report.items) {
    const mark = item.outcome === "adopted" ? "采纳" : item.outcome === "resumed" ? "回退" : "升级";
    console.log(`  - ${item.requestId}  ${mark}  ${item.detail}`);
  }

  if (process.argv.includes("--resubmit") && report.resumed > 0) {
    console.log("\n重新提交已回退的卡：");
    for (const item of report.items.filter((i) => i.outcome === "resumed")) {
      const card = await store.getAction(item.requestId);
      const result = await outbox.submit(card);
      console.log(`  - ${item.requestId} → ${result.card.status}（${result.receipt.status}）`);
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});