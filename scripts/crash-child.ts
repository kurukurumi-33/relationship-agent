/**
 * 崩溃压测的被试进程。单独成文件，因为父进程要在它跑到一半时直接杀掉。
 *
 *   --mode setup  灌库：n 张 confirmed 卡，然后正常退出
 *   --mode run    逐张提交，跑完自然退出；跑不完就被 SIGKILL 打断
 *
 * 设备在这里故意慢半拍：先写设备账本，再等 delayMs 才把回执交回去。
 * 这几十毫秒就是"设备已经做了、系统还不知道"的真实窗口。
 */
import { Store } from "../src/store/store.js";
import { seedState } from "../src/data/seed.js";
import { MockDevice } from "../src/runtime/device.js";
import type { DeviceAdapter } from "../src/runtime/device.js";
import { Outbox } from "../src/runtime/outbox.js";
import type { ActionCard, Receipt } from "../src/domain/types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class SlowDevice implements DeviceAdapter {
  readonly id = "crash-slow-mock";
  private readonly base: MockDevice;

  constructor(
    ledgerPath: string,
    private readonly preDelayMs: number,
    private readonly postDelayMs: number,
  ) {
    this.base = new MockDevice(ledgerPath);
  }

  async execute(card: ActionCard): Promise<Receipt> {
    // 请求还在路上：系统已经落盘 submitted，设备还没收到。
    // 在这个窗口被杀，对账应该判"设备确实没做过"，回退重发。
    if (this.preDelayMs > 0) await sleep(this.preDelayMs);
    const receipt = await this.base.execute(card);
    // 设备已经写了账本，回执还在返回路上。
    // 在这个窗口被杀，对账应该判"做过了"，采纳回执而不是重发。
    await sleep(this.postDelayMs);
    return receipt;
  }

  lookup(requestId: string): Promise<Receipt | undefined> {
    return this.base.lookup(requestId);
  }
}

async function main(): Promise<void> {
  const storePath = arg("store");
  const ledgerPath = arg("ledger");
  if (!storePath || !ledgerPath) throw new Error("缺少 --store / --ledger");

  const n = Number(arg("n") ?? 100);
  const preDelayMs = Number(arg("pre-delay") ?? 0);
  const postDelayMs = Number(arg("delay") ?? 40);
  const mode = arg("mode") ?? "run";

  if (mode === "setup") {
    await Store.reset(storePath);
    const store = await Store.open(storePath);
    await store.seedIfEmpty(seedState);
    for (let i = 0; i < n; i += 1) {
      const card = await store.createAction({
        personId: "p_001",
        kind: "reminder",
        title: `crash-${i}`,
        payload: { at: "2026-11-20T09:00:00+08:00" },
        reason: "崩溃恢复压测",
        sourceIds: ["ev_001"],
      });
      await store.updateAction(card.requestId, card.cardVersion, {
        status: "confirmed",
        confirmedAt: new Date().toISOString(),
      });
    }
    await store.close();
    return;
  }

  const store = await Store.open(storePath);
  const outbox = new Outbox(store, new SlowDevice(ledgerPath, preDelayMs, postDelayMs), 3);

  const cards = (await store.listActions("p_001")).filter((c) => c.status === "confirmed");
  for (const card of cards) {
    try {
      await outbox.submit(card);
    } catch {
      // 单张失败不影响继续；父进程只看最终收敛
    }
  }
  await store.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});