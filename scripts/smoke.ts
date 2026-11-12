import { rm, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Store, GenerationConflictError } from "../src/store/store.js";
import { seedState } from "../src/data/seed.js";
import { MockDevice } from "../src/runtime/device.js";
import { Outbox } from "../src/runtime/outbox.js";
import { RunGuard, DEFAULT_BUDGET } from "../src/agent/guard.js";
import { checkToolRules } from "../src/agent/rules.js";
import { repairToolPairing, injectSurveyResults } from "../src/session/resume.js";
import { compactMessages, type SessionSummary } from "../src/session/summary.js";
import { buildMemorySnapshot } from "../src/agent/snapshot.js";
import { createTools } from "../src/agent/tools.js";
import { ingestEvidence } from "../src/ingest/evidence.js";
import { ingestIcs, parseIcs } from "../src/ingest/calendar.js";
import { ingestScreenshot } from "../src/ingest/screenshot.js";
import { parseOcrJson, createVisionExtractor } from "../src/ingest/ocr.js";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@mariozechner/pi-ai";
import { runSession } from "../src/session/run.js";
import { reconcile } from "../src/runtime/reconcile.js";
import { confirmAction } from "../src/runtime/confirm.js";
import { executeConfirmed } from "../src/runtime/executor.js";
import type { DeviceAdapter } from "../src/runtime/device.js";
import type { ActionCard, Receipt } from "../src/domain/types.js";
import { IcsFileDevice } from "../src/runtime/ics-file-device.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let failures = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

async function main(): Promise<void> {
  // ---------- 1. toolCall / toolResult 配对修复 ----------
  console.log("\n[1] 恢复会话：toolCall / toolResult 配对");
  const assistantWithTwoCalls = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call_a", name: "get_evidence_text", arguments: {} },
      { type: "toolCall", id: "call_b", name: "search_evidence", arguments: {} },
    ],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "toolUse",
    timestamp: 1,
  } as unknown as AgentMessage;
  const orphanResult = {
    role: "toolResult",
    toolCallId: "call_ghost",
    toolName: "x",
    content: [{ type: "text", text: "没有对应的 toolCall" }],
    isError: false,
    timestamp: 3,
  } as unknown as AgentMessage;
  const oneResult = {
    role: "toolResult",
    toolCallId: "call_a",
    toolName: "get_evidence_text",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 2,
  } as unknown as AgentMessage;

  const repaired = repairToolPairing([assistantWithTwoCalls, oneResult, orphanResult]);
  const results = repaired.messages.filter((m) => m.role === "toolResult") as Array<{
    toolCallId: string;
    isError: boolean;
  }>;
  check("孤儿 toolResult 被丢弃", !results.some((r) => r.toolCallId === "call_ghost"));
  check("缺失结果的 toolCall 被补成错误结果", results.some((r) => r.toolCallId === "call_b" && r.isError));
  check("真实结果保留", results.some((r) => r.toolCallId === "call_a" && !r.isError));
  check("每个 toolCall 都有且只有一个结果", repaired.messages.length === 3, repaired.messages.length);

  // ---------- 2. 上下文压缩不切断配对 ----------
  console.log("\n[2] 上下文压缩：切割点落在 user 边界");
  const long: AgentMessage[] = [];
  for (let i = 0; i < 20; i += 1) {
    long.push({ role: "user", content: `u${i}`, timestamp: i } as unknown as AgentMessage);
    long.push({ role: "assistant", content: [], api: "faux", provider: "faux", model: "f", usage: {} , stopReason: "stop", timestamp: i } as unknown as AgentMessage);
  }
  const compacted = await compactMessages(long, { maxMessages: 6 });
  check("压缩后长度受限", compacted.messages.length <= 6, compacted.messages.length);
  check("保留首条用户消息", (compacted.messages[0] as { content: string }).content === "u0");
  check(
    "截断时告诉模型原文可检索",
    JSON.stringify(compacted.messages).includes("recall_history"),
  );
  check(
    "切割点落在 user 消息前",
    (compacted.messages[2] as { role: string; content: string }).role === "user",
  );

  // ---------- 3. 护栏：重复调用拦截 ----------
  console.log("\n[3] 运行护栏：重复调用 / 次数上限");
  let exceeded = "";
  const guard = new RunGuard({ ...DEFAULT_BUDGET, maxRepeats: 3 }, (r) => {
    exceeded = r;
  });
  const call = { toolCall: { name: "search_evidence", arguments: { query: "生日" } }, args: { query: "生日" } };
  const outcomes = [guard.beforeToolCall(call), guard.beforeToolCall(call), guard.beforeToolCall(call), guard.beforeToolCall(call)];
  check("前三次放行", outcomes.slice(0, 3).every((o) => o === undefined));
  check("第四次被拦截", outcomes[3]?.block === true, outcomes[3]);
  check("统计到 3 次工具调用", guard.stats.toolCalls === 3, guard.stats.toolCalls);

  const guard2 = new RunGuard({ ...DEFAULT_BUDGET, maxToolCalls: 2 }, () => {});
  const other = (q: string) => ({ toolCall: { name: "search_evidence", arguments: { query: q } }, args: { query: q } });
  guard2.beforeToolCall(other("a"));
  guard2.beforeToolCall(other("b"));
  const blocked = guard2.beforeToolCall(other("c"));
  check("超过总次数上限被拦截", blocked?.block === true, blocked);

  // ---------- 4. 设备回执失败 ----------
  console.log("\n[4] 设备回执失败：状态与幂等");
  const statePath = join(root, "data", "smoke-state.db");
  const ledgerPath = join(root, "data", "smoke-ledger.jsonl");
  await Store.reset(statePath);
  await rm(ledgerPath, { force: true });
  const store = await Store.open(statePath);
  await store.seedIfEmpty(seedState);

  const card = await store.createAction({
    personId: "p_001",
    kind: "calendar_event",
    title: "改期评审会",
    payload: { at: "2026-11-02T14:00:00+08:00" },
    reason: "张三上午复查",
    sourceIds: ["ev_001", "ev_002"],
  });
  const confirmed = await store.updateAction(card.requestId, card.cardVersion, {
    status: "confirmed",
    confirmedAt: new Date().toISOString(),
  });

  const flaky = new MockDevice(ledgerPath, { failFirstN: 1 });
  const outbox = new Outbox(store, flaky);
  const first = await outbox.submit(confirmed);
  check("首次回执为 failed", first.receipt.status === "failed", first.receipt);
  check("卡片状态转为 failed", first.card.status === "failed", first.card.status);

  const second = await outbox.submit(await store.getAction(card.requestId));
  check("失败回执不触发盲目重试（命中幂等表）", second.reused === true);
  check("卡片不会变成 executed", (await store.getAction(card.requestId)).status === "failed");

  // 未确认的卡不能提交
  console.log("\n[5] 未确认的行动卡不能提交");
  const another = await store.createAction({
    personId: "p_001",
    kind: "draft_message",
    title: "发消息",
    payload: {},
    reason: "测试",
    sourceIds: ["ev_001"],
  });
  let refused = false;
  try {
    await outbox.submit(another);
  } catch (err) {
    refused = /只有 confirmed 才能提交/.test((err as Error).message);
  }
  check("proposed 状态提交被拒绝", refused);

  console.log("\n[6] 证据 TTL：过期证据不暴露正文");
  const snap = await buildMemorySnapshot(store, "p_001", new Date("2026-10-31T12:00:00+08:00"));
  const expiredEv = snap.evidence.find((e) => e.evidenceId === "ev_004");
  check("过期证据标记 expired", expiredEv?.expired === true, expiredEv);
  check("过期后只给摘要", expiredEv?.preview.includes("出差") === true && !expiredEv?.preview.includes("OCR"), expiredEv?.preview);
  check("未过期证据仍给正文预览", snap.evidence.find((e) => e.evidenceId === "ev_001")?.expired === false);
  check("快照带时间与时区", Boolean(snap.now) && Boolean(snap.timezone));
  check("快照带关系目标", snap.person.relationshipGoal?.includes("合作") === true);

  console.log("\n[7] 可恢复暂停点：问卷答案注入回 toolCall");
  const resumeSession = "sess_resume";
  // 问卷有外键挂到 session，必须先建会话 —— 真实流程里 runSession 也是先落会话再跑
  await store.saveSession({
    sessionId: resumeSession,
    personId: "p_001",
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const assistantAsk = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_ask", name: "ask_user", arguments: {} }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "toolUse",
    timestamp: 1,
  } as unknown as AgentMessage;
  const survey = await store.createSurvey({
    sessionId: resumeSession,
    toolCallId: "call_ask",
    personId: "p_001",
    questions: [{ id: "when", question: "什么时候提醒？", options: ["周一上午", "周日晚上"] }],
  });
  const injected = injectSurveyResults([assistantAsk], [
    { toolCallId: "call_ask", answers: { when: "周日晚上" } },
  ]);
  // 真实流程里 CLI 会先落库答案再注入，这里保持同样顺序
  await store.answerSurvey(survey.surveyId, { when: "周日晚上" });
  const afterRepair = repairToolPairing(injected.messages);
  const surveyResult = afterRepair.messages.find((m) => m.role === "toolResult") as
    | { content: Array<{ text: string }>; isError: boolean }
    | undefined;
  check("注入了 1 条问卷结果", injected.injected === 1, injected.injected);
  check("配对修复不再补错误结果", afterRepair.repaired === 0, afterRepair.repaired);
  check("答案内容正确", surveyResult?.content[0]?.text.includes("周日晚上") === true);
  check("结果不是错误态", surveyResult?.isError === false);
  check("问卷已标记回答", (await store.getSurvey(survey.surveyId)).answers !== undefined);

  console.log("\n[8] 回执：partial 与可重试失败");
  const partialCard = await store.createAction({
    personId: "p_001",
    kind: "calendar_event",
    title: "部分成功的日程",
    payload: {},
    reason: "测试 partial",
    sourceIds: ["ev_001"],
  });
  const partialConfirmed = await store.updateAction(partialCard.requestId, partialCard.cardVersion, {
    status: "confirmed",
  });
  const partialOutbox = new Outbox(store, new MockDevice(ledgerPath, { partialFirstN: 1 }));
  const partialResult = await partialOutbox.submit(partialConfirmed);
  check("partial 回执保留在卡上", partialResult.receipt.status === "partial", partialResult.receipt);
  check("partial 记为 executed（设备确实做了）", partialResult.card.status === "executed", partialResult.card.status);

  const conflictCard = await store.createAction({
    personId: "p_001",
    kind: "calendar_event",
    title: "时段冲突的日程",
    payload: {},
    reason: "测试可重试",
    sourceIds: ["ev_002"],
  });
  const conflictConfirmed = await store.updateAction(conflictCard.requestId, conflictCard.cardVersion, {
    status: "confirmed",
  });
  const retryOutbox = new Outbox(
    store,
    new MockDevice(ledgerPath, { failFirstN: 1, failureKind: "conflict" }),
    2,
  );
  const firstTry = await retryOutbox.submit(conflictConfirmed);
  check("冲突类失败被标记 retryable", firstTry.receipt.retryable === true && firstTry.card.status === "failed");
  const secondTry = await retryOutbox.submit(await store.getAction(conflictCard.requestId));
  check("可重试失败会真的重试", secondTry.reused === false && secondTry.receipt.status === "ok", secondTry.receipt);
  check("重试后卡片被执行", (await store.getAction(conflictCard.requestId)).status === "executed");
  check("attempts 计数为 2", (await store.getAction(conflictCard.requestId)).attempts === 2);

  console.log("\n[9] 压缩账本：generation CAS");
  const firstCompaction = await store.recordCompaction("sess_compact", 0, {
    droppedMessages: 10,
    keptMessages: 6,
    at: new Date().toISOString(),
  });
  check("首次压缩 generation=1", firstCompaction.generation === 1);
  let compactionConflict = false;
  try {
    await store.recordCompaction("sess_compact", 0, {
      droppedMessages: 12,
      keptMessages: 6,
      at: new Date().toISOString(),
    });
  } catch {
    compactionConflict = true;
  }
  check("过期 generation 压缩被拒", compactionConflict);

  console.log("\n[10] 证据入库：去重 / TTL / 摘要");
  const shot = {
    personId: "p_001",
    kind: "screenshot" as const,
    capturedAt: "2026-10-30T19:20:00+08:00",
    title: "微信截图：周末聚会",
    content: "【OCR】张三：周六下午在国贸那边聚一下？我四点还得走。",
    sourceRef: "screenshots/test.png",
  };
  const shotIngestAt = new Date("2026-10-31T12:00:00+08:00");
  const firstShot = await ingestEvidence(store, shot, shotIngestAt);
  check("首次导入新增", firstShot.created === true);
  check(
    "截图保留期 = 入库时间 + 24h",
    firstShot.expiresAt ===
      new Date(shotIngestAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    firstShot.expiresAt,
  );
  check("入库时就把摘要生成好", Boolean(firstShot.evidence.summary), firstShot.evidence.summary);

  const secondShot = await ingestEvidence(store, shot, shotIngestAt);
  check(
    "同一份材料重复导入被去重",
    secondShot.created === false && secondShot.evidence.evidenceId === firstShot.evidence.evidenceId,
  );

  const note = await ingestEvidence(store, { ...shot, kind: "note", content: "换一段内容", title: "手记" });
  check("手记不设过期", note.expiresAt === undefined);

  console.log("\n[11] 访问审计与人工接管");
  const e2eState = join(root, "data", "smoke-e2e.db");
  await Store.reset(e2eState);
  const e2eStore = await Store.open(e2eState);
  await e2eStore.seedIfEmpty(seedState);

  const reg = registerFauxProvider({});
  reg.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("propose_action", {
          kind: "reminder",
          title: "会失败的提醒",
          payload: { at: "2026-11-20T09:00:00+08:00" },
          reason: "测试接管",
          sourceIds: ["ev_001"],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("我试了一下，但没成功。")]),
  ]);

  const failingOutbox = new Outbox(
    e2eStore,
    new MockDevice(join(root, "data", "smoke-e2e-ledger.jsonl"), {
      failFirstN: 99,
      failureKind: "unknown",
    }),
  );

  const e2e = await runSession({
    store: e2eStore,
    personId: "p_001",
    goal: "提醒张三",
    model: reg.getModel(),
    survey: async () => ({}),
    confirm: async () => true,
    review: async () => true,
    outbox: failingOutbox,
  });

  check("设备失败触发人工接管", e2e.handoffs.length === 1, e2e.handoffs);
  check("接管记录落库", (await e2eStore.listOpenHandoffs("p_001")).length === 1);
  const access = await e2eStore.listAccess({ sessionId: e2e.sessionId });
  check("快照读取留痕", access.some((a) => a.kind === "snapshot" && a.actor === "host"), access.map((a) => a.kind));
  check("用量被统计", e2e.usage.totalTokens >= 0 && typeof e2e.usage.input === "number");
  reg.unregister();

  console.log("\n[12] 崩溃对账：submitted 且无回执的卡");
  const recState = join(root, "data", "smoke-reconcile.db");
  const recLedger = join(root, "data", "smoke-reconcile.dbl");
  await Store.reset(recState);
  await rm(recLedger, { force: true });
  const recStore = await Store.open(recState);
  await recStore.seedIfEmpty(seedState);
  const recDevice = new MockDevice(recLedger);

  const makeStuck = async (title: string) => {
    const c = await recStore.createAction({
      personId: "p_001",
      kind: "reminder",
      title,
      payload: {},
      reason: "对账测试",
      sourceIds: ["ev_001"],
    });
    const confirmedCard = await recStore.updateAction(c.requestId, c.cardVersion, {
      status: "confirmed",
    });
    return confirmedCard;
  };

  // A. 设备真的执行了，但回执没落盘 → 采纳
  const cardA = await makeStuck("设备已执行但回执丢失");
  await recDevice.execute(cardA); // 直接调设备，制造"设备侧有记录"
  await recStore.updateAction(cardA.requestId, cardA.cardVersion, {
    status: "submitted",
    submittedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const reportA = await reconcile(recStore, recDevice, { olderThanMs: 0 });
  check("A 被判为采纳", reportA.adopted === 1, reportA.items);
  check("A 状态推进为 executed", (await recStore.getAction(cardA.requestId)).status === "executed");
  check("A 回执已补写", (await recStore.getReceipt(cardA.requestId)) !== undefined);

  // B. 设备没收到 → 回退到 confirmed
  const cardB = await makeStuck("设备没收到");
  await recStore.updateAction(cardB.requestId, cardB.cardVersion, {
    status: "submitted",
    submittedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const reportB = await reconcile(recStore, recDevice, { olderThanMs: 0 });
  check("B 被判为回退", reportB.resumed === 1, reportB.items);
  check("B 回到 confirmed", (await recStore.getAction(cardB.requestId)).status === "confirmed");

  // C. 设备不支持查询 → 升级人工
  const cardC = await makeStuck("设备不支持查询");
  await recStore.updateAction(cardC.requestId, cardC.cardVersion, {
    status: "submitted",
    submittedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const noLookupDevice: DeviceAdapter = {
    id: "no-lookup",
    execute: async () => ({ requestId: "x", deviceId: "no-lookup", status: "ok", at: new Date().toISOString() }),
  };
  const reportC = await reconcile(recStore, noLookupDevice, { olderThanMs: 0 });
  check("C 被判为升级", reportC.escalated === 1, reportC.items);
  check("C 生成人工接管", (await recStore.listOpenHandoffs("p_001")).length >= 1);
  check("C 状态仍是 submitted（不瞎改）", (await recStore.getAction(cardC.requestId)).status === "submitted");

  console.log("\n[13] 数据库级并发：两个连接，一个成功一个冲突");
  const dbPath = join(root, "data", "smoke-concurrent.db");
  await Store.reset(dbPath);
  const s1 = await Store.open(dbPath);
  await s1.seedIfEmpty(seedState);
  const s2 = await Store.open(dbPath); // 第二个连接，模拟另一个进程

  const genA = (await s1.getMemoryDoc("p_001")).generation;
  const genB = (await s2.getMemoryDoc("p_001")).generation;
  check("两个连接读到同一版本", genA === genB && genA === 1, `${genA}/${genB}`);

  const raceResults = await Promise.allSettled([
    s1.commitMemory("p_001", genA, [{ text: "并发写入 A", sourceIds: ["ev_001"] }]),
    s2.commitMemory("p_001", genB, [{ text: "并发写入 B", sourceIds: ["ev_001"] }]),
  ]);
  const fulfilled = raceResults.filter((r) => r.status === "fulfilled").length;
  const conflicted = raceResults.filter(
    (r) => r.status === "rejected" && r.reason instanceof GenerationConflictError,
  ).length;
  check("恰好一个成功", fulfilled === 1, raceResults.map((r) => r.status));
  check("另一个抛 GenerationConflictError", conflicted === 1);

  const after = await s1.getMemoryDoc("p_001");
  check("generation 只加 1", after.generation === 2, after.generation);
  check("只有一条并发写入落库", after.items.filter((i) => i.text.startsWith("并发写入")).length === 1);

  const receipt = {
    requestId: "req_concurrent",
    cardVersion: 1,
    submittedAt: new Date().toISOString(),
    receipt: {
      requestId: "req_concurrent",
      deviceId: "test",
      status: "ok" as const,
      at: new Date().toISOString(),
    },
  };
  const firstReceipt = await s1.recordReceipt(receipt);
  const secondReceipt = await s2.recordReceipt(receipt);
  check("幂等表第一次写入成功", firstReceipt === true);
  check("第二次被唯一索引挡下", secondReceipt === false);

  await s1.close();
  await s2.close();

  console.log("\n[14] 候选写入：成功与冲突都必须保持一致");
  const failState = join(root, "data", "smoke-memfail.db");
  const failLedger = join(root, "data", "smoke-memfail.jsonl");
  await Store.reset(failState);
  await rm(failLedger, { force: true });

  const failStore = await Store.open(failState);
  await failStore.seedIfEmpty(seedState);
  const itemsBefore = (await failStore.getMemoryDoc("p_001")).items.length;

  // 成功路径：写记忆 + 标记通过是一次调用，落在一个事务里
  const okCandidate = await failStore.createCandidate({
    personId: "p_001",
    text: "成功路径候选",
    sourceIds: ["ev_001"],
  });
  await failStore.commitCandidate(
    okCandidate.candidateId,
    (await failStore.getMemoryDoc("p_001")).generation,
  );
  check(
    "成功后候选变 approved",
    (await failStore.getCandidate(okCandidate.candidateId)).status === "approved",
  );
  const itemsAfterSuccess = (await failStore.getMemoryDoc("p_001")).items.length;
  check("成功后记忆 +1", itemsAfterSuccess === itemsBefore + 1, itemsAfterSuccess);

  // 冲突路径：原型链上包一层，只让 commitCandidate 必失败
  const failingStore = Object.create(failStore) as typeof failStore;
  failingStore.commitCandidate = async () => {
    throw new GenerationConflictError("p_001", 0, 0);
  };

  const failReg = registerFauxProvider({});
  failReg.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("propose_memory", {
          text: "候选写入失败测试",
          sourceIds: ["ev_001"],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("好的。")]),
  ]);

  let threw = false;
  try {
    await runSession({
      store: failingStore,
      personId: "p_001",
      goal: "记一下",
      model: failReg.getModel(),
      survey: async () => ({}),
      confirm: async () => true,
      review: async () => true,
      outbox: new Outbox(failStore, new MockDevice(failLedger)),
    });
  } catch {
    threw = true;
  }
  failReg.unregister();

  const failedCandidate = (await failStore.listCandidates("p_001")).find(
    (c) => c.text === "候选写入失败测试",
  );
  check("写入失败会让会话报错", threw);
  check("候选仍是 pending（可重试）", failedCandidate?.status === "pending", failedCandidate?.status);
  check(
    "长期记忆没有变化",
    (await failStore.getMemoryDoc("p_001")).items.length === itemsAfterSuccess,
  );

  // ---------- 15. 异步确认：提议、确认、执行分三次进程 ----------
  console.log("\n[15] 异步确认：关掉进程，下一次启动再确认并执行");
  const asyncState = join(root, "data", "smoke-async.db");
  const asyncLedger = join(root, "data", "smoke-async.jsonl");
  await Store.reset(asyncState);
  await rm(asyncLedger, { force: true });

  const proposeStore = await Store.open(asyncState);
  await proposeStore.seedIfEmpty(seedState);

  const asyncReg = registerFauxProvider({});
  asyncReg.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("propose_action", {
          kind: "reminder",
          title: "明天问问她面试结果",
          payload: { at: "2026-11-10T09:00:00+08:00" },
          reason: "她明天面试，问一句比不问好",
          sourceIds: ["ev_001"],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("提案生成好了，等你确认。")]),
  ]);

  let syncHandlersCalled = false;
  const deferred = await runSession({
    store: proposeStore,
    personId: "p_001",
    goal: "明天提醒我问一下",
    model: asyncReg.getModel(),
    survey: async () => ({}),
    confirm: async () => {
      syncHandlersCalled = true;
      return true;
    },
    review: async () => {
      syncHandlersCalled = true;
      return true;
    },
    outbox: new Outbox(proposeStore, new MockDevice(asyncLedger)),
    deferConfirm: true,
    deferReview: true,
  });
  asyncReg.unregister();

  check("会话返回时卡还是 proposed", deferred.finalCards[0]?.status === "proposed", deferred.finalCards[0]?.status);
  check("defer 时没有调用同步确认/审核", syncHandlersCalled === false);
  check("没有产生回执", deferred.receipts.length === 0);

  // 模拟进程退出
  await proposeStore.close();

  // 第二次启动：全新的 store 实例
  const runStore = await Store.open(asyncState);
  const reopened = (await runStore.listActions("p_001")).filter((c) => c.status === "proposed");
  check("重启后仍能看到待确认的卡", reopened.length === 1, reopened.length);
  const asyncCardA = reopened[0]!;

  // 版本号不对的确认必须被拒
  let staleVersionRejected = false;
  try {
    await confirmAction(runStore, {
      requestId: asyncCardA.requestId,
      cardVersion: asyncCardA.cardVersion + 10,
      decision: "approve",
    });
  } catch {
    staleVersionRejected = true;
  }
  check("版本号不符的确认被拒", staleVersionRejected);

  // 确认前改提案：版本递增，手里的旧确认作废
  const amended = await runStore.amendAction(asyncCardA.requestId, asyncCardA.cardVersion, {
    payload: { at: "2026-11-11T09:00:00+08:00" },
  });
  check("修改后版本号 +1", amended.cardVersion === asyncCardA.cardVersion + 1, amended.cardVersion);
  check("修改后仍是 proposed", amended.status === "proposed");

  let oldVersionRejected = false;
  try {
    await confirmAction(runStore, {
      requestId: amended.requestId,
      cardVersion: asyncCardA.cardVersion,
      decision: "approve",
    });
  } catch {
    oldVersionRejected = true;
  }
  check("改版前的版本号确认已失效", oldVersionRejected);

  const confirmedCard = await confirmAction(runStore, {
    requestId: amended.requestId,
    cardVersion: amended.cardVersion,
    decision: "approve",
  });
  check("正确版本的确认生效", confirmedCard.status === "confirmed");

  const asyncOutcomes = await executeConfirmed(
    runStore,
    new Outbox(runStore, new MockDevice(asyncLedger)),
  );
  check("执行后状态是 executed", asyncOutcomes[0]?.status === "executed", asyncOutcomes[0]?.status);
  check("拿到 ok 回执", asyncOutcomes[0]?.receipt?.status === "ok", asyncOutcomes[0]?.receipt?.status);

  const rerun = await executeConfirmed(runStore, new Outbox(runStore, new MockDevice(asyncLedger)));
  check("再跑一次执行器什么都不做", rerun.length === 0, rerun.length);

  // 两个执行器同时启动同一批 confirmed 卡
  const asyncCardB = await runStore.createAction({
    personId: "p_001",
    sessionId: "s_async",
    kind: "reminder",
    title: "同一张卡被两个执行器抢",
    payload: { at: "2026-11-12T09:00:00+08:00" },
    reason: "并发执行测试",
    sourceIds: ["ev_001"],
  });
  await confirmAction(runStore, {
    requestId: asyncCardB.requestId,
    cardVersion: asyncCardB.cardVersion,
    decision: "approve",
  });

  const runStore2 = await Store.open(asyncState);
  const [left, right] = await Promise.all([
    executeConfirmed(runStore, new Outbox(runStore, new MockDevice(asyncLedger))),
    executeConfirmed(runStore2, new Outbox(runStore2, new MockDevice(asyncLedger))),
  ]);
  check("两个执行器至少有一个处理了这张卡", left.length + right.length >= 1, left.length + right.length);

  const ledgerRaw = await readFile(asyncLedger, "utf8");
  const ledgerHits = ledgerRaw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { card: { requestId: string } })
    .filter((entry) => entry.card.requestId === asyncCardB.requestId);
  check("设备侧只收到一次", ledgerHits.length === 1, ledgerHits.length);

  const finalB = await runStore.getAction(asyncCardB.requestId);
  check("卡最终停在 executed", finalB.status === "executed", finalB.status);

  await runStore2.close();
  await runStore.close();

  // ---------- 16. 状态未知：可能已执行不能写成确定失败 ----------
  console.log("\n[16] 回执丢失：可能已执行 ≠ 确定失败");
  const unknownState = join(root, "data", "smoke-unknown.db");
  await Store.reset(unknownState);
  const unknownStore = await Store.open(unknownState);
  await unknownStore.seedIfEmpty(seedState);

  const makeConfirmed = async (title: string) => {
    const card = await unknownStore.createAction({
      personId: "p_001",
      kind: "reminder",
      title,
      payload: { at: "2026-11-21T09:00:00+08:00" },
      reason: "回执丢失测试",
      sourceIds: ["ev_001"],
    });
    return confirmAction(unknownStore, {
      requestId: card.requestId,
      cardVersion: card.cardVersion,
      decision: "approve",
    });
  };

  // 设备没有查询能力：异常之后状态未知，不能猜
  const blindDevice: DeviceAdapter = {
    id: "blind-device",
    execute: async () => {
      throw new Error("网络中断，回执丢失");
    },
  };
  const blindCard = await makeConfirmed("无查询能力");
  await new Outbox(unknownStore, blindDevice).submit(blindCard);

  check(
    "查不到设备时卡留在 submitted",
    (await unknownStore.getAction(blindCard.requestId)).status === "submitted",
  );
  check(
    "状态未知时不写回执",
    (await unknownStore.getReceipt(blindCard.requestId)) === undefined,
  );
  check(
    "对账能扫到这张卡",
    (await unknownStore.listStuckActions({ olderThanMs: 0 })).some(
      (c) => c.requestId === blindCard.requestId,
    ),
  );

  // 设备能查询，并且账本里确实有记录：按设备事实推进
  const recoveringCard = await makeConfirmed("设备已执行");
  const foundReceipt: Receipt = {
    requestId: recoveringCard.requestId,
    deviceId: "recovering-device",
    status: "ok",
    at: new Date().toISOString(),
  };
  const recoveringDevice: DeviceAdapter = {
    id: "recovering-device",
    execute: async () => {
      throw new Error("回执在返回路上丢了");
    },
    lookup: async (requestId) => (requestId === recoveringCard.requestId ? foundReceipt : undefined),
  };
  await new Outbox(unknownStore, recoveringDevice).submit(recoveringCard);

  check(
    "查到设备回执后按回执推进",
    (await unknownStore.getAction(recoveringCard.requestId)).status === "executed",
  );
  check(
    "回执被补写",
    (await unknownStore.getReceipt(recoveringCard.requestId))?.status === "ok",
  );

  // 上一轮留下的失败回执，不能证明这一轮已经有结论
  const retriedCard = await makeConfirmed("重试后的未知状态");
  const afterSubmit = await unknownStore.updateAction(
    retriedCard.requestId,
    retriedCard.cardVersion,
    { status: "submitted", submittedAt: new Date().toISOString() },
  );
  await unknownStore.recordReceipt({
    requestId: retriedCard.requestId,
    cardVersion: afterSubmit.cardVersion - 1,
    submittedAt: afterSubmit.submittedAt ?? new Date().toISOString(),
    receipt: {
      requestId: retriedCard.requestId,
      deviceId: "old-device",
      status: "failed",
      at: new Date().toISOString(),
      retryable: true,
    },
  });
  const withFreshReceipt = await unknownStore.listStuckActions({ olderThanMs: 0 });
  check(
    "本轮已有回执的卡不算悬挂",
    !withFreshReceipt.some((c) => c.requestId === retriedCard.requestId),
  );

  await unknownStore.updateAction(retriedCard.requestId, afterSubmit.cardVersion, {
    status: "submitted",
    submittedAt: new Date(Date.now() - 1).toISOString(),
  });
  const afterRetry = await unknownStore.listStuckActions({ olderThanMs: 0 });
  check(
    "上一轮回执不能证明本轮，仍算悬挂",
    afterRetry.some((c) => c.requestId === retriedCard.requestId),
  );

  await unknownStore.close();

  console.log("\n[17] 参数规则：拦下来的原因要能让模型改对");
  const baseAction = {
    kind: "reminder",
    title: "提醒张三复查",
    payload: { at: "2026-11-20T09:00:00+08:00" },
    reason: "ev_001 提到复查",
    sourceIds: ["ev_001"],
  };
  const violated = (tool: string, args: unknown) => checkToolRules(tool, args)?.rule;

  check("空标题被拦", violated("propose_action", { ...baseAction, title: "   " }) === "title-empty");
  check(
    "超长标题被拦",
    violated("propose_action", { ...baseAction, title: "长".repeat(81) }) === "title-too-long",
  );
  check(
    "reminder 缺 at 被拦",
    violated("propose_action", { ...baseAction, payload: {} }) === "missing-at",
  );
  check(
    "at 不带时区被拦",
    violated("propose_action", { ...baseAction, payload: { at: "2026-11-20T09:00:00" } }) === "bad-at",
  );
  check("at 带偏移放行", violated("propose_action", baseAction) === undefined);
  check(
    "at 用 Z 放行",
    violated("propose_action", { ...baseAction, payload: { at: "2026-11-20T01:00:00Z" } }) ===
      undefined,
  );
  check(
    "草稿消息空正文被拦",
    violated("propose_action", {
      kind: "draft_message",
      title: "给张三发消息",
      payload: { text: "  " },
      reason: "x",
      sourceIds: ["ev_001"],
    }) === "missing-text",
  );
  check(
    "只有一个选项的追问被拦",
    violated("ask_user", { questions: [{ id: "time", question: "几点", options: ["七点"] }] }) ===
      "question-options",
  );
  check(
    "追问 id 重复被拦",
    violated("ask_user", {
      questions: [
        { id: "time", question: "几点", options: ["七点", "八点"] },
        { id: "time", question: "哪天", options: ["周一", "周二"] },
      ],
    }) === "question-id-dup",
  );
  check("没有规则的工具直接放行", violated("review_candidates", { anything: 1 }) === undefined);

  // 端到端：第一次参数不合格被拦，模型拿到 isError 之后改对参数重试
  const rulesState = join(root, "data", "smoke-rules.db");
  await Store.reset(rulesState);
  const rulesStore = await Store.open(rulesState);
  await rulesStore.seedIfEmpty(seedState);

  const rulesReg = registerFauxProvider({});
  rulesReg.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("propose_action", {
          ...baseAction,
          payload: { at: "2026-11-20T09:00:00" },
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxToolCall("propose_action", baseAction)], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("时间补上时区了。")]),
  ]);

  const rulesRun = await runSession({
    store: rulesStore,
    personId: "p_001",
    goal: "提醒张三复查",
    model: rulesReg.getModel(),
    survey: async () => ({}),
    confirm: async () => true,
    review: async () => true,
    outbox: new Outbox(rulesStore, new MockDevice(join(root, "data", "smoke-rules-ledger.jsonl"))),
  });
  rulesReg.unregister();

  const rulesSession = await rulesStore.getSession(rulesRun.sessionId);
  const ruleMessages = (rulesSession?.messages ?? []) as Array<{ role: string; isError?: boolean }>;
  const errorResults = ruleMessages.filter((m) => m.role === "toolResult" && m.isError);
  check("被规则拦下时模型收到 isError 回执", errorResults.length === 1, errorResults.length);
  check(
    "回执里说清楚了怎么改（提到时区）",
    JSON.stringify(errorResults[0] ?? {}).includes("时区"),
  );
  check(
    "模型改对参数后提案落地",
    (await rulesStore.listActions("p_001")).filter((c) => c.title === baseAction.title).length === 1,
  );
  check("规则拦截计入护栏预算", rulesRun.stats.blockedCalls === 1, rulesRun.stats.blockedCalls);
  await rulesStore.close();

  // 18. 越界尝试按错误类型计数，不靠错误文案
  const deniedState = join(root, "data", "smoke-denied.db");
  await Store.reset(deniedState);
  const deniedStore = await Store.open(deniedState);
  await deniedStore.seedIfEmpty(seedState);

  const deniedReg = registerFauxProvider({});
  deniedReg.setResponses([
    fauxAssistantMessage([fauxToolCall("get_evidence_text", { evidenceId: "ev_101" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      [fauxToolCall("propose_action", { ...baseAction, sourceIds: ["ev_101"] })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("两处都被拒了。")]),
  ]);

  const deniedRun = await runSession({
    store: deniedStore,
    personId: "p_001",
    goal: "读一下李四的记录",
    model: deniedReg.getModel(),
    survey: async () => ({}),
    confirm: async () => true,
    review: async () => true,
    outbox: new Outbox(deniedStore, new MockDevice(join(root, "data", "smoke-denied-ledger.jsonl"))),
  });
  deniedReg.unregister();

  check("跨人读取与跨人引用各计一次", deniedRun.stats.deniedCalls === 2, deniedRun.stats.deniedCalls);
  const deniedSession = await deniedStore.getSession(deniedRun.sessionId);
  const deniedErrors = ((deniedSession?.messages ?? []) as Array<{ role: string; isError?: boolean }>).filter(
    (m) => m.role === "toolResult" && m.isError,
  );
  check("两次越界都回灌了 isError 给模型", deniedErrors.length === 2, deniedErrors.length);
  check("两次被拒后没有产生行动卡", (await deniedStore.listActions("p_001")).length === 0);
  await deniedStore.close();

  // 19. 会话存档检索：多关键词不能被最早命中吃光额度
  console.log("\n[19] recall_history：多关键词按词轮询");
  const recallState = join(root, "data", "smoke-recall.db");
  await Store.reset(recallState);
  const recallStore = await Store.open(recallState);
  await recallStore.seedIfEmpty(seedState);
  const recallMessages = Array.from({ length: 10 }, (_, i) => ({
    role: "user",
    content: `第 ${i} 条：token${i}`,
    timestamp: i,
  })) as unknown as AgentMessage[];
  const nowIso = new Date().toISOString();
  await recallStore.saveSession({
    sessionId: "sess_recall",
    personId: "p_001",
    messages: recallMessages,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const recallTool = createTools({
    store: recallStore,
    personId: "p_001",
    sessionId: "sess_recall",
    survey: async () => ({}),
    onProposedAction: () => {},
    onProposedMemory: () => {},
  }).find((t) => t.name === "recall_history") as unknown as {
    execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
  };
  const recallOut = await recallTool.execute("c1", {
    query: Array.from({ length: 10 }, (_, i) => `token${i}`).join(" "),
  });
  const recallPayload = JSON.parse(recallOut.content[0]!.text) as {
    returned: number;
    truncated: boolean;
    hits: Array<{ matched: string[] }>;
  };
  const distinct = new Set(recallPayload.hits.flatMap((h) => h.matched));
  check("多关键词默认返回 8 条", recallPayload.returned === 8, recallPayload.returned);
  check("返回条数不够时明确告知模型", recallPayload.truncated === true);
  check("8 条覆盖 8 个不同关键词", distinct.size === 8, distinct.size);
  await recallStore.close();

  // ---------- 20. 滞回式压缩：高水位触发、低水位回落 ----------
  console.log("\n[20] 上下文压缩：高水位触发、低水位回落");
  const pair = (msgs: AgentMessage[], n: number): void => {
    msgs.push({ role: "user", content: `u${n}`, timestamp: n } as unknown as AgentMessage);
    msgs.push({
      role: "assistant",
      content: [],
      api: "faux",
      provider: "faux",
      model: "f",
      usage: {},
      stopReason: "stop",
      timestamp: n,
    } as unknown as AgentMessage);
  };
  const stubSummary = (): SessionSummary => ({
    facts: [{ text: "实验占位", evidenceIds: [] }],
    openThreads: [],
    coveredMessages: 0,
    generatedAt: "2026-11-11T00:00:00.000Z",
    windowStart: 0,
  });

  const seeded: AgentMessage[] = [];
  for (let i = 0; i < 11; i += 1) pair(seeded, i);
  const firstCompact = await compactMessages(seeded, {
    maxMessages: 20,
    lowWater: 12,
    previous: stubSummary(),
  });
  check("触发后压到低水位", firstCompact.messages.length <= 12, firstCompact.messages.length);
  check("窗口起点记进摘要", firstCompact.summary?.windowStart === 12, firstCompact.summary?.windowStart);

  // 调用方每轮传的是全量消息。压过之后即使没触发，也必须返回同一个窗口视图，
  // 否则模型会重新看到被压掉的整段历史。
  const full = seeded.slice();
  let previous = firstCompact.summary;
  let quiet = 0;
  const viewLens: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    pair(full, 100 + i);
    const r = await compactMessages(full, { maxMessages: 20, lowWater: 12, previous });
    if (r.dropped === 0) quiet += 1;
    previous = r.summary;
    viewLens.push(r.messages.length);
  }
  check("压缩后连续三轮不再触发", quiet === 3, quiet);
  check(
    "不触发时视图只追加不重置",
    viewLens.length === 3 && viewLens[1]! - viewLens[0]! === 2 && viewLens[2]! - viewLens[1]! === 2,
    viewLens,
  );

  const simulate = async (lowWater: number) => {
    const msgs: AgentMessage[] = [];
    let prev: SessionSummary | undefined = stubSummary();
    let compactions = 0;
    let totalView = 0;
    let peak = 0;
    for (let turn = 0; turn < 30; turn += 1) {
      pair(msgs, turn);
      const r = await compactMessages(msgs, { maxMessages: 20, lowWater, previous: prev });
      if (r.dropped > 0) compactions += 1;
      prev = r.summary;
      totalView += r.messages.length;
      peak = Math.max(peak, r.messages.length);
    }
    return { compactions, avg: totalView / 30, peak };
  };
  const sliding = await simulate(20);
  const hysteretic = await simulate(12);
  check("滞回压缩次数少于滑窗", hysteretic.compactions < sliding.compactions, {
    hysteretic,
    sliding,
  });
  check("滞回平均上下文更短", hysteretic.avg < sliding.avg, { hysteretic, sliding });
  check("滞回峰值不超过高水位", hysteretic.peak <= 20, hysteretic.peak);

  // ---------- 21. 证据入库：ICS 解析、去重、待人工确认 ----------
  console.log("\n[21] 证据入库：ICS 解析、去重、待人工确认");
  const ingestState = join(root, "data", "smoke-ingest.db");
  await Store.reset(ingestState);
  const ingestStore = await Store.open(ingestState);
  await ingestStore.seedIfEmpty(seedState);
  const ingestNow = new Date("2026-11-11T00:00:00.000Z");
  const icsSource = "data/inbox/calendar.ics";
  const icsText = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "X-WR-TIMEZONE:Asia/Shanghai",
    "BEGIN:VEVENT",
    "UID:evt-1",
    "SUMMARY:和张三吃饭",
    "DTSTART;TZID=Asia/Shanghai:20261120T190000",
    "DTEND;TZID=Asia/Shanghai:20261120T203000",
    "LOCATION:北院区食堂",
    "DESCRIPTION:记得带\\, 礼物",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:evt-2",
    "SUMMARY:折行",
    " 评审",
    "DTSTART:20261121T010000Z",
    "DESCRIPTION:第一行\\n第二",
    " 行",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:evt-bad",
    "SUMMARY:坏事件",
    "DTSTART:明天下午",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:evt-cancel",
    "SUMMARY:取消的会议",
    "DTSTART:20261122T100000Z",
    "STATUS:CANCELLED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const calendar = await ingestIcs(ingestStore, icsText, {
    personId: "p_001",
    sourceRef: icsSource,
    now: ingestNow,
  });
  check("读出全部 VEVENT", calendar.events.length === 4, calendar.events.length);
  check("取消的事件被跳过", calendar.cancelled === 1, calendar.cancelled);
  check("解析失败的事件落待确认", calendar.pending === 1, calendar.pending);
  check("只导入三个有效事件", calendar.items.length === 3, calendar.items.length);

  const dinner = calendar.items.find((i) => i.evidence.title === "和张三吃饭")!;
  const review = calendar.items.find((i) => i.evidence.title === "折行评审")!;
  const broken = calendar.items.find((i) => i.evidence.title === "坏事件")!;
  check(
    "TZID 时间换算成 UTC",
    dinner.evidence.capturedAt === "2026-11-20T11:00:00.000Z",
    dinner.evidence.capturedAt,
  );
  check("UTC 时间原样保留", review.evidence.capturedAt === "2026-11-21T01:00:00.000Z");
  check("折行被拼回一行", review.evidence.title === "折行评审", review.evidence.title);
  check(
    "逗号转义被还原",
    dinner.evidence.content.includes("说明：记得带, 礼物"),
    dinner.evidence.content,
  );
  check(
    "换行转义与折行同时还原",
    review.evidence.content.includes("说明：第一行\n第二行"),
    review.evidence.content,
  );
  check("正常事件是 active", dinner.evidence.status === "active", dinner.evidence.status);
  check(
    "坏事件是 pending_review 且带原因",
    broken.evidence.status === "pending_review" &&
      (broken.evidence.summary ?? "").includes("无法解析 DTSTART"),
    broken.evidence.summary,
  );

  const countAfterFirst = (await ingestStore.listEvidence("p_001")).length;
  const again = await ingestIcs(ingestStore, icsText, {
    personId: "p_001",
    sourceRef: icsSource,
    now: ingestNow,
  });
  const countAfterSecond = (await ingestStore.listEvidence("p_001")).length;
  check("重复导入全部命中哈希", again.items.every((i) => !i.created), again.duplicates);
  check("重复导入不新增证据", countAfterSecond === countAfterFirst, {
    countAfterFirst,
    countAfterSecond,
  });

  const ingestSnapshot = await buildMemorySnapshot(ingestStore, "p_001", ingestNow);
  check(
    "正常日历进入快照",
    ingestSnapshot.evidence.some((e) => e.evidenceId === dinner.evidence.evidenceId),
  );
  check(
    "待确认日历不进入快照",
    !ingestSnapshot.evidence.some((e) => e.evidenceId === broken.evidence.evidenceId),
  );
  check("待确认证据不参与检索", (await ingestStore.searchEvidence("p_001", "坏事件")).length === 0);
  check("正常证据仍可检索", (await ingestStore.searchEvidence("p_001", "张三吃饭")).length === 1);

  const ingestTools = createTools({
    store: ingestStore,
    personId: "p_001",
    sessionId: "sess_ingest",
    survey: async () => ({}),
    onProposedAction: () => {},
    onProposedMemory: () => {},
  });
  const getEvidenceTool = ingestTools.find((t) => t.name === "get_evidence_text") as unknown as {
    execute: (
      id: string,
      params: { evidenceId: string },
    ) => Promise<{ content: { text: string }[] }>;
  };
  let pendingError = "";
  try {
    await getEvidenceTool.execute("c1", { evidenceId: broken.evidence.evidenceId });
  } catch (err) {
    pendingError = err instanceof Error ? err.message : String(err);
  }
  check("待确认证据对模型不可读", pendingError.includes("尚未通过人工确认"), pendingError);

  // 保留期从入库时间算：补录一张很旧的截图，导入之后仍然能读正文
  const oldShot = await ingestEvidence(
    ingestStore,
    {
      personId: "p_001",
      kind: "screenshot",
      capturedAt: "2026-01-01T00:00:00.000Z",
      title: "旧截图补录",
      content: "三个月前的截图补录进来，正文仍然可读",
      sourceRef: "smoke-old.png",
      contentHash: "sha256:smoke-old",
    },
    ingestNow,
  );
  check(
    "保留期从入库时间起算",
    oldShot.expiresAt === new Date(ingestNow.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    oldShot.expiresAt,
  );
  check("补录旧材料不会一入库就过期", ingestStore.isExpired(oldShot.evidence, ingestNow) === false);

  // 过期证据：快照、检索、按 ID 读取三条路都不能把正文漏出去
  const tail = "尾部暗号";
  const expiredShot = await ingestEvidence(
    ingestStore,
    {
      personId: "p_001",
      kind: "screenshot",
      capturedAt: "2026-11-01T00:00:00.000Z",
      title: "过期截图",
      content: `${"很长的正文。".repeat(20)}${tail}`,
      sourceRef: "smoke-expired.png",
      contentHash: "sha256:smoke-expired",
      ttlMs: 1000,
    },
    // 一小时前入库、只保留 1 秒，现在必然已过期
    new Date(Date.now() - 60 * 60 * 1000),
  );
  const expiredSnapshot = await buildMemorySnapshot(ingestStore, "p_001");
  const expiredEntry = expiredSnapshot.evidence.find(
    (e) => e.evidenceId === expiredShot.evidence.evidenceId,
  );
  check(
    "过期证据在快照里只给摘要",
    expiredEntry?.expired === true && !expiredEntry.preview.includes(tail),
    expiredEntry?.preview,
  );

  const searchTool = ingestTools.find((t) => t.name === "search_evidence") as unknown as {
    execute: (id: string, params: { query: string }) => Promise<{ content: { text: string }[] }>;
  };
  const searchPayload = JSON.parse(
    (await searchTool.execute("c2", { query: tail })).content[0]!.text,
  ) as { count: number; hits: { expired: boolean; snippet: string }[] };
  check("过期证据仍能被检索到", searchPayload.count === 1, searchPayload.count);
  check(
    "检索片段换成摘要，不漏正文",
    searchPayload.hits[0]?.expired === true && !searchPayload.hits[0]?.snippet.includes(tail),
    searchPayload.hits[0],
  );

  const expiredRead = JSON.parse(
    (await getEvidenceTool.execute("c3", { evidenceId: expiredShot.evidence.evidenceId })).content[0]!
      .text,
  ) as { expired: boolean; content: string; note: string };
  check(
    "按 ID 读过期证据只拿到摘要",
    expiredRead.expired === true && !expiredRead.content.includes(tail),
    expiredRead.content.slice(0, 80),
  );
  check("过期提示写清楚", expiredRead.note.includes("保留期"), expiredRead.note);

  const pendingShotPath = join(root, "data", "smoke-shot.png");
  await writeFile(pendingShotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  const pendingShot = await ingestScreenshot(ingestStore, {
    personId: "p_001",
    filePath: pendingShotPath,
    now: ingestNow,
  });
  check(
    "没有 OCR 时截图落待确认",
    pendingShot.status === "pending_review" && pendingShot.evidence.status === "pending_review",
    pendingShot.status,
  );
  check("失败原因写进摘要", pendingShot.evidence.summary === "未配置 OCR 提取器", pendingShot.evidence.summary);
  const pendingShotAgain = await ingestScreenshot(ingestStore, {
    personId: "p_001",
    filePath: pendingShotPath,
    now: ingestNow,
  });
  check(
    "同一张图重复导入不新增",
    pendingShotAgain.created === false &&
      pendingShotAgain.evidence.evidenceId === pendingShot.evidence.evidenceId,
  );

  // 空白 key 让 resolveApiKey 直接抛错，不会真的打到网络
  const noKeyShotPath = join(root, "data", "smoke-shot-nokey.png");
  await writeFile(noKeyShotPath, Buffer.from([7, 7, 7, 7]));
  const noKeyShot = await ingestScreenshot(ingestStore, {
    personId: "p_001",
    filePath: noKeyShotPath,
    now: ingestNow,
    extractor: createVisionExtractor({ apiKey: "  " }),
  });
  check("缺 OCR key 的截图落待确认", noKeyShot.status === "pending_review", noKeyShot.status);
  check(
    "缺 key 的原因能被人工看到",
    (noKeyShot.reason ?? "").includes("缺少 OCR API key"),
    noKeyShot.reason,
  );
  check(
    "缺 key 时不写正文",
    noKeyShot.evidence.content === "" && noKeyShot.evidence.status === "pending_review",
  );
  await rm(noKeyShotPath, { force: true });

  const okShotPath = join(root, "data", "smoke-shot-ok.png");
  await writeFile(okShotPath, Buffer.from([9, 9, 9, 9, 9, 9]));
  const okShot = await ingestScreenshot(ingestStore, {
    personId: "p_001",
    filePath: okShotPath,
    now: ingestNow,
    extractor: {
      extract: async () => ({
        capturedAt: "2026-11-01T08:00:00.000Z",
        title: "聊天截图：周末安排",
        content: "张三：周六一起吃饭",
      }),
    },
  });
  check("OCR 成功落 active", okShot.status === "active" && okShot.evidence.status === "active");
  check("OCR 正文入库", okShot.evidence.content.includes("周六一起吃饭"));
  const afterShotSnapshot = await buildMemorySnapshot(ingestStore, "p_001", ingestNow);
  check(
    "成功截图进入快照",
    afterShotSnapshot.evidence.some((e) => e.evidenceId === okShot.evidence.evidenceId),
  );
  check(
    "待确认截图不进入快照",
    !afterShotSnapshot.evidence.some((e) => e.evidenceId === pendingShot.evidence.evidenceId),
  );

  const acceptedShot = await ingestStore.updateEvidence(pendingShot.evidence.evidenceId, {
    status: "active",
    content: "人工补录：张三说周六见",
    summary: "人工补录：张三说周六见",
  });
  check("人工接受后状态变 active", acceptedShot.status === "active", acceptedShot.status);
  const acceptedSnapshot = await buildMemorySnapshot(ingestStore, "p_001", ingestNow);
  check(
    "人工接受后进入快照",
    acceptedSnapshot.evidence.some((e) => e.evidenceId === acceptedShot.evidenceId),
  );

  const rejectedCalendar = await ingestStore.updateEvidence(broken.evidence.evidenceId, {
    status: "rejected",
  });
  check("人工拒绝后状态变 rejected", rejectedCalendar.status === "rejected", rejectedCalendar.status);
  const rejectedSnapshot = await buildMemorySnapshot(ingestStore, "p_001", ingestNow);
  check(
    "拒绝的证据不进入快照",
    !rejectedSnapshot.evidence.some((e) => e.evidenceId === rejectedCalendar.evidenceId),
  );

  // ---------- 21b. RRULE 展开 ----------
  console.log("\n[21b] RRULE 展开");
  const rruleNow = new Date("2026-11-11T00:00:00.000Z");
  const parseOne = (lines: string[], now = rruleNow) =>
    parseIcs(["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\r\n"), now)[0]!;

  const weekly = parseOne([
    "BEGIN:VEVENT",
    "UID:r-weekly",
    "SUMMARY:晨会",
    "DTSTART:20261111T090000Z",
    "DTEND:20261111T093000Z",
    "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=6",
    "END:VEVENT",
  ]);
  check("周规则按 BYDAY 展开出 COUNT 个实例", weekly.occurrences.length === 6, weekly.occurrences.length);
  check(
    "BYDAY 按时间排序（本周三在前，下周一在后）",
    weekly.occurrences[0]!.startsAt === "2026-11-11T09:00:00.000Z" &&
      weekly.occurrences[1]!.startsAt === "2026-11-16T09:00:00.000Z",
    weekly.occurrences.map((o) => o.startsAt),
  );
  check(
    "每个实例都带上事件时长",
    weekly.occurrences.every(
      (o) =>
        o.endsAt !== undefined &&
        Date.parse(o.endsAt) - Date.parse(o.startsAt) === 30 * 60 * 1000,
    ),
  );

  // 2026-03-08 美东进入夏令时：按墙钟推进的话 UTC 时间应该从 14:00 变成 13:00
  const dst = parseOne(
    [
      "BEGIN:VEVENT",
      "UID:r-dst",
      "SUMMARY:跨夏令时的晨会",
      "DTSTART;TZID=America/New_York:20260306T090000",
      "RRULE:FREQ=DAILY;COUNT=4",
      "END:VEVENT",
    ],
    new Date("2026-03-01T00:00:00.000Z"),
  );
  check(
    "夏令时切换后仍按墙钟 9 点展开",
    dst.occurrences.map((o) => o.startsAt).join(",") ===
      [
        "2026-03-06T14:00:00.000Z",
        "2026-03-07T14:00:00.000Z",
        "2026-03-08T13:00:00.000Z",
        "2026-03-09T13:00:00.000Z",
      ].join(","),
    dst.occurrences.map((o) => o.startsAt),
  );

  const until = parseOne([
    "BEGIN:VEVENT",
    "UID:r-until",
    "SUMMARY:连续四天",
    "DTSTART:20261112T090000Z",
    "RRULE:FREQ=DAILY;UNTIL=20261115T090000Z",
    "END:VEVENT",
  ]);
  check(
    "UNTIL 是闭区间",
    until.occurrences.length === 4 &&
      until.occurrences[3]!.startsAt === "2026-11-15T09:00:00.000Z",
    until.occurrences.map((o) => o.startsAt),
  );

  const excluded = parseOne([
    "BEGIN:VEVENT",
    "UID:r-exdate",
    "SUMMARY:跳过一次",
    "DTSTART:20261112T090000Z",
    "RRULE:FREQ=DAILY;COUNT=4",
    "EXDATE:20261113T090000Z",
    "EXDATE:20261114T090000Z",
    "END:VEVENT",
  ]);
  check(
    "多行 EXDATE 都被排除（不是只留最后一行）",
    excluded.occurrences.length === 2,
    excluded.occurrences.map((o) => o.startsAt),
  );
  check(
    "EXDATE 不影响 COUNT 计数",
    excluded.occurrences[1]!.startsAt === "2026-11-15T09:00:00.000Z",
    excluded.occurrences.map((o) => o.startsAt),
  );

  const monthly = parseOne(
    [
      "BEGIN:VEVENT",
      "UID:r-monthly",
      "SUMMARY:月末复盘",
      "DTSTART:20260131T080000Z",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4",
      "END:VEVENT",
    ],
    new Date("2026-01-01T00:00:00.000Z"),
  );
  check(
    "月度规则跳过不存在的 2 月 31 日",
    monthly.occurrences.length === 2 &&
      monthly.occurrences[1]!.startsAt.startsWith("2026-03-31"),
    monthly.occurrences.map((o) => o.startsAt),
  );

  const yearly = parseOne([
    "BEGIN:VEVENT",
    "UID:r-yearly",
    "SUMMARY:闰日纪念",
    "DTSTART:20240229T080000Z",
    "RRULE:FREQ=YEARLY",
    "END:VEVENT",
  ]);
  check(
    "年度规则在非闰年不滑到 3 月 1 日",
    yearly.occurrences.length === 1 &&
      yearly.occurrences[0]!.startsAt.startsWith("2024-02-29"),
    yearly.occurrences.map((o) => o.startsAt),
  );

  const unsupported = parseOne([
    "BEGIN:VEVENT",
    "UID:r-setpos",
    "SUMMARY:每月第一个周一",
    "DTSTART:20261102T100000Z",
    "RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1",
    "END:VEVENT",
  ]);
  check(
    "不支持的规则退化成首个实例并写明原因",
    unsupported.occurrences.length === 1 && (unsupported.recurrenceNote ?? "").includes("BYSETPOS"),
    unsupported.recurrenceNote,
  );

  const endless = parseOne([
    "BEGIN:VEVENT",
    "UID:r-endless",
    "SUMMARY:每天提醒",
    "DTSTART:20261111T120000Z",
    "RRULE:FREQ=DAILY",
    "END:VEVENT",
  ]);
  check(
    "没有 COUNT/UNTIL 的规则被 90 天窗口截断",
    endless.occurrences.length === 90 &&
      endless.occurrences[89]!.startsAt === "2027-02-08T12:00:00.000Z",
    endless.occurrences.length,
  );

  const recurringText = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:r-ingest",
    "SUMMARY:周报",
    "DTSTART:20261112T100000Z",
    "RRULE:FREQ=DAILY;COUNT=3",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const recurringFirst = await ingestIcs(ingestStore, recurringText, {
    personId: "p_001",
    sourceRef: "data/inbox/recurring.ics",
    now: rruleNow,
  });
  check("重复事件按实例逐条入库", recurringFirst.items.length === 3, recurringFirst.items.length);
  check(
    "每个实例的 capturedAt 各不相同",
    new Set(recurringFirst.items.map((i) => i.evidence.capturedAt)).size === 3,
  );
  check(
    "正文标出这是第几个实例",
    recurringFirst.items[1]!.evidence.content.includes("第 2/3 个实例"),
    recurringFirst.items[1]!.evidence.content,
  );
  const recurringAgain = await ingestIcs(ingestStore, recurringText, {
    personId: "p_001",
    sourceRef: "data/inbox/recurring.ics",
    now: rruleNow,
  });
  const weeklyCount = (await ingestStore.listEvidence("p_001")).filter((e) => e.title === "周报").length;
  check(
    "重复导入按实例命中哈希，不会翻倍",
    recurringAgain.duplicates === 3 && weeklyCount === 3,
    { duplicates: recurringAgain.duplicates, weeklyCount },
  );

  await ingestStore.close();
  await rm(pendingShotPath, { force: true });
  await rm(okShotPath, { force: true });

  // ---------- 22. 截图 OCR：回复解析与配置守卫 ----------
  console.log("\n[22] 截图 OCR：回复解析与配置守卫");
  const ocrParsed = parseOcrJson(
    '{"capturedAt":"2026-11-12T15:30:00+08:00","title":"周末安排",' +
      '"content":"张三：周六一起吃饭","confidence":0.92}',
  );
  check("解析出正文", ocrParsed.content === "张三：周六一起吃饭");
  check("解析出标题", ocrParsed.title === "周末安排", ocrParsed.title);
  check("带时区的时间统一转成 UTC", ocrParsed.capturedAt === "2026-11-12T07:30:00.000Z", ocrParsed.capturedAt);
  check("置信度原样带回", ocrParsed.confidence === 0.92, ocrParsed.confidence);

  const fenced = parseOcrJson('```json\n{"content":"围栏里的正文"}\n```');
  check("代码围栏能剥掉", fenced.content === "围栏里的正文", fenced.content);

  const chatty = parseOcrJson('好的，抽取结果如下：\n{"content":"夹在解释里"}\n以上。');
  check("前后夹解释也能取出 JSON", chatty.content === "夹在解释里", chatty.content);

  const badTime = parseOcrJson('{"capturedAt":"明天下午","content":"看不出日期"}');
  check(
    "解析不了的时间被丢掉，正文保留",
    badTime.capturedAt === undefined && badTime.content === "看不出日期",
    badTime,
  );

  const longTitle = parseOcrJson(JSON.stringify({ content: "x", title: "标".repeat(100) }));
  check("标题截到 80 字", longTitle.title?.length === 80, longTitle.title?.length);

  check("置信度夹到 0~1", parseOcrJson('{"content":"x","confidence":1.7}').confidence === 1);

  let emptyErr = "";
  try {
    parseOcrJson('{"title":"只有标题"}');
  } catch (err) {
    emptyErr = err instanceof Error ? err.message : String(err);
  }
  check("空正文按失败处理", emptyErr.includes("没有 content 字段"), emptyErr);

  let notJsonErr = "";
  try {
    parseOcrJson("抱歉，我看不清这张图");
  } catch (err) {
    notJsonErr = err instanceof Error ? err.message : String(err);
  }
  check("非 JSON 报错并带原文", notJsonErr.includes("不是 JSON 对象") && notJsonErr.includes("我看不清"), notJsonErr);

  let keyErr = "";
  try {
    await createVisionExtractor({ apiKey: "" }).extract({
      filePath: "smoke.png",
      bytes: Buffer.from([1]),
      mime: "image/png",
    });
  } catch (err) {
    keyErr = err instanceof Error ? err.message : String(err);
  }
  check(
    "缺 key 的报错点名两个环境变量",
    keyErr.includes("RELATIONSHIP_OCR_API_KEY") && keyErr.includes("DASHSCOPE_API_KEY"),
    keyErr,
  );

  let bigErr = "";
  try {
    await createVisionExtractor({ apiKey: "sk-smoke-not-real" }).extract({
      filePath: "big.png",
      bytes: Buffer.alloc(11 * 1024 * 1024),
      mime: "image/png",
    });
  } catch (err) {
    bigErr = err instanceof Error ? err.message : String(err);
  }
  check("超大图片在发请求前被拦下", bigErr.includes("图片过大"), bigErr);

  // ---------- 23. 文件日历设备 ----------
  console.log("\n[23] 文件日历设备：写 ICS、幂等查询、失败分类");
  const deviceDir = join(root, "data", "smoke-ics-device");
  await rm(deviceDir, { recursive: true, force: true });
  const fileDevice = new IcsFileDevice({
    dir: deviceDir,
    clock: () => new Date("2026-11-12T00:00:00.000Z"),
  });
  const cardOf = (over: Partial<ActionCard>): ActionCard => ({
    requestId: "req_ics_1",
    personId: "p_001",
    kind: "calendar_event",
    title: "和张三吃饭",
    payload: { at: "2026-11-20T19:00:00+08:00", durationMinutes: 90 },
    reason: "他提过这周有空",
    sourceIds: ["ev_001"],
    cardVersion: 1,
    status: "confirmed",
    createdAt: "2026-11-12T00:00:00.000Z",
    ...over,
  });

  const firstWrite = await fileDevice.execute(cardOf({ title: "吃饭, 带礼物; 别迟到" }));
  check("文件设备执行成功", firstWrite.status === "ok", firstWrite);
  const rawIcs = (await fileDevice.readRaw("req_ics_1")) ?? "";
  check("DTSTART 按 UTC 写入", rawIcs.includes("DTSTART:20261120T110000Z"), rawIcs);
  check("时长按 payload 写进 DTEND", rawIcs.includes("DTEND:20261120T123000Z"));
  check("标题里的逗号分号被转义", rawIcs.includes("SUMMARY:吃饭\\, 带礼物\\; 别迟到"), rawIcs);
  check("UID 用 requestId", rawIcs.includes("UID:req_ics_1"));

  const secondWrite = await fileDevice.execute(cardOf({ title: "改过的标题" }));
  const afterSecond = (await fileDevice.readRaw("req_ics_1")) ?? "";
  check(
    "重复执行不覆盖已有文件",
    secondWrite.status === "ok" && afterSecond.includes("SUMMARY:吃饭\\, 带礼物\\; 别迟到"),
    secondWrite.detail,
  );
  check("重复执行的回执说明原因", (secondWrite.detail ?? "").includes("已存在"), secondWrite.detail);

  check("lookup 查得到已执行的事件", (await fileDevice.lookup("req_ics_1"))?.status === "ok");
  check("lookup 查不到未执行的事件", (await fileDevice.lookup("req_missing")) === undefined);

  const draft = await fileDevice.execute(
    cardOf({ requestId: "req_draft", kind: "draft_message", payload: { text: "hi" } }),
  );
  check("消息草稿被明确拒绝", draft.status === "failed" && draft.retryable === false, draft);
  const badAt = await fileDevice.execute(
    cardOf({ requestId: "req_bad_at", payload: { at: "2026-11-20T19:00:00" } }),
  );
  check("没有时区偏移的时间被拒绝", badAt.status === "failed" && badAt.retryable === false, badAt);

  const reminder = await fileDevice.execute(
    cardOf({ requestId: "req_reminder", kind: "reminder", payload: { at: "2026-11-21T09:00:00+08:00" } }),
  );
  const reminderRaw = (await fileDevice.readRaw("req_reminder")) ?? "";
  check(
    "提醒写入 VALARM",
    reminder.status === "ok" &&
      reminderRaw.includes("BEGIN:VALARM") &&
      reminderRaw.includes("TRIGGER:-PT0M"),
  );

  // 长中文标题会被折行，拿自己的解析器读回来必须还是原样
  const longEventTitle = "和张三李四王五赵六一起在北院区食堂吃晚饭然后去看电影再回家".repeat(2);
  await fileDevice.execute(cardOf({ requestId: "req_long", title: longEventTitle }));
  const longRaw = (await fileDevice.readRaw("req_long")) ?? "";
  check(
    "折行后每行不超过 75 字节",
    longRaw.split("\r\n").every((line) => Buffer.byteLength(line, "utf8") <= 75),
  );
  const roundTrip = parseIcs(longRaw, new Date("2026-11-12T00:00:00.000Z"))[0]!;
  check("折行的标题能原样解析回来", roundTrip.summary === longEventTitle, roundTrip.summary.slice(0, 20));

  const traversal = await fileDevice.execute(cardOf({ requestId: "../evil" }));
  check("requestId 不能跳出目录", traversal.status === "failed", traversal.detail);

  const notDir = join(root, "data", "smoke-ics-not-a-dir");
  await writeFile(notDir, "x");
  const brokenDevice = new IcsFileDevice({ dir: notDir });
  let lookupErr = "";
  try {
    await brokenDevice.lookup("req_ics_1");
  } catch (err) {
    lookupErr = err instanceof Error ? err.message : String(err);
  }
  check("查询失败要抛异常，不能冒充没执行", lookupErr.length > 0, lookupErr);
  const brokenWrite = await brokenDevice.execute(cardOf({ requestId: "req_broken" }));
  check(
    "写入失败标为可重试",
    brokenWrite.status === "failed" && brokenWrite.retryable === true,
    brokenWrite,
  );
  await rm(notDir, { force: true });

  // 走一遍 Outbox：确认后的卡变成 executed，设备侧留下对应文件
  const deviceStorePath = join(root, "data", "smoke-device.db");
  await Store.reset(deviceStorePath);
  const deviceStore = await Store.open(deviceStorePath);
  await deviceStore.seedIfEmpty(seedState);
  const deviceCard = await deviceStore.createAction({
    personId: "p_001",
    kind: "calendar_event",
    title: "设备联调",
    payload: { at: "2026-11-25T10:00:00+08:00" },
    reason: "联调",
    sourceIds: ["ev_001"],
  });
  await deviceStore.updateAction(deviceCard.requestId, deviceCard.cardVersion, {
    status: "confirmed",
    confirmedAt: new Date().toISOString(),
  });
  const deviceOutbox = new Outbox(deviceStore, fileDevice);
  const deviceResult = await deviceOutbox.submit(await deviceStore.getAction(deviceCard.requestId));
  check("Outbox 把卡推进到 executed", deviceResult.card.status === "executed", deviceResult.card.status);
  check("设备侧留下对应文件", (await fileDevice.readRaw(deviceCard.requestId)) !== undefined);
  const deviceFiles = await readdir(deviceDir);
  check(
    "每个 requestId 只有一个文件",
    deviceFiles.filter((f) => f === `${deviceCard.requestId}.ics`).length === 1,
    deviceFiles,
  );
  await deviceStore.close();
  await rm(deviceDir, { recursive: true, force: true });
  await rm(deviceStorePath, { force: true });

  console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});