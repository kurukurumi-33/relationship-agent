import type { AgentEvent, BeforeToolCallResult } from "@mariozechner/pi-agent-core";

export interface Budget {
  /** 模型轮次上限（一次 LLM 调用算一轮） */
  maxTurns: number;
  /** 工具调用总次数上限 */
  maxToolCalls: number;
  /** 单轮内工具调用上限：防止模型一口气开几十张工单 */
  maxToolCallsPerTurn: number;
  /** 连续工具失败上限：连续报错说明环境或参数有问题，继续跑只是烧 token */
  maxConsecutiveToolFailures: number;
  /** 单次会话墙钟上限 */
  maxWallClockMs: number;
  /** 同名同参数工具连续重复次数上限，超过即拦截 */
  maxRepeats: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxTurns: 12,
  maxToolCalls: 24,
  maxToolCallsPerTurn: 6,
  maxConsecutiveToolFailures: 3,
  maxWallClockMs: 120_000,
  maxRepeats: 3,
};

export interface GuardStats {
  turns: number;
  toolCalls: number;
  blockedCalls: number;
  failedToolCalls: number;
  exceededReason?: string;
}

/**
 * 运行护栏：轮次、工具次数、重复调用、总超时。
 *
 * 为什么要有这个：agent 循环在没有外部约束时，最典型的失控形态不是"答错"，
 * 而是同一个工具用同样的参数反复调、或者在一个不可能完成的任务上空转。
 * 这里把上限做成显式预算，超了就中断并把原因写进结果，而不是静默截断。
 */
export class RunGuard {
  readonly stats: GuardStats = { turns: 0, toolCalls: 0, blockedCalls: 0, failedToolCalls: 0 };
  private readonly callCounts = new Map<string, number>();
  private callsThisTurn = 0;
  private consecutiveFailures = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly budget: Budget,
    private readonly onExceeded: (reason: string) => void,
  ) {}

  startClock(): void {
    this.timer = setTimeout(() => {
      this.exceed(`超过墙钟上限 ${this.budget.maxWallClockMs}ms`);
    }, this.budget.maxWallClockMs);
    this.timer.unref?.();
  }

  stopClock(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private exceed(reason: string): void {
    if (this.stats.exceededReason) return;
    this.stats.exceededReason = reason;
    this.onExceeded(reason);
  }

  /** 挂在 Agent 的 beforeToolCall 上：可以拦下单次调用。 */
  beforeToolCall = (input: {
    toolCall: { name: string; arguments?: unknown };
    args?: unknown;
  }): BeforeToolCallResult | undefined => {
    if (this.stats.exceededReason) {
      return { block: true, reason: `会话已中断: ${this.stats.exceededReason}` };
    }
    if (this.stats.toolCalls >= this.budget.maxToolCalls) {
      this.exceed(`超过工具调用上限 ${this.budget.maxToolCalls} 次`);
      return { block: true, reason: this.stats.exceededReason };
    }
    if (this.callsThisTurn >= this.budget.maxToolCallsPerTurn) {
      this.exceed(`单轮工具调用超过上限 ${this.budget.maxToolCallsPerTurn} 次`);
      return { block: true, reason: this.stats.exceededReason };
    }

    const key = `${input.toolCall.name}:${JSON.stringify(input.args ?? input.toolCall.arguments ?? {})}`;
    const count = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, count);
    if (count > this.budget.maxRepeats) {
      this.stats.blockedCalls += 1;
      return {
        block: true,
        reason: `重复调用被拦截：${input.toolCall.name} 用相同参数已调用 ${count - 1} 次。请换策略或直接说明信息不足。`,
      };
    }

    this.stats.toolCalls += 1;
    this.callsThisTurn += 1;
    return undefined;
  };

  /** 被参数规则拦下的调用也算 blocked，否则同一组坏参数可以被无限重试。 */
  recordBlock(): void {
    this.stats.blockedCalls += 1;
  }

  /**
   * 挂到 afterToolCall 上统计连续失败。
   *
   * 视频里提到用 pi 的 shouldStopAfterTurn 做这件事，但 Agent 类没有暴露这个钩子
   * （它只属于低层 agentLoop），所以这里用 afterToolCall + abort 做等价实现。
   */
  afterToolCall = (input: { isError: boolean }): undefined => {
    if (input.isError) {
      this.stats.failedToolCalls += 1;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.budget.maxConsecutiveToolFailures) {
        this.exceed(
          `连续 ${this.consecutiveFailures} 次工具失败，收缩任务范围`,
        );
      }
    } else {
      this.consecutiveFailures = 0;
    }
    return undefined;
  };

  /** 挂在 agent.subscribe 上，统计轮次并在超限时中断。 */
  observe(event: AgentEvent): void {
    if (event.type === "turn_start") {
      this.callsThisTurn = 0;
    }
    if (event.type === "turn_end") {
      this.stats.turns += 1;
      if (this.stats.turns >= this.budget.maxTurns) {
        this.exceed(`达到模型轮次上限 ${this.budget.maxTurns}`);
      }
    }
  }
}