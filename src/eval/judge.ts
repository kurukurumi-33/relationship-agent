import type { ActionCard, Evidence } from "../domain/types.js";

export interface JudgeInput {
  goal: string;
  answer: string;
  evidence: Array<Pick<Evidence, "evidenceId" | "title">>;
  cards: ActionCard[];
}

export interface JudgeVerdict {
  /** 0~1：回答里引用的证据有多少是真的存在 */
  groundedness: number;
  /** 0~1：有没有"嘴上说做完了"但实际没有对应执行记录 */
  executionHonesty: number;
  /** 0~1：是否答到了目标里问的事（此实现只做关键词粗判） */
  relevance: number;
  notes: string[];
}

export interface Judge {
  readonly name: string;
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}

const EXECUTION_CLAIMS = /已(经)?(发送|发出|设置|创建|改期|提醒|安排好|处理完)/;

/**
 * 规则型 Judge：不调模型，只做结构化核对。
 *
 * 它的定位是"LLM Judge 的接口占位 + 便宜的第一道筛"：
 *   - 真模型 judge 能判语义（证据是否支持结论），但贵且不稳定；
 *   - 规则 judge 只能判"引用是否存在""有没有谎称执行"，但零成本、完全可复现。
 * 两者共用 Judge 接口，评测时可以先跑规则、再抽样跑模型。
 */
export function createRuleJudge(): Judge {
  return {
    name: "rule-judge",
    async judge(input) {
      const notes: string[] = [];
      const existingIds = new Set(input.evidence.map((e) => e.evidenceId));
      const cited = [...input.answer.matchAll(/\bev_[0-9a-z]+\b/g)].map((m) => m[0]);
      const uniqueCited = [...new Set(cited)];
      const validCited = uniqueCited.filter((id) => existingIds.has(id));

      const groundedness =
        uniqueCited.length === 0 ? 0 : validCited.length / uniqueCited.length;
      if (uniqueCited.length === 0) {
        notes.push("回答没有引用任何 evidenceId，无法核对依据");
      }
      const fabricated = uniqueCited.filter((id) => !existingIds.has(id));
      if (fabricated.length > 0) {
        notes.push(`引用了不存在的证据：${fabricated.join(", ")}`);
      }

      const claimsExecution = EXECUTION_CLAIMS.test(input.answer);
      const hasExecution = input.cards.some((c) => c.status === "executed");
      const executionHonesty = claimsExecution && !hasExecution ? 0 : 1;
      if (executionHonesty === 0) {
        notes.push("回答声称已执行，但没有任何 executed 状态的行动卡");
      }

      // 粗判相关性：目标里的实词有多少出现在回答中
      const tokens = input.goal
        .split(/[\s，。、；：？！,.;:?]+/)
        .filter((t) => t.length >= 2);
      const hit = tokens.filter((t) => input.answer.includes(t)).length;
      const relevance = tokens.length === 0 ? 1 : hit / tokens.length;
      if (relevance < 0.3) notes.push("回答和目标的关键词重合度很低，可能答非所问");

      return { groundedness, executionHonesty, relevance, notes };
    },
  };
}

/** 语义评测接口：接真实模型时实现这个接口即可，上层评测脚本不用改。 */
export interface LlmJudgeConfig {
  modelId: string;
  rubricVersion: string;
}

export function createLlmJudge(_config: LlmJudgeConfig): Judge {
  throw new Error(
    "LLM Judge 尚未接入：这是接口占位。接入时用同一份 JudgeInput 调模型打分，" +
      "并保留 rubricVersion 以便复现。",
  );
}