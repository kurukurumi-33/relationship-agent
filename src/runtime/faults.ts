import type { ActionCard, Receipt } from "../domain/types.js";
import type { DeviceAdapter } from "./device.js";

/**
 * 故障画像。所有比例加起来应当等于 1；调用方用 `normalizeProfile` 归一化。
 *
 * 四类故障对应真实设备会出现的四种情况：
 *   - retryable：时段冲突、限流，值得重试；
 *   - permanent：参数非法、权限不足，重试只是浪费；
 *   - partial：主体成功、附件失败，需要人工跟进；
 *   - lostReceipt：设备真的执行了，但回执没回到系统。这是最危险的一类。
 */
export interface FaultProfile {
  ok: number;
  retryable: number;
  permanent: number;
  partial: number;
  lostReceipt: number;
  /** 固定种子，保证同一配置下整轮可复现 */
  seed: number;
}

export const NO_FAULTS: FaultProfile = {
  ok: 1,
  retryable: 0,
  permanent: 0,
  partial: 0,
  lostReceipt: 0,
  seed: 1,
};

/** 确定性 PRNG（mulberry32），不用 Math.random 是因为结果必须能重跑。 */
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

export function normalizeProfile(profile: Partial<FaultProfile>): FaultProfile {
  const merged = { ...NO_FAULTS, ...profile };
  const total =
    merged.ok + merged.retryable + merged.permanent + merged.partial + merged.lostReceipt;
  if (total <= 0) return { ...NO_FAULTS, seed: merged.seed };
  return {
    ok: merged.ok / total,
    retryable: merged.retryable / total,
    permanent: merged.permanent / total,
    partial: merged.partial / total,
    lostReceipt: merged.lostReceipt / total,
    seed: merged.seed,
  };
}

/**
 * 故障注入设备：包在真实设备外面，不改调用方。
 *
 * 之所以做成适配器而不是改 Outbox：故障是设备侧的事实，不是队列侧的选择。
 * 包装器保证库里的执行路径和线上完全一致。
 */
export class FaultyDevice implements DeviceAdapter {
  readonly id: string;
  private readonly rng: () => number;
  private readonly profile: FaultProfile;

  constructor(
    private readonly base: DeviceAdapter,
    profile: Partial<FaultProfile> = {},
  ) {
    this.profile = normalizeProfile(profile);
    this.rng = mulberry32(this.profile.seed);
    this.id = `faulty(${base.id})`;
  }

  async execute(card: ActionCard): Promise<Receipt> {
    const r = this.rng();
    let acc = 0;

    if (r < (acc += this.profile.ok)) {
      return this.base.execute(card);
    }
    if (r < (acc += this.profile.retryable)) {
      return {
        requestId: card.requestId,
        deviceId: this.id,
        status: "failed",
        at: new Date().toISOString(),
        detail: "模拟冲突：目标时段被占用（可重试）",
        retryable: true,
      };
    }
    if (r < (acc += this.profile.permanent)) {
      return {
        requestId: card.requestId,
        deviceId: this.id,
        status: "failed",
        at: new Date().toISOString(),
        detail: "模拟拒绝：设备侧参数非法（不可重试）",
        retryable: false,
      };
    }
    if (r < (acc += this.profile.partial)) {
      // 部分成功也意味着设备真的动过，必须在账本里留下痕迹。
      // 不留痕的话，系统会把"做了一半"误判成"设备压根没收到"。
      await this.base.execute(card);
      return {
        requestId: card.requestId,
        deviceId: this.id,
        status: "partial",
        at: new Date().toISOString(),
        detail: "模拟部分成功：主体已写入，附件未送达",
      };
    }

    // 设备真的执行了，然后回执在返回路上丢了。
    // 这是系统状态和设备事实最容易分叉的地方。
    await this.base.execute(card);
    throw new Error("模拟回执丢失（设备已执行）");
  }

  async lookup(requestId: string): Promise<Receipt | undefined> {
    return this.base.lookup?.(requestId);
  }
}