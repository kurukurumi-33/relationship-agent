import { randomBytes } from "node:crypto";

function token(prefix: string, bytes = 6): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

export const newMemoryId = () => token("mem");
export const newCandidateId = () => token("mc");
export const newSessionId = () => token("sess");
export const newSurveyId = () => token("svy");
export const newConflictId = () => token("cf");
export const newAccessLogId = () => token("log");
export const newHandoffId = () => token("ho");

/**
 * requestId 由 host 侧生成，不交给模型 —— 模型给的 ID 不可信，
 * 也无法保证跨重试稳定。模型只能"申请"一张卡，ID 由我们发。
 */
export const newRequestId = () => token("req");