/**
 * 从真实会话生成用例草稿 —— 数据平台的入口。
 *
 *   npm run collect -- --session sess_xxx
 *
 * 这是"评测闭环"最容易被忽略的一环：线上/试跑里出了个问题，
 * 如果你只是改代码，这个问题下次还会回来；把它变成一条用例，才叫真的修了。
 *
 * 生成的是草稿：script 从会话的 assistant 消息还原，
 * expect 留空需要人来填——因为"这次到底哪里不对"只有人知道。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/store/store.js";
import type { EvalCase, ScriptStep } from "../src/eval/case.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface MessageLike {
  role: string;
  content: unknown;
}

function scriptFromSession(messages: MessageLike[]): ScriptStep[] {
  const steps: ScriptStep[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as Array<{ type: string; text?: string; name?: string; arguments?: Record<string, unknown> }>) {
      if (block.type === "toolCall" && block.name) {
        steps.push({ toolCall: { name: block.name, arguments: block.arguments ?? {} } });
      } else if (block.type === "text" && block.text) {
        steps.push({ text: block.text });
      }
    }
  }
  return steps;
}

async function main(): Promise<void> {
  const sessionId = arg("session");
  if (!sessionId) {
    console.log("用法: npm run collect -- --session sess_xxx [--out evals/cases/_inbox]");
    return;
  }

  const store = await Store.open(arg("store") ?? join(root, "data", "state.db"));
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`会话 ${sessionId} 不存在`);

  const messages = session.messages as MessageLike[];
  const firstUser = messages.find((m) => m.role === "user");
  const goal =
    firstUser && Array.isArray(firstUser.content)
      ? (firstUser.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
      : "";
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const answer =
    lastAssistant && Array.isArray(lastAssistant.content)
      ? (lastAssistant.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("")
      : "";

  const draft: EvalCase = {
    id: `draft-${sessionId.replace(/[^a-z0-9]/gi, "-")}`,
    title: `从会话 ${sessionId} 回收的用例（待补期望值）`,
    tags: ["unlabeled"],
    goal: goal || "（原会话没有用户消息）",
    personId: session.personId,
    script: scriptFromSession(messages),
    expect: {},
  };

  const outDir = arg("out") ?? join(root, "evals", "cases", "_inbox");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${draft.id}.json`);
  await writeFile(outPath, JSON.stringify(draft, null, 2), "utf8");

  console.log(`已生成草稿: ${outPath}`);
  console.log(`  还原了 ${draft.script?.length ?? 0} 个模型步骤`);
  console.log(`  原会话最终回答: ${answer.slice(0, 60)}${answer.length > 60 ? "…" : ""}`);
  console.log("\n下一步：打开文件，把 expect 填上（这次到底哪里不对），再移到 evals/cases/ 下。");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});