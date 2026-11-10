/**
 * 参数级规则：模型给的参数"类型对、语义不对"的那一层。
 *
 * JSON Schema 只保证字段存在、类型正确，管不了"标题全是空格""只有一个选项的追问"
 * "时间不带时区"这类问题。这些规则挂在 Agent 的 beforeToolCall 上，
 * 拦下来的原因会被框架转成 isError 的 tool_result 回灌给模型。
 *
 * 所以每句话都要写成"怎么改"，不是"禁止"。模型看不懂为什么被拒，
 * 它下一轮只会用同样的话再试一次。
 */

export interface RuleViolation {
  rule: string;
  reason: string;
}

type Args = Record<string, unknown>;
type Rule = (args: Args) => RuleViolation | undefined;

const fail = (rule: string, reason: string): RuleViolation => ({ rule, reason });

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function asObject(value: unknown): Args {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 带时区偏移的 ISO 8601。不带偏移的时间设备会按各自本地时间解释，跨时区就错位。 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoWithOffset(value: unknown): boolean {
  return typeof value === "string" && ISO_WITH_OFFSET.test(value) && !Number.isNaN(Date.parse(value));
}

const TITLE_MAX = 80;

const proposeActionRules: Rule[] = [
  (args) => {
    const title = trimmed(args.title);
    if (!title) return fail("title-empty", "title 不能为空，用一句话写清楚要做什么");
    if (title.length > TITLE_MAX) {
      return fail("title-too-long", `title 有 ${title.length} 个字，上限 ${TITLE_MAX}，请压成一句话`);
    }
    return undefined;
  },
  (args) => {
    const kind = args.kind;
    const payload = asObject(args.payload);

    if (kind === "reminder" || kind === "calendar_event") {
      if (!("at" in payload)) {
        return fail("missing-at", `${kind} 必须在 payload.at 给出时间，例如 {"at":"2026-11-20T09:00:00+08:00"}`);
      }
      if (!isIsoWithOffset(payload.at)) {
        return fail(
          "bad-at",
          "payload.at 必须是带时区偏移的 ISO 时间，例如 2026-11-20T09:00:00+08:00；不带时区设备会按各自本地时间解释",
        );
      }
    }

    if (kind === "draft_message" && !trimmed(payload.text)) {
      return fail("missing-text", "draft_message 必须在 payload.text 给出消息正文，空草稿没有意义");
    }

    return undefined;
  },
  (args) => {
    const ids = asArray(args.sourceIds).map(trimmed).filter(Boolean);
    if (ids.length === 0) {
      return fail("missing-source", "sourceIds 至少要给一个非空证据 id，没有依据的提案不该出现");
    }
    return undefined;
  },
];

const askUserRules: Rule[] = [
  (args) => {
    const questions = asArray(args.questions);
    if (questions.length === 0) return fail("no-questions", "至少问一个问题");

    const seen = new Set<string>();
    for (const [index, raw] of questions.entries()) {
      const q = asObject(raw);
      const id = trimmed(q.id);
      if (!id) return fail("question-id-empty", `第 ${index + 1} 个问题的 id 不能为空`);
      if (seen.has(id)) {
        return fail("question-id-dup", `问题 id「${id}」重复，回填答案会互相覆盖，请换一个 id`);
      }
      seen.add(id);

      if (!trimmed(q.question)) return fail("question-empty", `问题「${id}」没有正文`);
      const options = asArray(q.options).map(trimmed).filter(Boolean);
      if (options.length < 2) {
        return fail(
          "question-options",
          `问题「${id}」只有 ${options.length} 个有效选项，至少要 2 个；只有一个选项等于替用户做了决定`,
        );
      }
    }
    return undefined;
  },
];

const searchRules: Rule[] = [
  (args) =>
    trimmed(args.query) ? undefined : fail("query-empty", "query 不能为空，给一个关键词再检索"),
];

const evidenceRules: Rule[] = [
  (args) =>
    trimmed(args.evidenceId) ? undefined : fail("evidence-id-empty", "evidenceId 不能为空"),
];

const RULES: Record<string, Rule[]> = {
  propose_action: proposeActionRules,
  ask_user: askUserRules,
  search_evidence: searchRules,
  get_evidence_text: evidenceRules,
};

export const RULE_TOOLS = Object.keys(RULES);

/** 返回第一条被违反的规则；全部通过返回 undefined。 */
export function checkToolRules(toolName: string, args: unknown): RuleViolation | undefined {
  const rules = RULES[toolName];
  if (!rules) return undefined;
  const parsed = asObject(args);
  for (const rule of rules) {
    const violation = rule(parsed);
    if (violation) return violation;
  }
  return undefined;
}