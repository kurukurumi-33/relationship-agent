/**
 * 轨迹回放：给一个 requestId / sessionId / personId，把这条链路按时间线打出来。
 *
 * 这是三层评测里的第 2 层：不判断"答得好不好"，只看"流程对不对"——
 * 有没有多余调用、有没有重复执行、中断恢复是否正常、卡在哪一步。
 *
 *   npm run trace -- --request req_xxx
 *   npm run trace -- --session sess_xxx
 *   npm run trace -- --person p_001
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/store/store.js";
import { sumUsage } from "../src/session/run.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function line(time: string | undefined, tag: string, detail: string): string {
  return `${time ?? "----"}  ${tag.padEnd(12)} ${detail}`;
}

async function main(): Promise<void> {
  const storePath = arg("store") ?? join(root, "data", "state.db");
  const store = await Store.open(storePath);

  const requestId = arg("request");
  const sessionId = arg("session");
  const personId = arg("person");

  if (requestId) {
    const card = await store.getAction(requestId);
    console.log(`\n[行动卡 ${requestId}] ${card.title}`);
    console.log(line(card.createdAt, "proposed", `来源 ${card.sourceIds.join(",")}（当前 revision v${card.cardVersion}）`));
    if (card.confirmedAt) console.log(line(card.confirmedAt, "confirmed", "用户确认"));
    if (card.submittedAt) console.log(line(card.submittedAt, "submitted", `第 ${card.attempts ?? 1} 次提交`));
    if (card.receipt) {
      console.log(
        line(
          card.receipt.at,
          card.receipt.status === "failed" ? "failed" : "receipt",
          `${card.receipt.status}${card.receipt.retryable ? "（可重试）" : ""} ${card.receipt.detail ?? ""}`,
        ),
      );
    }
    console.log(`当前状态: ${card.status}`);
    return;
  }

  if (sessionId) {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`会话 ${sessionId} 不存在`);
    console.log(`\n[会话 ${sessionId}] person=${session.personId} request=${session.requestId ?? "-"}`);
    console.log(`开始 ${session.createdAt}，最后更新 ${session.updatedAt}`);
    if (session.pageContext) console.log(`页面上下文: ${JSON.stringify(session.pageContext)}`);

    console.log("\n消息轨迹：");
    const messages = session.messages as Array<{
      role: string;
      content?: unknown;
      toolCallId?: string;
    }>;
    messages.forEach((m, i) => {
      let detail = "";
      if (Array.isArray(m.content)) {
        detail = m.content
          .map((b) => {
            const block = b as { type: string; text?: string; name?: string; id?: string };
            if (block.type === "text") return (block.text ?? "").slice(0, 80);
            if (block.type === "toolCall") return `→ ${block.name}(${block.id})`;
            return "";
          })
          .filter(Boolean)
          .join(" | ");
      } else if (typeof m.content === "string") {
        detail = m.content.slice(0, 80);
      }
      console.log(`${String(i).padStart(2)} ${m.role.padEnd(10)} ${detail}`);
    });

    const surveys = await store.listSurveys(sessionId);
    if (surveys.length > 0) {
      console.log("\n问卷：");
      for (const s of surveys) {
        console.log(
          `  ${s.toolCallId}  问题 ${s.questions.length} 个  状态 ${s.answers ? "已答" : "未答（可恢复）"}`,
        );
      }
    }

    const compaction = await store.getCompaction(sessionId);
    if (compaction) {
      console.log(
        `\n压缩：generation=${compaction.generation}，丢弃 ${compaction.droppedMessages} 条，保留 ${compaction.keptMessages} 条`,
      );
    }

    const usage = sumUsage(session.messages as AgentMessage[]);
    console.log(
      `\n用量：输入 ${usage.input} / 输出 ${usage.output} / 缓存读 ${usage.cacheRead} / 合计 ${usage.totalTokens} tokens`,
    );

    const access = await store.listAccess({ sessionId });
    if (access.length > 0) {
      console.log("\n证据访问：");
      for (const a of access) {
        console.log(
          `  ${a.at}  ${a.kind.padEnd(8)} ${a.evidenceId ?? a.query ?? ""}  (${a.actor})`,
        );
      }
    }

    const handoffs = (await store.listOpenHandoffs()).filter((h) => h.sessionId === sessionId);
    if (handoffs.length > 0) {
      console.log("\n待人工接管：");
      for (const h of handoffs) console.log(`  ${h.reason}  ${h.detail ?? ""}`);
    }
    return;
  }

  if (personId) {
    console.log(`\n[联系人 ${personId}]`);
    for (const card of await store.listActions(personId)) {
      console.log(
        `${card.requestId}  ${card.status.padEnd(10)} ${card.title}  ${card.receipt?.status ?? ""}`,
      );
    }
    console.log("\n会话：");
    for (const s of await store.listSessions(personId)) {
      const pending = (await store.listPendingSurveys(s.sessionId)).length;
      console.log(
        `  ${s.sessionId}  ${s.updatedAt}  request=${s.requestId ?? "-"}${pending ? `  未答问卷 ${pending} 份` : ""}`,
      );
    }
    return;
  }

  console.log("用法: npm run trace -- --request req_x | --session sess_x | --person p_001");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});