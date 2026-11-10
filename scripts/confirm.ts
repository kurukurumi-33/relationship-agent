/**
 * 异步确认：可以隔天、换进程来做。
 *
 *   npm run pending
 *   npm run confirm -- --request req_xxx --version 1
 *   npm run confirm -- --request req_xxx --version 1 --reject
 *   npm run confirm -- --candidate cand_xxx
 *   npm run confirm -- --candidate cand_xxx --reject
 *
 * 行动卡必须带上你看到的那一版版本号；提案被改过的话旧版本号会被拒。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store, GenerationConflictError } from "../src/store/store.js";
import { confirmAction } from "../src/runtime/confirm.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function approveCandidate(store: Store, candidateId: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = await store.getCandidate(candidateId);
    const doc = await store.getMemoryDoc(candidate.personId);
    try {
      await store.commitCandidate(candidateId, doc.generation);
      console.log(`候选 ${candidateId} 已写入长期记忆（v${doc.generation + 1}）`);
      return;
    } catch (err) {
      if (!(err instanceof GenerationConflictError) || attempt === 1) throw err;
      console.log("记忆版本冲突，重读后重试一次");
    }
  }
}

async function main(): Promise<void> {
  const storePath = arg("store") ?? join(root, "data", "state.db");
  const reject = process.argv.includes("--reject");
  const requestId = arg("request");
  const candidateId = arg("candidate");

  if (!requestId && !candidateId) {
    console.error("用法: --request <id> --version <n> [--reject]  或  --candidate <id> [--reject]");
    process.exitCode = 1;
    return;
  }

  const store = await Store.open(storePath);

  if (requestId) {
    const raw = arg("version");
    if (!raw) {
      console.error("确认行动卡必须提供 --version（pending 命令里能看到）");
      process.exitCode = 1;
      return;
    }
    const card = await confirmAction(store, {
      requestId,
      cardVersion: Number(raw),
      decision: reject ? "reject" : "approve",
    });
    console.log(`行动卡 ${card.requestId} → ${card.status}（v${card.cardVersion}）`);
    if (card.status === "confirmed") {
      console.log("下一步: npm run execute");
    }
  }

  if (candidateId) {
    if (reject) {
      const c = await store.reviewCandidate(candidateId, "rejected", "用户在审核时拒绝");
      console.log(`候选 ${c.candidateId} → ${c.status}`);
    } else {
      await approveCandidate(store, candidateId);
    }
  }

  await store.close();
}

main().catch((err) => {
  console.error(`确认失败: ${(err as Error).message}`);
  process.exitCode = 1;
});