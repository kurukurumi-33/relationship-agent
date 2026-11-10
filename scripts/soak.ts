/**
 * 故障注入压测：把"最终一致"从形容词变成数字。
 *
 *   npm run soak
 *   npm run soak -- --n 500 --seed 7
 *   npm run soak -- --n 200 --ok 0.6 --retryable 0.15 --permanent 0.1 --partial 0.05 --lost 0.1
 *
 * 输出四类指标：
 *   1. 最终一致率：跑完之后停在终态（executed / failed）的比例
 *   2. 悬挂率：停在 submitted 且对账也没解决的比例
 *   3. 重复副作用：同一个 requestId 在设备账本里出现多次的数量
 *   4. 状态误报：设备账本显示成功、系统却记成失败（或反过来）
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { Store } from "../src/store/store.js";
import { seedState } from "../src/data/seed.js";
import { MockDevice } from "../src/runtime/device.js";
import type { DeviceAdapter } from "../src/runtime/device.js";
import { FaultyDevice } from "../src/runtime/faults.js";
import { Outbox } from "../src/runtime/outbox.js";
import { reconcile } from "../src/runtime/reconcile.js";
import type { Receipt } from "../src/domain/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readLedger(path: string): Promise<Array<{ requestId: string; receipt: Receipt }>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as { card: { requestId: string }; receipt: Receipt };
        return [{ requestId: entry.card.requestId, receipt: entry.receipt }];
      } catch {
        return [];
      }
    });
}

async function main(): Promise<void> {
  const n = Number(arg("n") ?? 200);
  const maxAttempts = Number(arg("attempts") ?? 3);
  const storePath = arg("store") ?? join(root, "data", "soak.db");
  const ledgerPath = arg("ledger") ?? join(root, "data", "soak.jsonl");
  const profile = {
    ok: Number(arg("ok") ?? 0.7),
    retryable: Number(arg("retryable") ?? 0.1),
    permanent: Number(arg("permanent") ?? 0.1),
    partial: Number(arg("partial") ?? 0.05),
    lostReceipt: Number(arg("lost") ?? 0.05),
    seed: Number(arg("seed") ?? 42),
  };

  await Store.reset(storePath);
  await rm(ledgerPath, { force: true });

  const store = await Store.open(storePath);
  await store.seedIfEmpty(seedState);

  const base = new MockDevice(ledgerPath);
  const faulty = new FaultyDevice(base, profile);
  // --no-lookup 模拟"设备没有幂等查询能力"：状态未知时只能交给人
  const noLookup = process.argv.includes("--no-lookup");
  const device: DeviceAdapter = noLookup
    ? { id: faulty.id, execute: (card) => faulty.execute(card) }
    : faulty;
  const outbox = new Outbox(store, device, maxAttempts);

  const requestIds: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const card = await store.createAction({
      personId: "p_001",
      kind: "reminder",
      title: `soak-${i}`,
      payload: { at: "2026-11-20T09:00:00+08:00" },
      reason: "故障注入压测",
      sourceIds: ["ev_001"],
    });
    await store.updateAction(card.requestId, card.cardVersion, {
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
    });
    requestIds.push(card.requestId);
  }

  for (const requestId of requestIds) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const card = await store.getAction(requestId);
      if (card.status !== "confirmed" && card.status !== "failed") break;
      try {
        const result = await outbox.submit(card);
        if (result.card.status !== "failed" || result.receipt.retryable !== true) break;
      } catch {
        break;
      }
    }
  }

  const beforeReconcile = await store.listActions("p_001");
  const stuckBefore = beforeReconcile.filter((c) => c.status === "submitted").length;

  const report = await reconcile(store, device, { olderThanMs: 0 });
  const handoffs = await store.listOpenHandoffs("p_001");

  const cards = await store.listActions("p_001");
  const ledger = await readLedger(ledgerPath);
  const ledgerByRequest = new Map<string, Receipt[]>();
  for (const entry of ledger) {
    const list = ledgerByRequest.get(entry.requestId) ?? [];
    list.push(entry.receipt);
    ledgerByRequest.set(entry.requestId, list);
  }

  const count = (status: string) => cards.filter((c) => c.status === status).length;
  const terminal = count("executed") + count("failed") + count("rejected");
  const stuck = cards.filter((c) => c.status === "submitted" || c.status === "confirmed").length;

  let duplicates = 0;
  for (const receipts of ledgerByRequest.values()) {
    duplicates += Math.max(0, receipts.length - 1);
  }

  const misreported = cards.filter((c) => {
    const receipts = ledgerByRequest.get(c.requestId) ?? [];
    const deviceSucceeded = receipts.some((r) => r.status === "ok" || r.status === "partial");
    if (c.status === "failed" && deviceSucceeded) return true;
    if (c.status === "executed" && receipts.length === 0) return true;
    return false;
  });

  const pct = (x: number) => `${((x / n) * 100).toFixed(1)}%`;

  console.log(`\n故障注入压测  n=${n}  seed=${profile.seed}`);
  console.log(`画像: ok=${profile.ok} retryable=${profile.retryable} permanent=${profile.permanent} partial=${profile.partial} lost=${profile.lostReceipt}`);
  console.log(`\n【最终状态】`);
  console.log(`  executed    ${count("executed")}`);
  console.log(`  failed      ${count("failed")}`);
  console.log(`  submitted   ${count("submitted")}`);
  console.log(`  confirmed   ${count("confirmed")}`);
  console.log(`  rejected    ${count("rejected")}`);
  console.log(`\n【指标】`);
  console.log(`  最终一致率      ${pct(terminal)}  (${terminal}/${n})`);
  console.log(`  悬挂率          ${pct(stuck)}  (${stuck}/${n})，对账前 ${stuckBefore} 条`);
  console.log(`  重复副作用      ${duplicates} 条`);
  console.log(`  状态误报        ${misreported.length} 条`);
  console.log(`  人工接管        ${handoffs.length} 条`);
  console.log(`\n【对账】扫描 ${report.scanned}，采纳 ${report.adopted}，回退 ${report.resumed}，升级 ${report.escalated}`);

  if (misreported.length > 0) {
    console.log(`\n状态误报明细（前 5 条）：`);
    for (const c of misreported.slice(0, 5)) {
      const receipts = ledgerByRequest.get(c.requestId) ?? [];
      console.log(`  ${c.requestId}  系统=${c.status}  设备=${receipts.map((r) => r.status).join(",") || "无记录"}`);
    }
  }

  console.log("");
  await store.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});