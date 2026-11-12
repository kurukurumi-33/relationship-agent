import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionCard, Receipt } from "../domain/types.js";
import type { DeviceAdapter } from "./device.js";
import { isSafeId, readStart, renderEvent } from "./ics-render.js";

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