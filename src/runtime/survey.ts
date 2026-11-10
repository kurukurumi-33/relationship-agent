import { createInterface } from "node:readline/promises";
import type { SurveyQuestion, SurveyHandler } from "../agent/tools.js";
import type { ActionCard, MemoryCandidate } from "../domain/types.js";

export type ConfirmHandler = (card: ActionCard) => Promise<boolean>;
export type ReviewHandler = (candidate: MemoryCandidate) => Promise<boolean>;

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

function formatCard(card: ActionCard): string {
  return [
    `  类型: ${card.kind}`,
    `  标题: ${card.title}`,
    `  理由: ${card.reason}`,
    `  参数: ${JSON.stringify(card.payload)}`,
    `  依据: ${card.sourceIds.join(", ")}`,
    `  请求: ${card.requestId} (v${card.cardVersion})`,
  ].join("\n");
}

/** CLI 问卷：逐题问，有选项就给编号。 */
export function createCliSurvey(): SurveyHandler {
  return async (questions: SurveyQuestion[]) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answers: Record<string, string> = {};
      for (const q of questions) {
        const options = q.options?.length
          ? `\n${q.options.map((o, i) => `    ${i + 1}) ${o}`).join("\n")}\n  直接输编号或自由文本: `
          : " ";
        const raw = await ask(rl, `\n[追问] ${q.question}${options}`);
        const index = Number(raw) - 1;
        answers[q.id] =
          q.options && Number.isInteger(index) && q.options[index] !== undefined
            ? q.options[index]!
            : raw;
      }
      return answers;
    } finally {
      rl.close();
    }
  };
}

/** 脚本化问卷：demo 和测试用，按题目 id 顺序取答案。 */
export function createScriptedSurvey(answersByQuestionId: Record<string, string>): SurveyHandler {
  return async (questions) => {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      answers[q.id] = answersByQuestionId[q.id] ?? answersByQuestionId["*"] ?? "（未提供答案）";
    }
    return answers;
  };
}

export function createCliConfirm(): ConfirmHandler {
  return async (card) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await ask(
        rl,
        `\n[待确认行动卡]\n${formatCard(card)}\n  执行？(y/N) `,
      );
      return /^y(es)?$/i.test(answer);
    } finally {
      rl.close();
    }
  };
}

export function createCliReview(): ReviewHandler {
  return async (candidate) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await ask(
        rl,
        `\n[待审核记忆] ${candidate.text}\n  依据: ${candidate.sourceIds.join(", ")}\n  写入长期记忆？(y/N) `,
      );
      return /^y(es)?$/i.test(answer);
    } finally {
      rl.close();
    }
  };
}

export const alwaysConfirm: ConfirmHandler = async () => true;
export const alwaysReview: ReviewHandler = async () => true;
export const neverConfirm: ConfirmHandler = async () => false;
export const neverReview: ReviewHandler = async () => false;