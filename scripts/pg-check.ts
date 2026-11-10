/**
 * PostgreSQL 适配器验证：跑和 SQLite 完全相同的核心不变量。
 *
 *   npm run pg-check
 *   npm run pg-check -- --url postgresql://relation:relation@localhost:5432/relation
 *
 * 每次运行前会清空所有表，所以别指向有真实数据的库。
 */
import pg from "pg";
import { openStore } from "../src/store/store.js";
import { GenerationConflictError } from "../src/store/port.js";
import { seedState } from "../src/data/seed.js";
import { Outbox } from "../src/runtime/outbox.js";
import { MockDevice } from "../src/runtime/device.js";
import { reconcile } from "../src/runtime/reconcile.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let failures = 0;
function check(name: string, ok: unknown, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

const TABLES = [
  "handoff", "access_log", "compaction", "conflict", "survey", "session",
  "idempotency", "action", "candidate", "memory_item", "memory_doc", "evidence", "person",
];

async function main(): Promise<void> {
  const url =
    arg("url") ?? process.env.DATABASE_URL ?? "postgresql://relation:relation@localhost:5432/relation";

  // 先 openStore 建表，再清空 —— 空库上还没有表可 TRUNCATE
  const store = await openStore({ url });

  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
  await admin.end();

  console.log("\n[1] 种子与读取");
  await store.seedIfEmpty(seedState);
  const person = await store.getPerson("p_001");
  check("联系人姓名正确", person.name === "张三", person.name);
  const doc0 = await store.getMemoryDoc("p_001");
  check("种子记忆 1 条", doc0.items.length === 1, doc0.items.length);
  check("generation = 1", doc0.generation === 1, doc0.generation);
  const evidence = await store.listEvidence("p_001");
  check("证据 4 条", evidence.length === 4, evidence.length);

  console.log("\n[2] 并发 CAS：两个连接同时写");
  const storeA = await openStore({ url });
  const storeB = await openStore({ url });
  const genA = (await storeA.getMemoryDoc("p_001")).generation;
  const genB = (await storeB.getMemoryDoc("p_001")).generation;
  check("两个连接读到同一版本", genA === genB, `${genA}/${genB}`);

  const race = await Promise.allSettled([
    storeA.commitMemory("p_001", genA, [{ text: "并发写入 A", sourceIds: ["ev_001"] }]),
    storeB.commitMemory("p_001", genB, [{ text: "并发写入 B", sourceIds: ["ev_001"] }]),
  ]);
  const ok = race.filter((r) => r.status === "fulfilled").length;
  const conflict = race.filter(
    (r) => r.status === "rejected" && r.reason instanceof GenerationConflictError,
  ).length;
  check("恰好一个成功", ok === 1, race.map((r) => r.status));
  check("另一个抛 GenerationConflictError", conflict === 1);
  const afterRace = await store.getMemoryDoc("p_001");
  check("generation 只加 1", afterRace.generation === 2, afterRace.generation);
  check("只落库一条", afterRace.items.filter((i) => i.text.startsWith("并发写入")).length === 1);
  await storeA.close();
  await storeB.close();

  console.log("\n[3] 幂等表：唯一键");
  const record = {
    requestId: "req_pg_idem",
    cardVersion: 1,
    submittedAt: new Date().toISOString(),
    receipt: {
      requestId: "req_pg_idem",
      deviceId: "test",
      status: "ok" as const,
      at: new Date().toISOString(),
    },
  };
  check("第一次写入成功", (await store.recordReceipt(record)) === true);
  check("第二次被唯一键挡下", (await store.recordReceipt(record)) === false);

  console.log("\n[4] 行动卡全链路");
  const card = await store.createAction({
    personId: "p_001",
    kind: "reminder",
    title: "PG 测试提醒",
    payload: {},
    reason: "测试",
    sourceIds: ["ev_001"],
  });
  const confirmed = await store.updateAction(card.requestId, card.cardVersion, {
    status: "confirmed",
  });
  const outbox = new Outbox(store, new MockDevice("data/_pg-check-ledger.jsonl"));
  const submitted = await outbox.submit(confirmed);
  check("执行成功", submitted.card.status === "executed", submitted.card.status);
  check("重复提交命中幂等", (await outbox.submit(submitted.card)).reused === true);

  console.log("\n[5] 外键：问卷必须挂在真实会话上");
  let fkBlocked = false;
  try {
    await store.createSurvey({
      sessionId: "sess_not_exist",
      toolCallId: "call_x",
      personId: "p_001",
      questions: [{ id: "q", question: "?" }],
    });
  } catch {
    fkBlocked = true;
  }
  check("不存在的会话被外键拒绝", fkBlocked);

  console.log("\n[6] 跨人证据校验");
  let crossBlocked = false;
  try {
    await store.createAction({
      personId: "p_001",
      kind: "reminder",
      title: "伪造依据",
      payload: {},
      reason: "x",
      sourceIds: ["ev_101"],
    });
  } catch {
    crossBlocked = true;
  }
  check("引用别人证据被拒", crossBlocked);

  console.log("\n[7] 对账采纳");
  const device = new MockDevice("data/_pg-check-ledger.jsonl");
  const stuck = await store.createAction({
    personId: "p_001",
    kind: "reminder",
    title: "崩溃遗留",
    payload: {},
    reason: "测试",
    sourceIds: ["ev_001"],
  });
  const stuckConfirmed = await store.updateAction(stuck.requestId, stuck.cardVersion, {
    status: "confirmed",
  });
  await device.execute(stuckConfirmed); // 设备侧留下记录
  await store.updateAction(stuck.requestId, (await store.getAction(stuck.requestId)).cardVersion, {
    status: "submitted",
    submittedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const report = await reconcile(store, device, { olderThanMs: 0 });
  check("采纳 1 条", report.adopted === 1, report.items);
  check("状态推进为 executed", (await store.getAction(stuck.requestId)).status === "executed");

  console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
  await store.close();
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});