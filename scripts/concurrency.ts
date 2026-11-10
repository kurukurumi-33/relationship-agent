/**
 * 跨进程并发测试：两个独立进程同时改同一条记忆。
 *
 *   npm run concurrency
 *   DATABASE_URL=postgresql://... npm run concurrency
 *
 * 为什么不用 worker_threads：线程在同一个进程里，共享内存空间，
 * "这算不算多实例"就说不清了。fork 出来的是独立 PID、独立连接池。
 *
 * 同步用 IPC 闸门：两个子进程先各自读一次 generation，报告给父进程，
 * 父进程确认两边读到同一版本后才同时放行 —— 保证它们真的在“同一个旧版本”上竞争。
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store/store.js";
import type { StorePort } from "../src/store/port.js";

const PERSON = "p_race";
const EVIDENCE = "ev_race";
const ROUNDS = 3;
const DEFAULT_URL = "postgresql://relation:relation@localhost:5432/relation";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---------------------------------------------------------------- 子进程

async function runChild(): Promise<void> {
  const url = process.env.RACE_URL!;
  const store = await openStore({ url });

  const doc = await store.getMemoryDoc(PERSON);
  process.send!({ type: "ready", gen: doc.generation, pid: process.pid });

  await new Promise<void>((resolve) => {
    process.once("message", (message) => {
      if (message === "go") resolve();
    });
  });

  try {
    await store.commitMemory(PERSON, doc.generation, [
      { text: `race-${process.pid}`, sourceIds: [EVIDENCE] },
    ]);
    process.send!({ type: "result", ok: true, pid: process.pid });
  } catch (err) {
    const error = err as Error;
    process.send!({
      type: "result",
      ok: false,
      pid: process.pid,
      error: error.name,
      message: error.message,
    });
  }

  await store.close();
  process.exit(0);
}

// ---------------------------------------------------------------- 父进程

interface ReadyMessage {
  type: "ready";
  gen: number;
  pid: number;
}
interface ResultMessage {
  type: "result";
  ok: boolean;
  pid: number;
  error?: string;
  message?: string;
}

function waitFor<T>(child: ReturnType<typeof fork>, type: string, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", handler);
      reject(new Error(`子进程 ${child.pid} 在 ${timeoutMs}ms 内没有返回 ${type}`));
    }, timeoutMs);
    const handler = (message: T & { type?: string }) => {
      if (message?.type !== type) return;
      clearTimeout(timer);
      child.off("message", handler);
      resolve(message);
    };
    child.on("message", handler);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`子进程 ${child.pid} 提前退出，code=${code}`));
    });
  });
}

async function ensureFixture(store: StorePort): Promise<void> {
  const now = new Date().toISOString();
  await store.importState({
    persons: {
      [PERSON]: {
        personId: PERSON,
        name: "并发测试对象",
        relation: "测试专用",
        tags: [],
        createdAt: now,
      },
    },
    evidence: {
      [EVIDENCE]: {
        evidenceId: EVIDENCE,
        personId: PERSON,
        kind: "manual",
        capturedAt: now,
        title: "并发测试证据",
        content: "只用于并发写入校验，不含真实信息",
        sourceRef: "test://race",
      },
    },
  });
}

async function runRound(url: string, round: number): Promise<{ passed: boolean; detail: string }> {
  const children = [1, 2].map(() =>
    fork(fileURLToPath(import.meta.url), ["--child"], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, RACE_URL: url },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    }),
  );

  const readyPromises = children.map((c) => waitFor<ReadyMessage>(c, "ready"));
  const readies = await Promise.all(readyPromises);

  if (readies[0]!.gen !== readies[1]!.gen) {
    children.forEach((c) => c.kill());
    return {
      passed: false,
      detail: `第 ${round} 轮：两个进程读到的版本不同（${readies[0]!.gen} vs ${readies[1]!.gen}），本轮无效`,
    };
  }

  const resultPromises = children.map((c) => waitFor<ResultMessage>(c, "result"));
  for (const child of children) child.send("go");
  const results = await Promise.all(resultPromises);

  const winners = results.filter((r) => r.ok);
  const conflicts = results.filter((r) => !r.ok && r.error === "GenerationConflictError");

  const passed = winners.length === 1 && conflicts.length === 1;
  const detail = `第 ${round} 轮：读到的版本 ${readies[0]!.gen}，成功 ${winners.length}，冲突 ${conflicts.length}` +
    results.map((r) => `\n      pid ${r.pid}: ${r.ok ? "成功" : `${r.error}`}`).join("");

  return { passed, detail };
}

async function runHost(): Promise<void> {
  const url = arg("url") ?? process.env.DATABASE_URL ?? DEFAULT_URL;
  console.log(`数据库: ${url}`);

  const store = await openStore({ url });
  await ensureFixture(store);

  const before = await store.getMemoryDoc(PERSON);
  const startGen = before.generation;
  const startItems = before.items.length;
  console.log(`起始：generation=${startGen}，记忆 ${startItems} 条\n`);

  let failures = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const outcome = await runRound(url, round);
    console.log(`  ${outcome.passed ? "✓" : "✗"} ${outcome.detail}`);
    if (!outcome.passed) failures += 1;
  }

  const after = await store.getMemoryDoc(PERSON);
  const genDelta = after.generation - startGen;
  const itemDelta = after.items.length - startItems;

  console.log(`\n结果：generation +${genDelta}，记忆 +${itemDelta}`);
  const genOk = genDelta === ROUNDS;
  const itemsOk = itemDelta === ROUNDS;
  console.log(`  ${genOk ? "✓" : "✗"} generation 只增加 ${ROUNDS}`);
  console.log(`  ${itemsOk ? "✓" : "✗"} 每轮只有一条写入落库`);
  if (!genOk || !itemsOk) failures += 1;

  await store.close();
  console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
  process.exitCode = failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- 入口

if (process.argv.includes("--child")) {
  runChild().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runHost().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}