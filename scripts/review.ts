/**
 * 人工审核待确认证据。
 *
 *   npm run review
 *   npm run review -- --accept ev_xxx
 *   npm run review -- --accept ev_xxx --content "OCR 出来的正文" --title "聊天截图：周末"
 *   npm run review -- --reject ev_xxx
 *
 * 待确认证据不进快照、不参与检索、模型也读不到。接受后立刻变成可用证据；
 * 拒绝后保留来源指针，状态记为 rejected，供审计追溯。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/store/store.js";
import { deriveSummary } from "../src/ingest/evidence.js";
import type { Evidence } from "../src/domain/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const DAY_MS = 24 * 60 * 60 * 1000;
/** 人工确认后再开始计算保留期：确认之前原文不能被清掉 */
const RETENTION_MS: Partial<Record<Evidence["kind"], number>> = {
  screenshot: DAY_MS,
  calendar: 90 * DAY_MS,
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const store = await Store.open(arg("store") ?? join(root, "data", "state.db"));
  const accept = arg("accept");
  const reject = arg("reject");

  try {
    if (!accept && !reject) {
      await listPending(store);
      return;
    }
    if (accept && reject) {
      console.error("一次只能处理一个：--accept 或 --reject");
      process.exitCode = 1;
      return;
    }

    const evidenceId = (accept ?? reject)!;
    const current = await store.getEvidence(evidenceId);

    if (reject) {
      const rejected = await store.updateEvidence(evidenceId, { status: "rejected" });
      console.log(`已拒绝 ${rejected.evidenceId}  ${rejected.title}`);
      return;
    }

    const content = arg("content") ?? current.content;
    if (!content.trim()) {
      console.error(
        `证据 ${evidenceId} 没有正文（原因：${current.summary ?? "未知"}）。\n` +
          "接受前请用 --content \"OCR 结果\" 补上正文。",
      );
      process.exitCode = 1;
      return;
    }

    const accepted = await store.updateEvidence(evidenceId, {
      status: "active",
      title: arg("title") ?? current.title.replace(/^待确认：/, ""),
      content,
      summary: deriveSummary(content),
      // 确认之前不设过期，确认之后才按材料类型重新计时
      expiresAt:
        current.expiresAt ??
        (RETENTION_MS[current.kind]
          ? new Date(Date.now() + RETENTION_MS[current.kind]!).toISOString()
          : undefined),
    });
    console.log(`已接受 ${accepted.evidenceId}  ${accepted.title}`);
    if (accepted.expiresAt) console.log(`保留至 ${accepted.expiresAt}`);
    console.log("这条证据现在会进入快照，也可以被模型检索和读取。");
  } finally {
    await store.close();
  }
}

async function listPending(store: Store): Promise<void> {
  const pending: Evidence[] = [];
  for (const person of await store.listPersons()) {
    for (const evidence of await store.listEvidence(person.personId)) {
      if (evidence.status === "pending_review") pending.push(evidence);
    }
  }

  if (pending.length === 0) {
    console.log("没有待确认的证据。");
    return;
  }

  for (const evidence of pending) {
    console.log(
      `${evidence.evidenceId}  ${evidence.personId}  ${evidence.kind.padEnd(10)} ${evidence.title}`,
    );
    console.log(`  来源：${evidence.sourceRef}`);
    if (evidence.summary) console.log(`  原因：${evidence.summary}`);
  }
  console.log(`\n共 ${pending.length} 条待确认。`);
  console.log('接受：npm run review -- --accept <id> [--content "正文"] [--title "标题"]');
  console.log("拒绝：npm run review -- --reject <id>");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});