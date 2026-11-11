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
  /** 工具报错次数：用来验证"错误回灌之后模型有没有改策略" */
  "tools.errors"?: number;
  /** 被权限/归属校验拒掉的调用次数：这才是"越界尝试"的直接计数 */
  "tools.denied"?: number;
  /** 回答里必须出现的片段 */
  textContains?: string[];
  /** 回答里不允许出现的片段（用来抓泄漏） */
  textNotContains?: string[];
}

/**
 * `expectReal` 的格式：和 `expect` 一样，但每一项可以写 null 表示"真模型下删掉这条断言"。
 *
 * 删除是必要的：脚本模式能断言"洞察 Agent 拒掉了候选"，
 * 真模型可能压根不提交候选，同一个断言在真模型下就无法成立。
 */
export type RealExpectations = {
  [K in keyof Expectations]?: Expectations[K] | null;
};

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
  /**
   * 这条用例在 `--real` 下还成不成立。默认成立。
   *
   * 有些用例的期望本身就依赖"模型按剧本犯错"（比如故意重复调用、
   * 故意漏掉时区），真模型不会配合演出，跑出来全是假失败，所以要关掉。
   */
  realModel?: boolean;
  /** 覆盖护栏预算，例如测重复调用拦截 */
  budget?: { maxRepeats?: number; maxTurns?: number; maxToolCalls?: number };
  /** 设备行为，默认成功 */
  device?: { failFirstN?: number; failureKind?: "conflict" | "unknown"; partialFirstN?: number };
  expect?: Expectations;
  /**
   * `--real` 下覆盖 `expect` 的对应项，逐条合并；写 null 表示删掉这一条。
   *
   * 典型用法：脚本模型的路径是写死的，`tools.maxCalls` 可以卡得很紧；
   * 真模型会多问一轮、多读一次证据，同一个上限就变成假失败。
   */
  expectReal?: RealExpectations;
}

export interface CaseResult {
  id: string;
  title: string;
  tags: string[];
  passed: boolean;
  failures: string[];
  /** 观测到的原始指标，写进报告用于对比 */
  observed: Record<string, number>;
  /** 模型的最终回答。真模型跑挂了要看它到底说了什么，光看指标没法判断。 */
  text: string;
  /** 按顺序调用过的工具名 */
  tools: string[];
  tokens: number;
  cost: number;
  toolCalls: number;
  toolErrors: number;
  durationMs: number;
}