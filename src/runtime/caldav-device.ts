import type { ActionCard, Receipt } from "../domain/types.js";
import type { DeviceAdapter } from "./device.js";
import { isSafeId, readStart, renderEvent } from "./ics-render.js";

/**
 * CalDAV 设备：把确认过的动作 PUT 到日历服务，手机上的日历客户端会自动同步。
 *
 * 和文件设备相比只多了网络和凭据，两个契约没有变：
 *   - execute 用 `If-None-Match: *` 做条件写入，同一个 requestId 重复提交会得到
 *     412 Precondition Failed，按"已经存在"处理，不会产生第二条事件；
 *   - lookup 用 GET 查资源在不在，404 表示确实没有，其它状态码和网络错误必须抛。
 *
 * 条件写入还解决了一个网络层的麻烦：PUT 超时的时候，服务端可能已经收下了。
 * 这时回执只能是"可重试失败"，而重试会被 412 挡住，副作用仍然只有一次。
 */
export interface CalDavDeviceOptions {
  /** 日历集合的完整 URL，例如 https://host/remote.php/dav/calendars/user/personal/ */
  url: string;
  username?: string;
  password?: string;
  /** 测试用，默认取系统时间 */
  clock?: () => Date;
  /** 单次请求超时，默认 15 秒 */
  timeoutMs?: number;
}

export class CalDavDevice implements DeviceAdapter {
  readonly id = "caldav";
  private readonly base: string;
  private readonly clock: () => Date;
  private readonly timeoutMs: number;

  constructor(private readonly options: CalDavDeviceOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.url);
    } catch {
      throw new Error(`CalDAV 地址不是合法 URL：${JSON.stringify(options.url)}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`CalDAV 地址必须是 http(s)：${options.url}`);
    }
    this.base = options.url.endsWith("/") ? options.url : `${options.url}/`;
    this.clock = options.clock ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private urlFor(requestId: string): string {
    if (!isSafeId(requestId)) {
      throw new Error(`requestId 不能直接当资源名：${JSON.stringify(requestId)}`);
    }
    return `${this.base}${requestId}.ics`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    const { username, password } = this.options;
    if (username !== undefined) {
      const token = Buffer.from(`${username}:${password ?? ""}`, "utf8").toString("base64");
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  }

  async execute(card: ActionCard): Promise<Receipt> {
    const now = this.clock();
    const failed = (detail: string, retryable: boolean): Receipt => ({
      requestId: card.requestId,
      deviceId: this.id,
      status: "failed",
      at: now.toISOString(),
      detail,
      retryable,
    });

    if (card.kind === "draft_message") {
      return failed("CalDAV 设备只处理日程和提醒，消息草稿需要另一个通道", false);
    }
    if (!isSafeId(card.requestId)) {
      return failed(`requestId 不能作为资源名：${JSON.stringify(card.requestId)}`, false);
    }
    const startMs = readStart(card);
    if (startMs === undefined) {
      return failed(
        "payload.at 必须是带时区偏移的 ISO 时间，例如 2026-11-20T09:00:00+08:00",
        false,
      );
    }

    const url = this.urlFor(card.requestId);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: this.headers({
          "Content-Type": "text/calendar; charset=utf-8",
          // 资源已存在就让服务端拒绝，避免覆盖用户手动改过的日程
          "If-None-Match": "*",
        }),
        body: renderEvent(card, startMs, now.getTime(), "-//relationship-agent//caldav-device//CN"),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.status === 201 || response.status === 204 || response.status === 200) {
        return {
          requestId: card.requestId,
          deviceId: this.id,
          status: "ok",
          at: now.toISOString(),
          detail: `已写入 ${url}（HTTP ${response.status}）`,
        };
      }
      if (response.status === 412) {
        return {
          requestId: card.requestId,
          deviceId: this.id,
          status: "ok",
          at: now.toISOString(),
          detail: `日历服务上已存在同一 UID，未重复写入：${url}`,
        };
      }
      if (response.status === 401 || response.status === 403) {
        return failed(`日历服务拒绝凭据（HTTP ${response.status}）`, false);
      }
      if (response.status === 404) {
        return failed(`日历集合不存在（HTTP 404），检查 URL 是否指到具体日历：${url}`, false);
      }
      if (response.status === 409 || response.status === 423) {
        return failed(`日历服务暂时拒绝写入（HTTP ${response.status}）`, true);
      }
      return failed(`日历服务返回 HTTP ${response.status}`, response.status >= 500);
    } catch (err) {
      // 超时和连接中断都不等于"没写进去"，标可重试；重试会被条件写入兜住
      return failed(`请求日历服务失败：${(err as Error).message}`, true);
    }
  }

  async lookup(requestId: string): Promise<Receipt | undefined> {
    const url = this.urlFor(requestId);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: this.headers({ Accept: "text/calendar" }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`查询 CalDAV 失败：${(err as Error).message}`);
    }

    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`查询 CalDAV 失败：HTTP ${response.status}`);
    }
    const lastModified = response.headers.get("last-modified");
    const parsed = lastModified ? Date.parse(lastModified) : NaN;
    return {
      requestId,
      deviceId: this.id,
      status: "ok",
      at: Number.isNaN(parsed) ? this.clock().toISOString() : new Date(parsed).toISOString(),
      detail: `日历服务上存在该事件：${url}`,
    };
  }

  /** 读回某个事件的 ICS 文本，供核对和测试使用；不存在返回 undefined */
  async readRaw(requestId: string): Promise<string | undefined> {
    const url = this.urlFor(requestId);
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers({ Accept: "text/calendar" }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`读取 CalDAV 事件失败：HTTP ${response.status}`);
    return response.text();
  }
}