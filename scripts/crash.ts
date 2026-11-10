/**
 * 崩溃恢复压测：进程在"设备已执行、回执未落盘"的窗口里被强杀，重启后能不能收敛。
 *
 *   npm run crash
 *   npm run crash -- --rounds 10 --n 100 --seed 7
 *
 * 每一轮：
 *   1. 子进程灌 n 张 confirmed 卡后退出
 *   2. 再起一个子进程逐张提交；父进程按随机延迟把它 SIGKILL 掉
 *   3. 重启，跑"对账 → 重发 → 再对账"直到收敛
 *
 * 关键指标是**重复副作用**：对账要是判错，设备就会被执行第二次。
 * 其余：恢复正确率、悬挂、状态误报、人工接管。
 */
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { Store } from "../src/store/store.js";
import { MockDevice } from "../src/runtime/device.js";
import { Outbox } from "../src/runtime/outbox.js";
import { reconcile } from "../src/runtime/reconcile.js";
import type { Receipt } from "../src/domain/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const childPath = join(here, "crash-child.ts");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spawnChild(args: string[]) {
  const child = fork(childPath, args, {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr?.pipe(process.stderr);
  return child;
}

async function readLedger(path: string): Promise<Map<string, Receipt[]>> {
  const byRequest = new Map<string, Receipt[]>();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return byRequest;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { card: { requestId: string }; receipt: Receipt };
      const list = byRequest.get(entry.card.requestId) ?? [];
      list.push(entry.receipt);
      byRequest.set(entry.card.requestId, list);
    } catch {
      // 半截行（被杀时正写到一半）忽略
    }
  }
  return byRequest;
}

interface RoundResult {
  killAfterMs: number;
  inFlight: number;
  acted: number;
  recovered: number;
  duplicates: number;
  stuck: number;
  misreported: number;
  handoffs: number;
  adopted: number;
  resumed: number;
  escalated: number;
}

async function runRound(
  round: number,
  opts: { n: number; delayMs: number; preDelayMs: number; killAfterMs: number },
): Promise<RoundResult> {
  const storePath = join(root, "data", `crash-${round}.db`);
  const ledgerPath = join(root, "data", `crash-${round}.jsonl`);
  await rm(ledgerPath, { force: true });

  const setup = spawnChild([
    "--mode", "setup", "--store", storePath, "--ledger", ledgerPath, "--n", String(opts.n),
  ]);
  const [setupCode] = (await once(setup, "exit")) as [number | null];
  if (setupCode !== 0) throw new Error(`灌库进程退出码 ${setupCode}`);

  const crashed = spawnChild([
    "--mode", "run", "--store", storePath, "--ledger", ledgerPath,
    "--n", String(opts.n), "--delay", String(opts.delayMs),
    "--pre-delay", String(opts.preDelayMs),
  ]);
  await sleep(opts.killAfterMs);
  crashed.kill("SIGKILL");
  await once(crashed, "exit");

  const store = await Store.open(storePath);
  const afterCrash = await store.listActions("p_001");
  const inFlight = afterCrash.filter((c) => c.status === "submitted").map((c) => c.requestId);
  const ledgerAtCrash = await readLedger(ledgerPath);
  const acted = inFlight.filter((id) => (ledgerAtCrash.get(id)?.length ?? 0) > 0).length;

  // 重启后的恢复：对账 → 重发回退到 confirmed 的卡 → 再对账，最多三轮直到收敛
  const device = new MockDevice(ledgerPath);
  const outbox = new Outbox(store, device, 3);
  let adopted = 0;
  let resumed = 0;
  let escalated = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const report = await reconcile(store, device, { olderThanMs: 0 });
    adopted += report.adopted;
    resumed += report.resumed;
    escalated += report.escalated;

    const retryable = (await store.listActions("p_001")).filter((c) => c.status === "confirmed");
    if (retryable.length === 0 && report.resumed === 0) break;
    for (const card of retryable) {
      const fresh = await store.getAction(card.requestId);
      if (fresh.status !== "confirmed") continue;
      try {
        await outbox.submit(fresh);
      } catch {
        // 留给下一轮对账
      }
    }
  }
  await reconcile(store, device, { olderThanMs: 0 });

  const cards = await store.listActions("p_001");
  const ledger = await readLedger(ledgerPath);
  const handoffs = await store.listOpenHandoffs("p_001");

  const inFlightSet = new Set(inFlight);
  let recovered = 0;
  let duplicates = 0;
  let stuck = 0;
  let misreported = 0;

  for (const card of cards) {
    const receipts = ledger.get(card.requestId) ?? [];
    if (receipts.length > 1) duplicates += 1;
    if (card.status === "submitted" || card.status === "confirmed" || card.status === "proposed") {
      stuck += 1;
    }
    const deviceSucceeded = receipts.some((r) => r.status === "ok" || r.status === "partial");
    if (card.status === "failed" && deviceSucceeded) misreported += 1;
    if (card.status === "executed" && receipts.length === 0) misreported += 1;

    if (inFlightSet.has(card.requestId)) {
      const terminal = card.status === "executed" || card.status === "failed";
      if (terminal && receipts.length === 1) recovered += 1;
    }
  }

  await store.close();

  return {
    killAfterMs: opts.killAfterMs,
    inFlight: inFlight.length,
    acted,
    recovered,
    duplicates,
    stuck,
    misreported,
    handoffs: handoffs.length,
    adopted,
    resumed,
    escalated,
  };
}

async function main(): Promise<void> {
  const rounds = Number(arg("rounds") ?? 5);
  const n = Number(arg("n") ?? 100);
  const delayMs = Number(arg("delay") ?? 40);
  const preDelayMs = Number(arg("pre-delay") ?? 0);
  const seed = Number(arg("seed") ?? 42);
  const minKill = Number(arg("kill-min") ?? 300);
  const maxKill = Number(arg("kill-max") ?? 900);
  const rng = mulberry32(seed);

  const results: RoundResult[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const killAfterMs = Math.round(minKill + rng() * (maxKill - minKill));
    process.stdout.write(
      `第 ${round + 1}/${rounds} 轮：${killAfterMs}ms 后强杀… `,
    );
    const result = await runRound(round, { n, delayMs, preDelayMs, killAfterMs });
    results.push(result);
    console.log(
      `在飞 ${result.inFlight}（设备已执行 ${result.acted}），恢复 ${result.recovered}，重复 ${result.duplicates}`,
    );
  }

  const total = (pick: (r: RoundResult) => number) => results.reduce((s, r) => s + pick(r), 0);
  const cards = n * rounds;
  const inFlight = total((r) => r.inFlight);
  const recovered = total((r) => r.recovered);
  const pct = (x: number, d: number) => (d === 0 ? "—" : `${((x / d) * 100).toFixed(1)}%`);

  console.log(`\n崩溃恢复压测  ${rounds} 轮 × ${n} 张 = ${cards} 张，seed=${seed}`);
  console.log(`设备延迟：请求在路上 ${preDelayMs}ms，回执在路上 ${delayMs}ms`);
  console.log(`强杀窗口 ${minKill}~${maxKill}ms`);
  console.log(`\n【被打断的卡】`);
  console.log(`  处于 submitted（在飞）    ${inFlight}`);
  console.log(`  其中设备已经执行          ${total((r) => r.acted)}  （应采纳回执）`);
  console.log(`  其中设备还没执行          ${inFlight - total((r) => r.acted)}  （应回退重发）`);
  console.log(`  恢复正确                  ${recovered}  (${pct(recovered, inFlight)})`);
  console.log(`\n【全局指标】`);
  console.log(`  重复副作用                ${total((r) => r.duplicates)} 条`);
  console.log(`  悬挂                      ${total((r) => r.stuck)} 条`);
  console.log(`  状态误报                  ${total((r) => r.misreported)} 条`);
  console.log(`  人工接管                  ${total((r) => r.handoffs)} 条`);
  console.log(
    `\n【对账】累计采纳 ${total((r) => r.adopted)}，回退 ${total((r) => r.resumed)}，升级 ${total((r) => r.escalated)}`,
  );
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});