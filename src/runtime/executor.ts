import type { ActionCard, Receipt } from "../domain/types.js";
import type { Store } from "../store/store.js";
import type { Outbox } from "./outbox.js";

export interface ExecuteOutcome {
  requestId: string;
  /** 执行器退出时库里的最新状态 */
  status: ActionCard["status"];
  receipt?: Receipt;
  /** 被别的执行器抢先处理，不算失败 */
  skippedBecause?: string;
  error?: string;
}

export interface ExecuteOptions {
  personId?: string;
  limit?: number;
}

/**
 * 执行阶段：把所有 confirmed 的卡推给设备。
 *
 * 它和提议阶段完全解耦，所以可以在任意一次进程启动后跑：
 * 昨天提的案、用户今天点了确认、今晚的定时任务执行，这条链路不需要原会话还活着。
 *
 * 并发安全靠两层：Outbox 的进程内 in-flight 去重，加上 updateAction 的 cardVersion CAS。
 * 两个执行器同时拿到同一张 confirmed 卡，只有一个能把版本推进到 submitted。
 */
export async function executeConfirmed(
  store: Store,
  outbox: Outbox,
  opts: ExecuteOptions = {},
): Promise<ExecuteOutcome[]> {
  const confirmed = (await store.listActions(opts.personId)).filter(
    (c) => c.status === "confirmed",
  );
  const batch = opts.limit ? confirmed.slice(0, opts.limit) : confirmed;
  const outcomes: ExecuteOutcome[] = [];

  for (const card of batch) {
    try {
      const result = await outbox.submit(card);
      outcomes.push({
        requestId: card.requestId,
        status: result.card.status,
        receipt: result.receipt,
      });
    } catch (err) {
      // 版本冲突基本只有一个原因：另一个执行器已经接手了这张卡。
      // 以库里的最新状态为准，别把"别人做完了"报成错误。
      const message = (err as Error).message;
      const fresh = await store.getAction(card.requestId);
      if (fresh.status !== "confirmed") {
        outcomes.push({
          requestId: card.requestId,
          status: fresh.status,
          receipt: fresh.receipt,
          skippedBecause: message,
        });
      } else {
        outcomes.push({ requestId: card.requestId, status: fresh.status, error: message });
      }
    }
  }

  return outcomes;
}