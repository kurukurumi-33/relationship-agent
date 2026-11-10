/**
 * 评测用例的数据格式。
 *
 * 关键取舍：用例是"数据"不是"代码"。
 * 之前 audit.ts / smoke.ts 里每个用例都是一段 TS，加一条要改代码、要会 TS、
 * 改坏了还没人知道基线退没退。抽成 JSON 之后，加用例就是加文件。
 */

export interface ScriptToolCall {
  /** 模型这一轮要调的工具名 */
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ScriptStep {
  /** 说一句话（不调工具） */
  text?: string;
  /** 调一次工具 */
  toolCall?: ScriptToolCall;
}

/**
 * 期望值。全部可选，写几条就校验几条。
 * 名字用点号分段，是为了将来加维度时不用改结构。
 */
export interface Expectations {
  "cards.total"?: number;
  "cards.executed"?: number;
  "cards.failed"?: number;
  "candidates.approved"?: number;
  "candidates.rejected"?: number;
  "memory.itemsDelta"?: number;
  "handoffs"?: number;
  "guard.blocked"?: number;
  /** 必须调用过的工具（全部包含即可，顺序不限） */
  "tools.called"?: string[];
  /** 不允许出现的工具调用 */
  "tools.notCalled"?: string[];
  /** 工具调用总次数上限：用来抓"路径冗余"（本来两步能做完，走了五步） */
  "tools.maxCalls"?: number;
  /** 回答里必须出现的片段 */
  textContains?: string[];
  /** 回答里不允许出现的片段（用来抓泄漏） */
  textNotContains?: string[];
}

export interface EvalCase {
  id: string;
  title: string;
  /** 分类标签，用来分维度统计：boundary / memory / resilience / happy */
  tags: string[];
  goal: string;
  personId?: string;
  /** 是否启用洞察 Agent（启用时 script 的后半段是洞察的回合） */
  insight?: boolean;
  /** 脚本化的模型行为；省略则走真实模型 */
  script?: ScriptStep[];
  /** 覆盖护栏预算，例如测重复调用拦截 */
  budget?: { maxRepeats?: number; maxTurns?: number; maxToolCalls?: number };
  /** 设备行为，默认成功 */
  device?: { failFirstN?: number; failureKind?: "conflict" | "unknown"; partialFirstN?: number };
  expect?: Expectations;
}

export interface CaseResult {
  id: string;
  title: string;
  tags: string[];
  passed: boolean;
  failures: string[];
  /** 观测到的原始指标，写进报告用于对比 */
  observed: Record<string, number>;
  tokens: number;
  cost: number;
  toolCalls: number;
  toolErrors: number;
  durationMs: number;
}