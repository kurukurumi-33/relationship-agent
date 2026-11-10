/**
 * 执行阶段：把用户已确认的卡推给设备。
 *
 *   npm run execute
 *   npm run execute -- --person p_001
 *   npm run execute -- --limit 10
 *   npm run execute -- --store data/state.db --ledger data/ledger.jsonl
 *
 * 可以挂在定时任务上反复跑；没有待执行的卡时什么都不做。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/store/store.js";
import { MockDevice } from "../src/runtime/device.js";
import { Outbox } from "../src/runtime/outbox.js";
import { executeConfirmed } from "../src/runtime/executor.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const storePath = arg("store") ?? join(root, "data", "state.db");
  const ledgerPath = arg("ledger") ?? join(root, "data", "ledger.jsonl");
  const personId = arg("person");
  const limit = arg("limit") ? Number(arg("limit")) : undefined;

  const store = await Store.open(storePath);
  const outbox = new Outbox(store, new MockDevice(ledgerPath));
  const outcomes = await executeConfirmed(store, outbox, { personId, limit });

  if (outcomes.length === 0) {
    console.log("\n没有待执行的行动卡。");
  } else {
    console.log(`\n执行 ${outcomes.length} 张卡：`);
    for (const o of outcomes) {
      const tail = o.error
        ? `错误: ${o.error}`
        : o.skippedBecause
          ? `跳过: ${o.skippedBecause}`
          : `回执: ${o.receipt?.status ?? "无"}`;
      console.log(`  - ${o.requestId} → ${o.status}  ${tail}`);
    }
  }

  await store.close();
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});