/**
 * 文件日历设备的验收脚本：把"换设备只换适配器"跑成数字。
 *
 *   npm run device-check
 *   npm run device-check -- --n 100 --fail 0.3 --seed 7
 *   npm run device-check -- --lost 0.1
 *   npm run device-check -- --keep
 *
 * 做的事：造 n 张已确认的行动卡，经过故障注入（可重试 / 不可重试各占一半），
 * 由 Outbox 和 reconcile 推完，然后核对设备侧（目录里的 .ics）和系统状态。
 *
 * 验收四条：
 *   1. 执行成功数 + 明确失败数 = n，没有悬挂；
 *   2. 每张 executed 的卡在设备侧恰好一个文件；
 *   3. 记成 failed 的卡在设备侧没有文件（不可重试的失败从没碰过设备）；
 *   4. 每个文件的 UID 都对得上 requestId，能被自己的 ICS 解析器读回来。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { Store } from "../src/store/store.js";
import { seedState } from "../src/data/seed.js";
import { IcsFileDevice } from "../src/runtime/ics-file-device.js";
import { FaultyDevice } from "../src/runtime/faults.js";
import { Outbox } from "../src/runtime/outbox.js";
import { reconcile } from "../src/runtime/reconcile.js";
import { parseIcs } from "../src/ingest/calendar.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const n = Number(arg("n") ?? 50);
  const failRate = Number(arg("fail") ?? 0.3);
  const lostRate = Number(arg("lost") ?? 0);
  const seed = Number(arg("seed") ?? 42);
  const storePath = join(root, "data", "device-check.db");
  const calendarDir = join(root, "data", "device-check-calendar");

  await Store.reset(storePath);
  await rm(calendarDir, { recursive: true, force: true });

  const store = await Store.open(storePath);
  await store.seedIfEmpty(seedState);

  const device = new FaultyDevice(new IcsFileDevice({ dir: calendarDir }), {
    // 失败的一半算冲突可重试，一半算永久拒绝；lost 是"设备执行了但回执丢了"
    ok: Math.max(0, 1 - failRate - lostRate),
    retryable: failRate / 2,
    permanent: failRate / 2,
    partial: 0,
    lostReceipt: lostRate,
    seed,
  });
  const outbox = new Outbox(store, device, 2);

  const requestIds: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const kind = i % 5 === 0 ? "reminder" : "calendar_event";
    const card = await store.createAction({
      personId: "p_001",
      kind,
      title: `设备验收-${i}`,
      payload:
        kind === "reminder"
          ? { at: "2026-11-20T09:00:00+08:00" }
          : { at: "2026-11-20T19:00:00+08:00", durationMinutes: 90 },
      reason: "换设备只换适配器",
      sourceIds: ["ev_001"],
    });
    await store.updateAction(card.requestId, card.cardVersion, {
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
    });
    requestIds.push(card.requestId);
  }

  for (const requestId of requestIds) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
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

  const beforeReconcile = (await store.listActions("p_001")).filter(
    (c) => c.status === "submitted",
  ).length;
  const report = await reconcile(store, device, { olderThanMs: 0 });

  const cards = await store.listActions("p_001");
  const executed = cards.filter((c) => c.status === "executed");
  const failed = cards.filter((c) => c.status === "failed");
  const stuck = cards.filter((c) => c.status === "submitted" || c.status === "confirmed");
  const files = (await readdir(calendarDir)).filter((f) => f.endsWith(".ics"));
  const fileSet = new Set(files.map((f) => f.slice(0, -4)));

  const executedWithoutFile = executed.filter((c) => !fileSet.has(c.requestId));
  const failedWithFile = failed.filter((c) => fileSet.has(c.requestId));
  const orphanFiles = [...fileSet].filter((id) => !cards.some((c) => c.requestId === id));

  let badUid = 0;
  let unparsable = 0;
  for (const id of fileSet) {
    const raw = await readFile(join(calendarDir, `${id}.ics`), "utf8");
    const events = parseIcs(raw, new Date("2026-11-12T00:00:00.000Z"));
    if (events.length !== 1) {
      unparsable += 1;
      continue;
    }
    if (events[0]!.uid !== id) badUid += 1;
  }

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: "执行成功 + 明确失败 = 总数",
      ok: executed.length + failed.length === n,
      detail: `${executed.length} + ${failed.length} / ${n}`,
    },
    { name: "没有悬挂", ok: stuck.length === 0, detail: `对账前 ${beforeReconcile} 条，之后 ${stuck.length} 条` },
    {
      name: "executed 都有对应文件",
      ok: executedWithoutFile.length === 0,
      detail: executedWithoutFile.map((c) => c.requestId).join(",") || "无",
    },
    {
      name: "failed 都没有文件",
      ok: failedWithFile.length === 0,
      detail: failedWithFile.map((c) => c.requestId).join(",") || "无",
    },
    { name: "没有多余文件", ok: orphanFiles.length === 0, detail: orphanFiles.join(",") || "无" },
    { name: "文件自解析全部成功", ok: unparsable === 0, detail: `${fileSet.size} 个文件` },
    { name: "文件 UID 全部对得上", ok: badUid === 0, detail: `${badUid} 个不对` },
  ];

  console.log(`\n文件日历设备验收  n=${n}  失败率=${failRate}  丢回执率=${lostRate}  seed=${seed}`);
  console.log(`设备: ${device.id}`);
  console.log(
    `\n【状态】executed ${executed.length}   failed ${failed.length}   ` +
      `submitted ${cards.filter((c) => c.status === "submitted").length}   ` +
      `confirmed ${cards.filter((c) => c.status === "confirmed").length}`,
  );
  console.log(
    `【对账】扫描 ${report.scanned}，采纳 ${report.adopted}，回退 ${report.resumed}，升级 ${report.escalated}`,
  );
  if (lostRate > 0) {
    console.log("  注：丢回执的卡由 Outbox 当场查设备账本采纳，所以对账扫描通常是 0。");
  }
  console.log("");

  let failures = 0;
  for (const item of checks) {
    console.log(`  ${item.ok ? "✓" : "✗"} ${item.name}  ${item.detail}`);
    if (!item.ok) failures += 1;
  }

  await store.close();
  await rm(storePath, { force: true });
  if (!process.argv.includes("--keep")) {
    await rm(calendarDir, { recursive: true, force: true });
  } else {
    console.log(`\n保留设备目录：${calendarDir}`);
  }

  console.log(failures === 0 ? "\n验收通过 ✅" : `\n${failures} 项不通过 ❌`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});