import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionCard, Receipt } from "../domain/types.js";
import type { DeviceAdapter } from "./device.js";

/**
 * 文件日历设备：把确认过的动作写成一个个 .ics 文件，用户手动导入系统日历。
 *
 * 它不是"静默修改系统日历"，只是一个可导入目录。之所以先做这一版，是因为它
 * 零凭据、零服务，却完整满足 DeviceAdapter 的两个契约：
 *   - execute 写文件，路径由 requestId 决定，重复执行不会产生第二个;
 *   - lookup 查文件是否存在，查得到就是执行过，查不到就是没执行过。
 *
 * 写文件用"临时文件 + rename"，所以目录里出现某个 .ics 就意味着内容完整，
 * 不存在"写了一半"这种状态。
 */
export interface IcsFileDeviceOptions {
  /** 输出目录，通常是 data/device-calendar */
  dir: string;
  /** 测试用，默认取系统时间 */
  clock?: () => Date;
}

const CALENDAR_EVENT_DURATION_MINUTES = 60;
/** 提醒本身没有时长，占 15 分钟只是为了让日历上显示一个块 */
const REMINDER_DURATION_MINUTES = 15;
const MINUTE_MS = 60 * 1000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** ICS 的 UTC 时间格式：20261120T110000Z */
function icsStamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/** TEXT 值里的 \ ; , 和换行都要转义 */
function escapeText(value: string): string {
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
function foldLine(line: string): string {
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

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

/** payload.at 必须带时区偏移。规则层会拦，但设备层不能假设上游一定拦过。 */
function readStart(card: ActionCard): number | undefined {
  const at = card.payload.at;
  if (typeof at !== "string" || !/T.*(Z|[+-]\d{2}:?\d{2})$/.test(at.trim())) return undefined;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? undefined : ms;
}

function readDuration(card: ActionCard): number {
  const raw = card.payload.durationMinutes;
  const minutes =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : card.kind === "reminder"
        ? REMINDER_DURATION_MINUTES
        : CALENDAR_EVENT_DURATION_MINUTES;
  return Math.min(minutes, 24 * 60) * MINUTE_MS;
}

function renderEvent(card: ActionCard, startMs: number, stampMs: number): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//relationship-agent//ics-file-device//CN",
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

export class IcsFileDevice implements DeviceAdapter {
  readonly id = "ics-file";
  private readonly clock: () => Date;

  constructor(private readonly options: IcsFileDeviceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  private pathFor(requestId: string): string {
    if (!isSafeId(requestId)) {
      throw new Error(`requestId 不能直接当文件名：${JSON.stringify(requestId)}`);
    }
    return join(this.options.dir, `${requestId}.ics`);
  }

  async execute(card: ActionCard): Promise<Receipt> {
    const now = this.clock();
    const failed = (detail: string, retryable = false): Receipt => ({
      requestId: card.requestId,
      deviceId: this.id,
      status: "failed",
      at: now.toISOString(),
      detail,
      retryable,
    });

    if (card.kind === "draft_message") {
      return failed("文件日历设备只处理日程和提醒，消息草稿需要另一个通道");
    }
    if (!isSafeId(card.requestId)) {
      return failed(`requestId 不能作为文件名：${JSON.stringify(card.requestId)}`);
    }
    const startMs = readStart(card);
    if (startMs === undefined) {
      return failed("payload.at 必须是带时区偏移的 ISO 时间，例如 2026-11-20T09:00:00+08:00");
    }

    const path = this.pathFor(card.requestId);
    try {
      // 设备可能在上次执行成功、回执没落库的情况下被重试。
      // 文件已经存在就当作执行过，不覆盖用户可能已经改过的内容。
      try {
        await stat(path);
        return {
          requestId: card.requestId,
          deviceId: this.id,
          status: "ok",
          at: now.toISOString(),
          detail: `日历文件已存在，未重复写入：${path}`,
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      await mkdir(this.options.dir, { recursive: true });
      const temp = `${path}.tmp-${process.pid}-${now.getTime()}`;
      await writeFile(temp, renderEvent(card, startMs, now.getTime()), "utf8");
      try {
        await rename(temp, path);
      } catch (err) {
        await unlink(temp).catch(() => {});
        throw err;
      }
      return {
        requestId: card.requestId,
        deviceId: this.id,
        status: "ok",
        at: now.toISOString(),
        detail: `已写入 ${path}`,
      };
    } catch (err) {
      // 磁盘满、目录被占、没权限都属于"不知道设备到底做没做"，标可重试
      return failed(`写日历文件失败：${(err as Error).message}`, true);
    }
  }

  async lookup(requestId: string): Promise<Receipt | undefined> {
    const path = this.pathFor(requestId);
    // Windows 上 stat("某个文件/子项") 返回的是 ENOENT，不是 ENOTDIR。
    // 不先检查目录，磁盘不可用时会被误判成"设备确实没执行过"，
    // 而契约要求查询失败必须抛异常。
    try {
      const dirInfo = await stat(this.options.dir);
      if (!dirInfo.isDirectory()) {
        throw new Error(`设备目录不是一个目录：${this.options.dir}`);
      }
    } catch (err) {
      // 目录不存在 = 一条都没执行过
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    try {
      const info = await stat(path);
      return {
        requestId,
        deviceId: this.id,
        status: "ok",
        at: info.mtime.toISOString(),
        detail: `日历文件存在：${path}`,
      };
    } catch (err) {
      // 查不到文件 = 设备确实没执行过；其它错误必须抛，不能冒充"没执行"
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /** 读回某个事件的 ICS 文本，供核对和测试使用；不存在返回 undefined */
  async readRaw(requestId: string): Promise<string | undefined> {
    try {
      return await readFile(this.pathFor(requestId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
}