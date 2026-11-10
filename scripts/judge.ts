/**
 * 语义评测的入口（第 3 层）。
 *
 * 现在跑的是规则 Judge：只核对"引用是否真实存在""有没有谎称执行"。
 * 它不是语义评测，别把它的分数当成"回答质量"。
 *
 *   npm run judge -- --session sess_xxx
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/store/store.js";
import { createRuleJudge } from "../src/eval/judge.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const sessionId = arg("session");
  if (!sessionId) {
    console.log("用法: npm run judge -- --session sess_xxx");
    return;
  }

  const store = await Store.open(arg("store") ?? join(root, "data", "state.db"));
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`会话 ${sessionId} 不存在`);

  const messages = session.messages as Array<{
    role: string;
    content: Array<{ type: string; text?: string }>;
  }>;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const answer = (lastAssistant?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

  const evidence = (await store.listEvidence(session.personId)).map((e) => ({
    evidenceId: e.evidenceId,
    title: e.title,
  }));

  const goalMessage = messages.find((m) => m.role === "user") as
    | { content: Array<{ type: string; text?: string }> }
    | undefined;
  const goal = (goalMessage?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

  const verdict = await createRuleJudge().judge({
    goal,
    answer,
    evidence,
    cards: await store.listActions(session.personId),
  });

  console.log(`\n[judge: rule] session=${sessionId}`);
  console.log(`  目标: ${goal.slice(0, 60)}`);
  console.log(`  引用可信度 groundedness   = ${verdict.groundedness.toFixed(2)}`);
  console.log(`  执行诚实度 executionHonesty = ${verdict.executionHonesty.toFixed(2)}`);
  console.log(`  相关性     relevance        = ${verdict.relevance.toFixed(2)}`);
  for (const note of verdict.notes) console.log(`  · ${note}`);
  console.log("\n注：规则 Judge 只核对结构与引用，不做语义判断；语义评测需接 createLlmJudge。");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});