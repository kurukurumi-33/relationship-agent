import type { ActionCard } from "../domain/types.js";
import type { Store } from "../store/store.js";
import type { DeviceAdapter } from "./device.js";

/**
 * 崩溃对账：处理"设备可能执行了、但系统不知道"的那一类卡。
 *
 * 场景：落盘 submitted → 调设备 → 设备真的执行了 → 进程在写回执前崩了。
 * 重启后这张卡停在 submitted、幂等表里没有回执，outbox 拒绝提交，也没有别的地方管它。
 *
 * 系统自己永远分不清下面两种情况——
 *   A. 设备执行了，回执没落盘
 *   B. 设备根本没收到，进程就崩了
 * 所以唯一正确的动作是"去问设备"，而不是"猜"。
 */

export type ReconcileOutcome = "adopted" | "resumed" | "escalated";

export interface ReconcileItem {
  requestId: string;
  outcome: ReconcileOutcome;
  detail: string;
}

export interface ReconcileReport {
  scanned: number;
  adopted: number;
  resumed: number;
  escalated: number;
  items: ReconcileItem[];
}

export interface ReconcileOptions {
  /** 只看提交时间早于这么久之前的卡，避免和正在飞的请求打架 */
  olderThanMs?: number;
  /** 回退重发的次数上限（含第一次） */
  maxAttempts?: number;
  now?: Date;
}

export async function reconcile(
  store: Store,
  device: DeviceAdapter,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const stuck = await store.listStuckActions({
    olderThanMs: opts.olderThanMs ?? 5 * 60 * 1000,
    now: opts.now,
  });
  const maxAttempts = opts.maxAttempts ?? 2;

  const report: ReconcileReport = {
    scanned: stuck.length,
    adopted: 0,
    resumed: 0,
    escalated: 0,
    items: [],
  };

  const escalate = async (card: ActionCard, detail: string): Promise<void> => {
    await store.createHandoff({
      sessionId: card.sessionId ?? "unknown",
      personId: card.personId,
      reason: "device-failed",
      detail: `${card.requestId}: ${detail}`,
    });
    report.escalated += 1;
    report.items.push({ requestId: card.requestId, outcome: "escalated", detail });
  };

  for (const card of stuck) {
    try {
      // 设备不支持查询 → 我们没有任何可靠信息，只能交给人
      if (!device.lookup) {
        await escalate(card, "设备不支持幂等查询，无法判断是否已执行");
        continue;
      }

      let receipt;
      try {
        receipt = await device.lookup(card.requestId);
      } catch (err) {
        // 查询本身失败 ≠ 设备没有执行过。不确定就不猜。
        await escalate(card, `设备查询失败: ${(err as Error).message}`);
        continue;
      }

      if (receipt) {
        // 结局一：设备说做过 —— 采纳它的回执，补上缺失的那一次落盘。
        // 回执和状态必须原子写入，否则会出现"有回执但状态还停在 submitted"。
        await store.adoptReceipt(card, receipt);
        report.adopted += 1;
        report.items.push({
          requestId: card.requestId,
          outcome: "adopted",
          detail: `设备回执 ${receipt.status}，已补写并推进状态`,
        });
        continue;
      }

      // 结局二：设备明确没有 —— 可以安全回到 confirmed，交给 outbox 正常重发
      if ((card.attempts ?? 1) >= maxAttempts) {
        await escalate(card, `设备明确没有，但已达到重试上限 ${maxAttempts}`);
        continue;
      }
      await store.updateAction(card.requestId, card.cardVersion, {
        status: "confirmed",
        submittedAt: undefined,
      });
      report.resumed += 1;
      report.items.push({
        requestId: card.requestId,
        outcome: "resumed",
        detail: "设备侧无记录，已回退到 confirmed，可安全重发",
      });
    } catch (err) {
      // 对账本身出错（比如版本冲突）：绝不吞掉，交给人
      await escalate(card, `对账异常: ${(err as Error).message}`);
    }
  }

  return report;
}