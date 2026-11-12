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
 *   - 重复事件：支持 DAILY / WEEKLY / MONTHLY / YEARLY，INTERVAL、COUNT、UNTIL、
 *     WEEKLY 的 BYDAY、MONTHLY 的 BYMONTHDAY、EXDATE。展开范围默认是现在往后 90 天，
 *     单事件最多 120 个实例；更复杂的规则（BYSETPOS、BYMONTH 等）退化成只导入首个实例，
 *     并在正文里写明原因。
 *
 * 解析失败的事件不会静默丢：落成 pending_review 的证据，等人工确认。
 */

export interface IcsOccurrence {
  startsAt: string;
  endsAt?: string;
  /** 事件自身时区里的墙钟标识，用作去重键的一部分，不依赖时区换算结果 */
  key: string;
}

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
  /** 展开出来的实例，至少一个；不可展开时只有一个，原因见 recurrenceNote */
  occurrences: IcsOccurrence[];
  /** RRULE 存在但没能展开的原因 */
  recurrenceNote?: string;
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
  /** 墙钟字段。展开重复规则时按墙钟推进，不受 DST 影响 */
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** "UTC" / TZID / undefined（浮动时间，按本机时区） */
  zone: string | undefined;
}

function parseDate(prop: IcsProp, defaultTimeZone: string | undefined): ParsedDate | undefined {
  const value = prop.value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (prop.params.VALUE === "DATE" || dateOnly) {
    if (!dateOnly) return undefined;
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    return {
      ms: new Date(year, month - 1, day, 0, 0, 0, 0).getTime(),
      allDay: true,
      y: year,
      mo: month,
      d: day,
      h: 0,
      mi: 0,
      s: 0,
      zone: undefined,
    };
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!match) {
    const fallback = Date.parse(value);
    if (Number.isNaN(fallback)) return undefined;
    return {
      ms: fallback,
      allDay: false,
      y: new Date(fallback).getFullYear(),
      mo: new Date(fallback).getMonth() + 1,
      d: new Date(fallback).getDate(),
      h: new Date(fallback).getHours(),
      mi: new Date(fallback).getMinutes(),
      s: new Date(fallback).getSeconds(),
      zone: undefined,
    };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const wall = { y: year, mo: month, d: day, h: hour, mi: minute, s: second };

  if (match[7] === "Z") {
    return {
      ms: Date.UTC(year, month - 1, day, hour, minute, second),
      allDay: false,
      ...wall,
      zone: "UTC",
    };
  }

  const timeZone = prop.params.TZID ?? defaultTimeZone;
  if (timeZone) {
    if (!isValidTimeZone(timeZone)) return undefined;
    return {
      ms: zonedToUtc(year, month, day, hour, minute, second, timeZone),
      allDay: false,
      ...wall,
      zone: timeZone,
    };
  }

  // 浮动时间按运行机器的本地时区解释
  return {
    ms: new Date(year, month - 1, day, hour, minute, second).getTime(),
    allDay: false,
    ...wall,
    zone: undefined,
  };
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

const DAY_MS = 86400000;
/** 展开窗口：今天往后 90 天。再远的事件对"最近要做什么"没有帮助 */
const HORIZON_MS = 90 * DAY_MS;
/** 单事件实例上限。"每 5 分钟重复"这种规则不能把库撑爆 */
const MAX_OCCURRENCES = 120;
/** 生成器的迭代上限，防止规则不前进时死循环 */
const MAX_ITERATIONS = 40000;

type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

interface RecurrenceRule {
  freq: Frequency;
  interval: number;
  count?: number;
  /** UNTIL 是时刻，全天日期按当天末 */
  untilMs?: number;
  /** WEEKLY 用，0=周日 */
  byDay?: number[];
  byMonthDay?: number;
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const UNSUPPORTED_PARTS = [
  "BYSETPOS",
  "BYMONTH",
  "BYWEEKNO",
  "BYYEARDAY",
  "BYHOUR",
  "BYMINUTE",
  "BYSECOND",
  "BYEASTER",
];

function parseRRule(
  value: string,
  defaultTimeZone: string | undefined,
): { rule?: RecurrenceRule; note?: string } {
  const parts = new Map<string, string>();
  for (const segment of value.trim().split(";")) {
    const eq = segment.indexOf("=");
    if (eq < 0) continue;
    parts.set(segment.slice(0, eq).toUpperCase(), segment.slice(eq + 1).trim());
  }

  const freqRaw = (parts.get("FREQ") ?? "").toUpperCase();
  if (freqRaw !== "DAILY" && freqRaw !== "WEEKLY" && freqRaw !== "MONTHLY" && freqRaw !== "YEARLY") {
    return { note: `不支持的频率 ${freqRaw || "(缺失)"}` };
  }
  const freq: Frequency = freqRaw;

  for (const key of parts.keys()) {
    if (UNSUPPORTED_PARTS.includes(key)) return { note: `规则里的 ${key} 本版不支持` };
  }

  const intervalRaw = parts.get("INTERVAL") ?? "1";
  const interval = Number(intervalRaw);
  if (!Number.isInteger(interval) || interval < 1) {
    return { note: `INTERVAL 非法（${intervalRaw}）` };
  }

  let count: number | undefined;
  if (parts.has("COUNT")) {
    const raw = parts.get("COUNT")!;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) return { note: `COUNT 非法（${raw}）` };
    count = parsed;
  }

  let untilMs: number | undefined;
  if (parts.has("UNTIL")) {
    const raw = parts.get("UNTIL")!;
    const parsed = parseDate({ name: "UNTIL", params: {}, value: raw }, defaultTimeZone);
    if (!parsed) return { note: `UNTIL 无法解析（${raw}）` };
    untilMs = parsed.allDay ? parsed.ms + DAY_MS - 1 : parsed.ms;
  }

  let byDay: number[] | undefined;
  if (parts.has("BYDAY")) {
    const list = parts
      .get("BYDAY")!
      .toUpperCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const days: number[] = [];
    for (const item of list) {
      const day = WEEKDAYS[item];
      if (day === undefined) {
        return { note: `BYDAY 里的 ${item} 不支持（只接受 SU/MO/TU/WE/TH/FR/SA）` };
      }
      days.push(day);
    }
    if (freq !== "WEEKLY") return { note: `FREQ=${freq} 配 BYDAY 本版不支持` };
    byDay = [...new Set(days)].sort((a, b) => a - b);
  }

  let byMonthDay: number | undefined;
  if (parts.has("BYMONTHDAY")) {
    const raw = parts.get("BYMONTHDAY")!;
    const parsed = Number(raw);
    if (!/^\d{1,2}$/.test(raw) || parsed < 1 || parsed > 31) {
      return { note: `BYMONTHDAY 只支持 1~31 的正数（当前 ${raw}）` };
    }
    if (freq !== "MONTHLY" && freq !== "YEARLY") {
      return { note: `FREQ=${freq} 配 BYMONTHDAY 本版不支持` };
    }
    byMonthDay = parsed;
  }

  const rule: RecurrenceRule = { freq, interval };
  if (count !== undefined) rule.count = count;
  if (untilMs !== undefined) rule.untilMs = untilMs;
  if (byDay) rule.byDay = byDay;
  if (byMonthDay !== undefined) rule.byMonthDay = byMonthDay;
  return { rule };
}

interface WallDate {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function weekdayOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function addDays(y: number, mo: number, d: number, delta: number): [number, number, number] {
  const t = new Date(Date.UTC(y, mo - 1, d) + delta * DAY_MS);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

function addMonths(y: number, mo: number, delta: number): [number, number] {
  const total = y * 12 + (mo - 1) + delta;
  return [Math.floor(total / 12), (total % 12) + 1];
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/**
 * 按墙钟日历逐个产出候选实例。月度和年度规则遇到不存在的日期直接跳过，
 * 比如 1 月 31 日按月重复，2 月就没有实例，而不是滑到 3 月 3 日。
 */
function* wallCandidates(start: ParsedDate, rule: RecurrenceRule): Generator<WallDate> {
  const time = { h: start.h, mi: start.mi, s: start.s };

  // 周规则带 BYDAY 时，一周内的顺序按"距 DTSTART 的天数"排，不能按星期几排序：
  // DTSTART 是周三、BYDAY=MO,FR 时，周一在下周、周五在本周。
  if (rule.freq === "WEEKLY" && rule.byDay && rule.byDay.length > 0) {
    const startWeekday = weekdayOf(start.y, start.mo, start.d);
    const deltas = rule.byDay
      .map((day) => (day - startWeekday + 7) % 7)
      .sort((a, b) => a - b);
    for (let k = 0; k < MAX_ITERATIONS; k += 1) {
      for (const delta of deltas) {
        const [y, mo, d] = addDays(start.y, start.mo, start.d, 7 * rule.interval * k + delta);
        yield { y, mo, d, ...time };
      }
    }
    return;
  }

  for (let k = 0; k < MAX_ITERATIONS; k += 1) {
    if (rule.freq === "DAILY") {
      const [y, mo, d] = addDays(start.y, start.mo, start.d, rule.interval * k);
      yield { y, mo, d, ...time };
    } else if (rule.freq === "WEEKLY") {
      const [y, mo, d] = addDays(start.y, start.mo, start.d, 7 * rule.interval * k);
      yield { y, mo, d, ...time };
    } else if (rule.freq === "MONTHLY") {
      const [y, mo] = addMonths(start.y, start.mo, rule.interval * k);
      const day = rule.byMonthDay ?? start.d;
      if (day <= daysInMonth(y, mo)) yield { y, mo, d: day, ...time };
    } else {
      const y = start.y + rule.interval * k;
      const day = rule.byMonthDay ?? start.d;
      if (day <= daysInMonth(y, start.mo)) yield { y, mo: start.mo, d: day, ...time };
    }
  }
}

function wallToMs(w: WallDate, zone: string | undefined): number {
  if (zone === "UTC") return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  if (zone) return zonedToUtc(w.y, w.mo, w.d, w.h, w.mi, w.s, zone);
  return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();
}

/** 某个瞬间在事件自身时区里的墙钟，用来做"这条候选太旧"的廉价判断 */
function wallAt(ms: number, zone: string | undefined): WallDate {
  if (zone === "UTC") {
    const d = new Date(ms);
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      mi: d.getUTCMinutes(),
      s: d.getUTCSeconds(),
    };
  }
  if (zone) {
    const [y, mo, d, h, mi, s] = wallParts(ms, zone);
    return { y: y!, mo: mo!, d: d!, h: h!, mi: mi!, s: s! };
  }
  const d = new Date(ms);
  return {
    y: d.getFullYear(),
    mo: d.getMonth() + 1,
    d: d.getDate(),
    h: d.getHours(),
    mi: d.getMinutes(),
    s: d.getSeconds(),
  };
}

function dateNumber(w: WallDate): number {
  return w.y * 10000 + w.mo * 100 + w.d;
}

function wallKey(w: WallDate): string {
  return `${w.y}${pad(w.mo)}${pad(w.d)}T${pad(w.h)}${pad(w.mi)}${pad(w.s)}`;
}

function baseOccurrence(start: ParsedDate, durationMs: number | undefined): IcsOccurrence {
  const occurrence: IcsOccurrence = {
    startsAt: new Date(start.ms).toISOString(),
    key: wallKey(start),
  };
  if (durationMs !== undefined && durationMs > 0) {
    occurrence.endsAt = new Date(start.ms + durationMs).toISOString();
  }
  return occurrence;
}

function expandOccurrences(
  start: ParsedDate,
  rule: RecurrenceRule,
  exdates: Set<number>,
  nowMs: number,
  durationMs: number | undefined,
): IcsOccurrence[] {
  const out: IcsOccurrence[] = [];
  const horizon = nowMs + HORIZON_MS;
  let generated = 0;
  // 起点在很多年前的规则（比如 2015 年开始的每日晨会）会产出几千条历史候选。
  // 这些日期一定早于窗口，只用来数 COUNT，不必做时区换算。
  const lowerDate = dateNumber(wallAt(nowMs - DAY_MS, start.zone));
  let isFirst = true;

  for (const wall of wallCandidates(start, rule)) {
    if (rule.count !== undefined && generated >= rule.count) break;
    if (!isFirst && dateNumber(wall) < lowerDate) {
      generated += 1;
      continue;
    }
    isFirst = false;
    const ms = wallToMs(wall, start.zone);
    // UNTIL / 窗口都是按时间半点判断，跨时区时不能拿墙钟比
    if (rule.untilMs !== undefined && ms > rule.untilMs) break;
    if (ms > horizon) break;
    generated += 1;

    // COUNT 在 EXDATE 之前计数（RFC 5545：先按 RRULE 生成，再排除 EXDATE）
    if (exdates.has(ms)) continue;
    // 首个实例始终保留，之后只导入最近一天以远的
    if (out.length > 0 && ms < nowMs - DAY_MS) continue;

    const occurrence: IcsOccurrence = {
      startsAt: new Date(ms).toISOString(),
      key: wallKey(wall),
    };
    if (durationMs !== undefined && durationMs > 0) {
      occurrence.endsAt = new Date(ms + durationMs).toISOString();
    }
    out.push(occurrence);
    if (out.length >= MAX_OCCURRENCES) break;
  }

  // 窗口内一个实例都没有（规则已结束、或起点在很远未来）时保留 DTSTART，
  // 否则这条日程会从库里凭空消失
  if (out.length === 0) out.push(baseOccurrence(start, durationMs));
  return out;
}

function parseEvent(lines: string[], defaultTimeZone: string | undefined, now: Date): IcsEvent {
  const props = new Map<string, IcsProp>();
  const exdateProps: IcsProp[] = [];
  for (const line of lines) {
    const prop = parseProp(line);
    if (!prop) continue;
    props.set(prop.name, prop);
    // EXDATE 可以出现多行，用 Map 存会只剩最后一条
    if (prop.name === "EXDATE") exdateProps.push(prop);
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
  let durationMs: number | undefined;
  if (parsedStart) {
    const endProp = props.get("DTEND");
    const parsedEnd = endProp ? parseDate(endProp, defaultTimeZone) : undefined;
    if (parsedEnd) {
      endsAt = new Date(parsedEnd.ms).toISOString();
    } else {
      const duration = props.get("DURATION");
      const parsedDuration = duration ? parseDuration(duration.value) : undefined;
      if (parsedDuration !== undefined) {
        endsAt = new Date(parsedStart.ms + parsedDuration).toISOString();
      }
    }
    if (endsAt) {
      const endMs = Date.parse(endsAt);
      if (endMs > parsedStart.ms) durationMs = endMs - parsedStart.ms;
    }
  }

  let occurrences: IcsOccurrence[];
  let recurrenceNote: string | undefined;
  const rruleProp = props.get("RRULE");
  if (parsedStart && rruleProp && !parseError) {
    const { rule, note } = parseRRule(rruleProp.value, defaultTimeZone);
    if (!rule) {
      recurrenceNote = note;
      occurrences = [baseOccurrence(parsedStart, durationMs)];
    } else {
      const exdates = new Set<number>();
      for (const prop of exdateProps) {
        // 一行可以写多个日期，每个 EXDATE 行还可能有自己的 TZID
        for (const raw of prop.value.split(",")) {
          const parsed = parseDate(
            { name: "EXDATE", params: prop.params, value: raw },
            defaultTimeZone,
          );
          if (parsed) exdates.add(parsed.ms);
        }
      }
      occurrences = expandOccurrences(
        parsedStart,
        rule,
        exdates,
        now.getTime(),
        durationMs,
      );
    }
  } else if (parsedStart) {
    occurrences = [baseOccurrence(parsedStart, durationMs)];
  } else {
    // 连 DTSTART 都解析不出来，也要留一条占位才能落 pending_review
    occurrences = [{ startsAt, key: "fallback" }];
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
    occurrences,
    recurrenceNote,
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

function renderContent(event: IcsEvent, occurrence: IcsOccurrence, index: number): string {
  const start = new Date(occurrence.startsAt);
  const parts: string[] = [];
  if (event.allDay) {
    parts.push(`日期：${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}（全天）`);
  } else {
    parts.push(`时间：${formatLocal(start)}（${occurrence.startsAt}）`);
  }
  if (occurrence.endsAt) parts.push(`结束：${formatLocal(new Date(occurrence.endsAt))}`);
  if (event.location) parts.push(`地点：${event.location}`);
  if (event.description) parts.push(`说明：${event.description}`);
  if (event.recurring) {
    parts.push(
      event.recurrenceNote
        ? `重复：是（未展开：${event.recurrenceNote}）`
        : `重复：是（已展开，这是第 ${index + 1}/${event.occurrences.length} 个实例）`,
    );
  }
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

    for (const [occurrenceIndex, occurrence] of event.occurrences.entries()) {
      // 哈希用 UID + 原始块，同一次导入重复执行得到同一个键；
      // 不用解析后的时间，避免解析器的时区行为变化导致重复入库。
      // 重复事件再加上实例的墙钟标识，否则每个实例哈希都一样、只留得下第一条。
      const key = event.uid ?? index;
      const contentHash = createHash("sha256")
        .update(
          event.recurring
            ? `${opts.personId}|calendar|${key}|${event.raw}|${occurrence.key}`
            : `${opts.personId}|calendar|${key}|${event.raw}`,
        )
        .digest("hex");

      const baseRef = `${opts.sourceRef}#${key}`;
      const result = await ingestEvidence(
        store,
        {
          personId: opts.personId,
          kind: "calendar",
          capturedAt: occurrence.startsAt,
          title: event.summary,
          content: renderContent(event, occurrence, occurrenceIndex),
          sourceRef: event.recurring ? `${baseRef}-${occurrence.key}` : baseRef,
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
  }

  return { events, items, duplicates, cancelled, pending };
}