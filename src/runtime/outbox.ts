import type { ActionCard, Receipt } from "../domain/types.js";
import type { DeviceAdapter } from "./device.js";
import type { Store } from "../store/store.js";

export interface SubmitResult {
  card: ActionCard;
  receipt: Receipt;
  /** true 表示命中了幂等表，没有真的再执行一次 */
  reused: boolean;
}

/**
 * 出站队列：唯一能把"用户已确认"变成"设备真的执行了"的组件。
 *
 * 状态机：confirmed → submitted →（回执）executed / failed
 *
 * 幂等设计：
 *   - 外层按 requestId 去重（进程内 in-flight + 持久化幂等表），
 *     同一个提案点两次确认不会发两条消息；
 *   - 提交前把状态先写成 submitted 并落盘，进程崩了重启也能看出"这条在飞行中"；
 *   - 重试只允许发生在没有回执的情况下。
 */
export class Outbox {
  private readonly inFlight = new Map<string, Promise<SubmitResult>>();

  constructor(
    private readonly store: Store,
    private readonly device: DeviceAdapter,
    /** 可重试失败的最大尝试次数；只有回执判定 retryable 才用得上 */
    private readonly maxAttempts = 2,
  ) {}

  async submit(card: ActionCard): Promise<SubmitResult> {
    const pending = this.inFlight.get(card.requestId);
    if (pending) return pending;

    const task = this.doSubmit(card).finally(() => this.inFlight.delete(card.requestId));
    this.inFlight.set(card.requestId, task);
    return task;
  }

  private async doSubmit(card: ActionCard): Promise<SubmitResult> {
    const existing = await this.store.getReceipt(card.requestId);
    const current0 = await this.store.getAction(card.requestId);
    const attempts = current0.attempts ?? 0;

    // 有回执就不重发，除非它明确是可重试的冲突类失败，且没超过尝试次数。
    // "有回执"意味着设备已经动过，盲目重试会造成重复副作用。
    const retryAllowed =
      existing?.status === "failed" && existing.retryable === true && attempts < this.maxAttempts;

    if (existing && !retryAllowed) {
      return { card: current0, receipt: existing, reused: true };
    }

    const current = current0;
    const canSubmit =
      current.status === "confirmed" || (retryAllowed && current.status === "failed");
    if (!canSubmit) {
      throw new Error(
        `行动卡 ${card.requestId} 当前状态是 ${current.status}，只有 confirmed 才能提交`,
      );
    }
    const submitVersion = current.cardVersion;

    // 2. 先落盘 submitted，再执行 —— 顺序反了就会出现"设备做了但系统不知道"
    const submittedAt = new Date().toISOString();
    await this.store.updateAction(card.requestId, submitVersion, {
      status: "submitted",
      submittedAt,
      attempts: attempts + 1,
    });

    let receipt: Receipt;
    let outcomeUnknown = false;
    try {
      receipt = await this.device.execute({ ...current, submittedAt });
    } catch (err) {
      // 异常只说明"这次调用没拿到结果"，不说明设备没执行。
      // 按 DeviceAdapter 的契约先查设备账本：undefined = 确认没执行，抛异常 = 不知道。
      let found: Receipt | undefined;
      let queryFailed = !this.device.lookup;
      if (this.device.lookup) {
        try {
          found = await this.device.lookup(card.requestId);
        } catch {
          queryFailed = true;
        }
      }
      const at = new Date().toISOString();
      if (found) {
        receipt = found;
      } else if (queryFailed) {
        // 查不到 ≠ 没执行。状态未知时先不写回执，卡留在 submitted 等对账。
        outcomeUnknown = true;
        receipt = {
          requestId: card.requestId,
          deviceId: this.device.id,
          status: "failed",
          at,
          detail: `设备异常且无法查证，等待对账: ${(err as Error).message}`,
          retryable: false,
        };
      } else {
        receipt = {
          requestId: card.requestId,
          deviceId: this.device.id,
          status: "failed",
          at,
          detail: `设备异常: ${(err as Error).message}`,
          retryable: false,
        };
      }
    }

    if (outcomeUnknown) {
      return { card: await this.store.getAction(card.requestId), receipt, reused: false };
    }

    // 3. 回执落盘 + 状态推进，必须原子完成。
    // 拆成 recordReceipt / updateAction 两步的话，进程死在中间会留下
    // "回执已在、状态还在 submitted" 的卡：对账按版本号判断它本轮已有结论，
    // 于是既不对账也不重发，永远停在 submitted。
    const submitted = await this.store.getAction(card.requestId);
    const card2 = await this.store.adoptReceipt(submitted, receipt);

    return { card: card2, receipt, reused: false };
  }
}