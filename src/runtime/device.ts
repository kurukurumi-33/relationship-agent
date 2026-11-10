import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActionCard, Receipt } from "../domain/types.js";

/**
 * 设备适配层。真实项目里这里会换成：系统日历、IM 客户端、提醒事项……
 * M1 只提供 mock，但它刻意保留了真实设备的两个特性：
 *   - 执行可能失败（回执 failed），失败不等于提交失败；
 *   - 执行结果必须带 requestId 回来，否则无法和提案对上。
 */
export interface DeviceAdapter {
  readonly id: string;
  execute(card: ActionCard): Promise<Receipt>;
  /**
   * 可选：按 requestId 幂等查询"这条你执行过没有"。
   *
   * 契约（很重要，写在这里防止以后有人改坏）：
   *   - 必须与 execute 使用**同一份记录**，不能查一个缓存、写另一个账本；
   *   - 返回 undefined 表示"设备侧确实没有这条记录"，调用方据此可以安全重发；
   *   - 查询本身失败要抛异常，不要用 undefined 冒充"没有"——两者含义完全不同。
   */
  lookup?(requestId: string): Promise<Receipt | undefined>;
}

export class MockDevice implements DeviceAdapter {
  readonly id = "mock-device";
  private attempts = 0;

  constructor(
    private readonly ledgerPath: string,
    private readonly behavior: {
      /** 前 N 次直接失败 */
      failFirstN?: number;
      /** 前 N 次返回部分成功 */
      partialFirstN?: number;
      /** 失败原因：冲突类（时段被占）可重试，未知原因不可重试 */
      failureKind?: "conflict" | "unknown";
    } = {},
  ) {}

  async execute(card: ActionCard): Promise<Receipt> {
    this.attempts += 1;
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    const at = new Date().toISOString();

    if (this.attempts <= (this.behavior.failFirstN ?? 0)) {
      const conflict = this.behavior.failureKind === "conflict";
      const receipt: Receipt = {
        requestId: card.requestId,
        deviceId: this.id,
        status: "failed",
        at,
        detail: conflict
          ? `目标时段被占用（冲突，可重试），第 ${this.attempts} 次`
          : `模拟设备失败（不可重试），第 ${this.attempts} 次`,
        retryable: conflict,
      };
      await appendFile(this.ledgerPath, `${JSON.stringify({ card, receipt })}\n`, "utf8");
      return receipt;
    }

    if (this.attempts <= (this.behavior.partialFirstN ?? 0)) {
      const receipt: Receipt = {
        requestId: card.requestId,
        deviceId: this.id,
        status: "partial",
        at,
        detail: `部分成功：主体已写入，但附件/提醒未全部送达（第 ${this.attempts} 次）`,
      };
      await appendFile(this.ledgerPath, `${JSON.stringify({ card, receipt })}\n`, "utf8");
      return receipt;
    }

    const receipt: Receipt = {
      requestId: card.requestId,
      deviceId: this.id,
      status: "ok",
      at,
      detail: `${card.kind}: ${card.title}`,
    };
    await appendFile(this.ledgerPath, `${JSON.stringify({ card, receipt })}\n`, "utf8");
    return receipt;
  }

  /**
   * 幂等查询：账本就是设备侧的唯一事实来源。
   * 同一个 requestId 可能被写过多次（重试），取最后一条。
   */
  async lookup(requestId: string): Promise<Receipt | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.ledgerPath, "utf8");
    } catch {
      return undefined; // 账本不存在 = 设备确实没收到过
    }
    let found: Receipt | undefined;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { card: ActionCard; receipt: Receipt };
        if (entry.card.requestId === requestId) found = entry.receipt;
      } catch {
        // 半截行（写的时候崩了）忽略，不能因为一行坏数据否定整本账
      }
    }
    return found;
  }
}