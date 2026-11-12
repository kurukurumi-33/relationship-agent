import type { ActionCard } from "../domain/types.js";

/** 文件设备和 CalDAV 设备共用的一份 VEVENT 渲染逻辑 */

const CALENDAR_EVENT_DURATION_MINUTES = 60;
/** 提醒本身没有时长，占 15 分钟只是为了让日历上显示一个块 */
const REMINDER_DURATION_MINUTES = 15;
const MINUTE_MS = 60 * 1000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** ICS 的 UTC 时间格式：20261120T110000Z */
export function icsStamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/** TEXT 值里的 \ ; , 和换行都要转义 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * 按 RFC 5545 折行：一行不超过 75 字节，续行以一个空格开头。
 * 按字节切而不是按字符切，避免把中文字符切成两半。
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74;
  }
  return chunks.join("\r\n ");
}

export function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

/** payload.at 必须带时区偏移。规则层会拦，但设备层不能假设上游一定拦过。 */
export function readStart(card: ActionCard): number | undefined {
  const at = card.payload.at;
  if (typeof at !== "string" || !/T.*(Z|[+-]\d{2}:?\d{2})$/.test(at.trim())) return undefined;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? undefined : ms;
}

export function readDuration(card: ActionCard): number {
  const raw = card.payload.durationMinutes;
  const minutes =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : card.kind === "reminder"
        ? REMINDER_DURATION_MINUTES
        : CALENDAR_EVENT_DURATION_MINUTES;
  return Math.min(minutes, 24 * 60) * MINUTE_MS;
}

export function renderEvent(
  card: ActionCard,
  startMs: number,
  stampMs: number,
  prodId = "-//relationship-agent//ics-file-device//CN",
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${card.requestId}`,
    `DTSTAMP:${icsStamp(stampMs)}`,
    `DTSTART:${icsStamp(startMs)}`,
    `DTEND:${icsStamp(startMs + readDuration(card))}`,
    `SUMMARY:${escapeText(card.title)}`,
    `DESCRIPTION:${escapeText(card.reason)}`,
  ];
  // 提醒用闹钟表达，导入日历后会弹通知；普通日程不挂闹钟
  if (card.kind === "reminder") {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(card.title)}`,
      "TRIGGER:-PT0M",
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}