import type { AgentMessage } from "@mariozechner/pi-agent-core";

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
}

function toolCallsOf(message: AgentMessage): ToolCallBlock[] {
  if (message.role !== "assistant") return [];
  const content = (message as { content: unknown[] }).content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is ToolCallBlock =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall",
  );
}

function isToolResult(message: AgentMessage): boolean {
  return message.role === "toolResult";
}

/**
 * 恢复会话时修复 toolCall / toolResult 配对。
 *
 * 为什么必须做：LLM 协议要求每个 toolCall 后面有且只有一个 toolResult。
 * 进程在"工具已发起、结果未落盘"时崩掉，恢复出来的上下文就是残缺的，
 * 直接喂给模型会 400（多数 provider 会校验配对）。
 *
 * 规则：
 *   - 有 toolCall 没结果 → 补一条 isError 的合成结果，说明中断；
 *   - 有结果没 toolCall（孤儿）→ 丢弃；
 *   - 顺序保持不变，其余消息原样保留。
 */
export function repairToolPairing(messages: AgentMessage[]): {
  messages: AgentMessage[];
  repaired: number;
} {
  const out: AgentMessage[] = [];
  const pending = new Map<string, string>(); // toolCallId → toolName
  let repaired = 0;

  const flushPending = () => {
    for (const [toolCallId, toolName] of pending) {
      out.push({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: "会话在执行该工具时中断，没有拿到结果。" }],
        isError: true,
        timestamp: Date.now(),
      } as AgentMessage);
      repaired += 1;
    }
    pending.clear();
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      // 上一条 assistant 的工具还没收齐就来了新 assistant，属于异常上下文，先补齐
      if (pending.size > 0) flushPending();
      const calls = toolCallsOf(message);
      for (const call of calls) pending.set(call.id, call.name);
      out.push(message);
      continue;
    }

    if (isToolResult(message)) {
      const toolCallId = (message as { toolCallId: string }).toolCallId;
      if (!pending.has(toolCallId)) {
        repaired += 1; // 孤儿结果，丢弃
        continue;
      }
      pending.delete(toolCallId);
      out.push(message);
      continue;
    }

    if (pending.size > 0) flushPending();
    out.push(message);
  }

  if (pending.size > 0) flushPending();
  return { messages: out, repaired };
}

/**
 * 把问卷答案补回它原本那条 toolCall 的 toolResult。
 *
 * 这是"可恢复暂停点"的关键一步：进程在等用户回答时挂掉，恢复后如果直接交给
 * repairToolPairing，它会补一条"中断、没有结果"的错误结果——那条 toolCall 就白丢了。
 * 先注入真实答案，配对修复才有东西可配。
 */
export function injectSurveyResults(
  messages: AgentMessage[],
  surveys: Array<{ toolCallId: string; answers: Record<string, string> }>,
): { messages: AgentMessage[]; injected: number } {
  if (surveys.length === 0) return { messages, injected: 0 };

  const answersByCall = new Map(surveys.map((s) => [s.toolCallId, s.answers]));
  const existing = new Set(
    messages
      .filter(isToolResult)
      .map((m) => (m as { toolCallId: string }).toolCallId),
  );

  const out: AgentMessage[] = [];
  let injected = 0;

  for (const message of messages) {
    out.push(message);
    if (message.role !== "assistant") continue;
    for (const call of toolCallsOf(message)) {
      const answers = answersByCall.get(call.id);
      if (!answers || existing.has(call.id)) continue;
      out.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: JSON.stringify({ answers }) }],
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage);
      injected += 1;
    }
  }

  return { messages: out, injected };
}

/**
 * 会话压缩：消息数超限时，保留最早一条用户消息和最近若干条。
 * 旧的纯截断逻辑，现由 session/summary.ts 的 compactMessages 取代：
 * 那里在同一切割规则上加了结构化摘要和原文检索提示。
 */