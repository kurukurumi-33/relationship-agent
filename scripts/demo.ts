import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
} from "@mariozechner/pi-ai";
import { Store, GenerationConflictError } from "../src/store/store.js";
import { seedState } from "../src/data/seed.js";
import { runSession } from "../src/session/run.js";
import { Outbox } from "../src/runtime/outbox.js";
import { MockDevice } from "../src/runtime/device.js";
import { createScriptedSurvey, alwaysConfirm, alwaysReview } from "../src/runtime/survey.js";
import { buildMemorySnapshot } from "../src/agent/snapshot.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const statePath = join(root, "data", "demo-state.db");
const ledgerPath = join(root, "data", "demo-ledger.jsonl");

function section(title: string): void {
  console.log(`\n${"─".repeat(60)}\n${title}\n${"─".repeat(60)}`);
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`断言失败: ${message}`);
}

async function main(): Promise<void> {
  await Store.reset(statePath);
  await rm(ledgerPath, { force: true });

  const store = await Store.open(statePath);
  await store.seedIfEmpty(seedState);

  // 用 faux provider 把模型行为写死，等价于"一个按剧本说话的模型"，
  // 这样这条链路的正确性不依赖任何外部 API。
  const registration = registerFauxProvider({});
  const model = registration.getModel();
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("get_evidence_text", { evidenceId: "ev_001" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      [
        fauxToolCall("ask_user", {
          questions: [
            {
              id: "channel",
              question: "提醒发到哪个渠道？",
              options: ["微信", "邮件", "都发"],
            },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall("propose_action", {
          kind: "reminder",
          title: "11 月 1 日晚提醒张三：复查在上午，评审改到下午",
          payload: {
            at: "2026-11-01T20:00:00+08:00",
            channel: "微信",
            text: "明天上午你要去医院复查，评审我已经和王五挪到下午 2 点了。",
          },
          reason: "张三 11/2 上午复查，原定 10:00 的评审会他参加不了；提前一晚提醒比当天早上更稳。",
          sourceIds: ["ev_001", "ev_002"],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall("propose_memory", {
          text: "张三 2026-11-02 上午需要去医院复查，当天下午才有空。",
          sourceIds: ["ev_001"],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([
      fauxText(
        "建议：把 11/2 的评审会挪到下午 2 点后，并在 11/1 晚上给张三发一条提醒。\n" +
          "依据：ev_001 里张三自己说了上午在医院、下午两点后都行；ev_002 是原定 10:00 的复盘会。\n" +
          "还缺：王五那边是否同意改期，这个我没有证据，需要你确认。",
      ),
    ]),
    // —— 洞察 Agent 的剧本（同一个 provider，按请求顺序排队消费）——
    fauxAssistantMessage(
      [
        fauxToolCall("review_candidates", {
          candidateIds: ["*"],
          decision: "approve",
          reason: "有 ev_001 直接支撑，且属于稳定事实",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("审核完成：1 条候选有证据支撑，放行。")]),
  ]);

  section("① 装配快照（模型能看到的全部事实）");
  const snapshot = await buildMemorySnapshot(store, "p_001");
  console.log(
    JSON.stringify(
      {
        person: snapshot.person,
        memories: snapshot.memories.map((m) => m.text),
        evidence: snapshot.evidence.map((e) => `${e.evidenceId}: ${e.title}`),
        openActions: snapshot.openActions,
      },
      null,
      2,
    ),
  );

  const outbox = new Outbox(store, new MockDevice(ledgerPath));

  section("② 跑一次会话：只读查询 → 追问 → 提案 → 确认 → 回执 → 记忆");
  let turn = 0;
  const result = await runSession({
    store,
    personId: "p_001",
    goal: "下周要和张三一起做项目复盘，帮我准备会前提醒。",
    model,
    survey: createScriptedSurvey({ channel: "微信" }),
    confirm: alwaysConfirm,
    review: alwaysReview,
    outbox,
    insight: { model },
    onEvent: (event) => {
      if (event.type === "tool_execution_start") {
        console.log(`  → ${event.toolName}(${JSON.stringify(event.args).slice(0, 90)})`);
      }
      if (event.type === "turn_end") {
        turn += 1;
        console.log(`  · 第 ${turn} 回合结束`);
      }
    },
  });

  console.log("\n模型结论:");
  console.log(result.text.split("\n").map((line) => `  ${line}`).join("\n"));

  section("③ 行动卡状态与设备回执");
  for (const card of result.finalCards) {
    console.log(
      JSON.stringify(
        {
          requestId: card.requestId,
          title: card.title,
          status: card.status,
          cardVersion: card.cardVersion,
          submittedAt: card.submittedAt,
          receipt: card.receipt,
        },
        null,
        2,
      ),
    );
  }
  assert(result.finalCards.length === 1, "应该产生 1 张行动卡");
  assert(result.finalCards[0]!.status === "executed", "行动卡应执行成功");
  assert(result.receipts[0]!.status === "ok", "应拿到 ok 回执");

  section("④ 洞察 Agent：独立审核，主 Agent 说了不算");
  console.log(JSON.stringify(result.insight, null, 2));
  assert(result.insight?.reviewed === 1, "应有 1 条候选进入洞察审核");
  assert(result.insight?.rejected === 0, "有证据支撑的候选不应被拒");

  section("⑤ 幂等：同一张卡再提交一次");
  const again = await outbox.submit(result.finalCards[0]!);
  console.log(`  reused=${again.reused}（true 表示命中幂等表，没有真的再执行）`);
  const ledgerRaw = await readFile(ledgerPath, "utf8");
  const ledgerCount = ledgerRaw.trim().split("\n").filter(Boolean).length;
  console.log(`  设备账本行数=${ledgerCount}（应为 1）`);
  assert(again.reused === true, "重复提交应命中幂等表");
  assert(ledgerCount === 1, "设备不应被执行两次");

  section("⑥ 记忆写入与 generation CAS");
  const doc = await store.getMemoryDoc("p_001");
  console.log(`  generation=${doc.generation} version=${doc.version} items=${doc.items.length}`);
  for (const item of doc.items) console.log(`  - ${item.text}  ← ${item.sourceIds.join(",")}`);
  assert(doc.generation === 2, "种子 generation=1，写入一条后应为 2");
  assert(doc.items.some((i) => i.text.includes("复查")), "新记忆应写入");

  let conflicted = false;
  try {
    // 用已经过期的 generation 再写一次：必须被拒绝，否则两个会话会互相覆盖
    await store.commitMemory("p_001", 1, [{ text: "过期写入", sourceIds: ["ev_001"] }]);
  } catch (err) {
    conflicted = err instanceof GenerationConflictError;
    console.log(`  过期 generation 写入被拒: ${(err as Error).message}`);
  }
  assert(conflicted, "过期 generation 必须触发冲突");

  section("⑦ sourceIds 校验：跨人引用必须失败");
  let crossBlocked = false;
  try {
    await store.createCandidate({
      personId: "p_001",
      text: "张三喜欢拍银杏",
      sourceIds: ["ev_101"], // 这是李四的证据
    });
  } catch (err) {
    crossBlocked = true;
    console.log(`  跨人引用被拒: ${(err as Error).message}`);
  }
  assert(crossBlocked, "跨人 sourceIds 必须被拒绝");

  section("⑧ 会话持久化（下次可 --resume）");
  const session = await store.getSession(result.sessionId);
  const roles = (session?.messages as Array<{ role: string }>).map((m) => m.role);
  console.log(`  sessionId=${result.sessionId} 消息数=${roles.length}`);
  console.log(`  角色序列: ${roles.join(" → ")}`);
  assert(roles.includes("toolResult"), "会话里应有 toolResult 配对");

  registration.unregister();
  section("全部通过 ✅");
}

main().catch((err) => {
  console.error("\n演示失败:", err);
  process.exitCode = 1;
});