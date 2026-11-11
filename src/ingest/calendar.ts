import { createHash } from "node:crypto";
import type { Evidence } from "../domain/types.js";
import type { Store } from "../store/store.js";
import { ingestEvidence } from "./evidence.js";

/**
 * ICS 日历解析。
 *
 * 只依赖 Node 内置的 Intl 做时区换算，不引第三方库。需要处理的几件事：
 *   - 折行：以空格或制表符开头的行是上一行的续行；
 *   - 转义：\, \; \\ \n 在 TEXT 值里是转义序列；
 *   - 时间：UTC（Z）、带 TZID 的本地时间、不带时区的浮动时间、全天日期；
 *   - 重复事件：本版只导入首个实例，RRULE 不展开。
 *
 * 解析失败的事件不会静默丢：落成 pending_review 的证据，等人工确认。
 */

export interface IcsEvent {
  uid?: string;
  summary: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt?: string;
  allDay: boolean;
  recurring: boolean;
  cancelled: boolean;
  raw: string;
  /** 有值表示这个事件无法正常解析，入库时应落 pending_review */
  parseError?: string;
}

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function parseProp(line: string): IcsProp | undefined {
  const colon = line.indexOf(":");
  if (colon < 0) return undefined;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [rawName, ...rawParams] = left.split(";");
  if (!rawName || rawName.length === 0) return undefined;
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    params[p.slice(0, eq).toUpperCase()] = p
      .slice(eq + 1)
      .replace(/^"|"$/g, "");
  }
  return { name: rawName.toUpperCase(), params, value };
}

function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) {
      out += ch;
      break;
    }
    if (next === "n" || next === "N") out += "\n";
    else if (next === "," || next === ";" || next === "\\") out += next;
    else out += next;
    i += 1;
  }
  return out;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** 某个 UTC 瞬间在指定时区里的墙钟时间，返回 [年, 月, 日, 时, 分, 秒]。 */
function wallParts(ms: number, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return [get("year"), get("month"), get("day"), get("hour"), get("minute"), get("second")];
}

/**
 * 把时区里的墙钟时间换成 UTC 毫秒。
 *
 * 先假设墙钟就是 UTC，再按该时区反算偏移；DST 切换附近偏移会变，所以算两遍收敛。
 */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const [y, m, d, h, mi, s] = wallParts(guess, timeZone);
    const seen = Date.UTC(y!, m! - 1, d!, h!, mi!, s!);
    guess = target - (seen - guess);
  }
  return guess;
}

interface ParsedDate {
  ms: number;
  allDay: boolean;
}

function parseDate(prop: IcsProp, defaultTimeZone: string | undefined): ParsedDate | undefined {
  const value = prop.value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (prop.params.VALUE === "DATE" || dateOnly) {
    if (!dateOnly) return undefined;
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    return { ms: new Date(year, month - 1, day, 0, 0, 0, 0).getTime(), allDay: true };
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!match) {
    const fallback = Date.parse(value);
    return Number.isNaN(fallback) ? undefined : { ms: fallback, allDay: false };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (match[7] === "Z") {
    return { ms: Date.UTC(year, month - 1, day, hour, minute, second), allDay: false };
  }

  const timeZone = prop.params.TZID ?? defaultTimeZone;
  if (timeZone) {
    if (!isValidTimeZone(timeZone)) return undefined;
    return {
      ms: zonedToUtc(year, month, day, hour, minute, second, timeZone),
      allDay: false,
    };
  }

  // 浮动时间按运行机器的本地时区解释
  return { ms: new Date(year, month - 1, day, hour, minute, second).getTime(), allDay: false };
}

function parseDuration(value: string): number | undefined {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  const [, w, d, h, mi, s] = match;
  if (!w && !d && !h && !mi && !s) return undefined;
  return (
    ((Number(w ?? 0) * 7 + Number(d ?? 0)) * 86400 +
      Number(h ?? 0) * 3600 +
      Number(mi ?? 0) * 60 +
      Number(s ?? 0)) *
    1000
  );
}

function parseEvent(lines: string[], defaultTimeZone: string | undefined, now: Date): IcsEvent {
  const props = new Map<string, IcsProp>();
  for (const line of lines) {
    const prop = parseProp(line);
    if (prop) props.set(prop.name, prop);
  }

  const raw = lines.join("\n");
  const summary = unescapeText(props.get("SUMMARY")?.value ?? "").trim() || "未命名日程";
  const description = unescapeText(props.get("DESCRIPTION")?.value ?? "").trim() || undefined;
  const location = unescapeText(props.get("LOCATION")?.value ?? "").trim() || undefined;
  const uid = props.get("UID")?.value.trim() || undefined;
  const cancelled = (props.get("STATUS")?.value ?? "").trim().toUpperCase() === "CANCELLED";
  const recurring = props.has("RRULE");

  const startProp = props.get("DTSTART");
  const parsedStart = startProp ? parseDate(startProp, defaultTimeZone) : undefined;

  let parseError: string | undefined;
  if (cancelled) {
    parseError = "已取消";
  } else if (!startProp) {
    parseError = "缺少 DTSTART";
  } else if (!parsedStart) {
    parseError = `无法解析 DTSTART: ${startProp.value}`;
  }

  const startsAt = parsedStart ? new Date(parsedStart.ms).toISOString() : now.toISOString();

  let endsAt: string | undefined;
  if (parsedStart) {
    const endProp = props.get("DTEND");
    const parsedEnd = endProp ? parseDate(endProp, defaultTimeZone) : undefined;
    if (parsedEnd) {
      endsAt = new Date(parsedEnd.ms).toISOString();
    } else {
      const duration = props.get("DURATION");
      const durationMs = duration ? parseDuration(duration.value) : undefined;
      if (durationMs !== undefined) endsAt = new Date(parsedStart.ms + durationMs).toISOString();
    }
  }

  return {
    uid,
    summary,
    description,
    location,
    startsAt,
    endsAt,
    allDay: parsedStart?.allDay ?? false,
    recurring,
    cancelled,
    raw,
    parseError,
  };
}

export function parseIcs(text: string, now: Date = new Date()): IcsEvent[] {
  const lines = unfold(text);
  let defaultTimeZone: string | undefined;
  for (const line of lines) {
    const prop = parseProp(line);
    if (prop?.name === "X-WR-TIMEZONE") {
      defaultTimeZone = prop.value.trim() || undefined;
      break;
    }
  }

  const events: IcsEvent[] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      current = [];
    } else if (upper === "END:VEVENT") {
      if (current) events.push(parseEvent(current, defaultTimeZone, now));
      current = undefined;
    } else if (current) {
      current.push(line);
    }
  }
  return events;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocal(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function renderContent(event: IcsEvent): string {
  const start = new Date(event.startsAt);
  const parts: string[] = [];
  if (event.allDay) {
    parts.push(`日期：${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}（全天）`);
  } else {
    parts.push(`时间：${formatLocal(start)}（${event.startsAt}）`);
  }
  if (event.endsAt) parts.push(`结束：${formatLocal(new Date(event.endsAt))}`);
  if (event.location) parts.push(`地点：${event.location}`);
  if (event.description) parts.push(`说明：${event.description}`);
  if (event.recurring) parts.push("重复：是（本版只导入首个实例，RRULE 未展开）");
  if (event.uid) parts.push(`UID：${event.uid}`);
  if (event.parseError) parts.push(`解析问题：${event.parseError}`);
  return parts.join("\n");
}

export interface CalendarIngestOptions {
  personId: string;
  /** 原始来源指针，通常是 .ics 文件路径 */
  sourceRef: string;
  now?: Date;
  ttlMs?: number;
}

export interface CalendarIngestResult {
  events: IcsEvent[];
  items: Array<{ evidence: Evidence; created: boolean; expiresAt?: string }>;
  duplicates: number;
  cancelled: number;
  pending: number;
}

export async function ingestIcs(
  store: Store,
  text: string,
  opts: CalendarIngestOptions,
): Promise<CalendarIngestResult> {
  const now = opts.now ?? new Date();
  const events = parseIcs(text, now);
  const items: CalendarIngestResult["items"] = [];
  let duplicates = 0;
  let cancelled = 0;
  let pending = 0;

  for (const [index, event] of events.entries()) {
    if (event.cancelled) {
      cancelled += 1;
      continue;
    }

    const status = event.parseError ? "pending_review" : "active";
    if (status === "pending_review") pending += 1;

    // 哈希用 UID + 原始块，同一次导入重复执行得到同一个键；
    // 不用解析后的时间，避免解析器的时区行为变化导致重复入库。
    const contentHash = createHash("sha256")
      .update(`${opts.personId}|calendar|${event.uid ?? index}|${event.raw}`)
      .digest("hex");

    const result = await ingestEvidence(
      store,
      {
        personId: opts.personId,
        kind: "calendar",
        capturedAt: event.startsAt,
        title: event.summary,
        content: renderContent(event),
        sourceRef: `${opts.sourceRef}#${event.uid ?? index}`,
        status,
        contentHash,
        // 待确认材料不设过期：人工还没看到，先把原文弄丢就永远确认不了
        ttlMs: status === "pending_review" ? 0 : opts.ttlMs,
        summary: event.parseError
          ? `日历事件解析失败：${event.parseError}`
          : event.description?.slice(0, 60),
      },
      now,
    );

    if (!result.created) duplicates += 1;
    items.push(result);
  }

  return { events, items, duplicates, cancelled, pending };
}