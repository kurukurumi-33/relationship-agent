import type { ActionCard, RequestId } from "../domain/types.js";
import type { Store } from "../store/store.js";

export type ConfirmDecision = "approve" | "reject";

/**
 * 一次确认票。
 *
 * cardVersion 是票据的有效期：用户看到的是哪一版，就只能确认哪一版。
 * 提案在确认前被改过，版本号已经变了，手里的旧票作废。
 */
export interface ConfirmTicket {
  requestId: RequestId;
  cardVersion: number;
  decision: ConfirmDecision;
  at?: string;
}

export const PENDING_CARD_ERROR = "只有 proposed 状态的行动卡可以确认";

/** 异步确认：提议阶段和执行阶段之间的那一步，可以发生在任意时间、任意进程。 */
export async function confirmAction(store: Store, ticket: ConfirmTicket): Promise<ActionCard> {
  const card = await store.getAction(ticket.requestId);

  if (card.cardVersion !== ticket.cardVersion) {
    throw new Error(
      `行动卡已被修改：你确认的是 v${ticket.cardVersion}，当前是 v${card.cardVersion}，请重新确认`,
    );
  }
  if (card.status !== "proposed") {
    throw new Error(`行动卡 ${ticket.requestId} 当前状态是 ${card.status}，${PENDING_CARD_ERROR}`);
  }

  if (ticket.decision === "reject") {
    return store.updateAction(ticket.requestId, ticket.cardVersion, { status: "rejected" });
  }
  return store.updateAction(ticket.requestId, ticket.cardVersion, {
    status: "confirmed",
    confirmedAt: ticket.at ?? new Date().toISOString(),
  });
}