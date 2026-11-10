import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { loadEnv, resolveModel } from "./config.js";
import { Store } from "./store/store.js";
import { seedState } from "./data/seed.js";
import { runSession } from "./session/run.js";
import { MockDevice } from "./runtime/device.js";
import { Outbox } from "./runtime/outbox.js";
import { createCliConfirm, createCliReview, createCliSurvey } from "./runtime/survey.js";
import { repairToolPairing, injectSurveyResults } from "./session/resume.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnv();

  const personId = arg("person");
  const goal = arg("goal");
  const sessionId = arg("session");
  const requestId = arg("request");
  const screen = arg("screen");
  const resume = process.argv.includes("--resume");

  if (!personId || !goal) {
    console.error(
      [
        "用法: npm run dev -- --person p_001 --goal \"下周和张三评审，帮我准备\" [--request req_x --screen meeting] [--session sess_xxx --resume]",
        "",
        "可选环境变量: DEEPSEEK_API_KEY / RELATIONSHIP_MODEL_BASE_URL + RELATIONSHIP_MODEL_API_KEY",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const store = await Store.open(join(projectRoot, "data", "state.db"));
  await store.seedIfEmpty(seedState);

  let resumeMessages;
  if (resume) {
    if (!sessionId) throw new Error("--resume 需要同时给 --session");
    const record = await store.getSession(sessionId);
    if (!record) throw new Error(`会话 ${sessionId} 不存在`);

    let messages = record.messages as AgentMessage[];

    // 先补问卷答案：不然配对修复会把那条 ask_user 补成"中断、没有结果"
    const pending = await store.listPendingSurveys(sessionId);
    if (pending.length > 0) {
      const survey = createCliSurvey();
      const answered: Array<{ toolCallId: string; answers: Record<string, string> }> = [];
      for (const s of pending) {
        console.log(`\n[恢复] 发现未回答的问卷，${s.questions.length} 题`);
        const answers = await survey(s.questions);
        await store.answerSurvey(s.surveyId, answers);
        answered.push({ toolCallId: s.toolCallId, answers });
      }
      const injected = injectSurveyResults(messages, answered);
      messages = injected.messages;
      console.log(`[恢复] 已把 ${injected.injected} 份问卷答案补回上下文`);
    }

    const repaired = repairToolPairing(messages);
    console.log(
      `[恢复] 会话 ${sessionId}，消息 ${repaired.messages.length} 条，修复配对 ${repaired.repaired} 处`,
    );
    resumeMessages = repaired.messages;
  }

  const outbox = new Outbox(
    store,
    new MockDevice(join(projectRoot, "data", "ledger.jsonl")),
  );

  const result = await runSession({
    store,
    personId,
    goal,
    model: resolveModel(),
    survey: createCliSurvey(),
    confirm: createCliConfirm(),
    review: createCliReview(),
    outbox,
    sessionId,
    requestId,
    pageContext: screen ? { screen } : undefined,
    maxContextMessages: 40,
    resumeMessages,
    onEvent: (event) => {
      if (event.type === "tool_execution_start") {
        console.log(`\n→ 调用工具 ${event.toolName} ${JSON.stringify(event.args).slice(0, 160)}`);
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    },
  });

  console.log("\n\n—— 本次会话 ——");
  console.log(`sessionId: ${result.sessionId}`);
  console.log(`轮次/工具调用: ${result.stats.turns} / ${result.stats.toolCalls}`);
  if (result.stats.exceededReason) console.log(`已中断: ${result.stats.exceededReason}`);
  for (const card of result.finalCards) {
    console.log(`- ${card.title} → ${card.status}${card.receipt ? ` (回执 ${card.receipt.status})` : ""}`);
  }
  for (const text of result.appliedMemories) console.log(`+ 记忆: ${text}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});