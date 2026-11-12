import type { DeviceAdapter } from "./device.js";
import { MockDevice } from "./device.js";
import { CalDavDevice } from "./caldav-device.js";
import { IcsFileDevice } from "./ics-file-device.js";

export type DeviceKind = "mock" | "ics-file" | "caldav";

export interface CreateDeviceOptions {
  /** 命令行 --device 或环境变量 RELATIONSHIP_DEVICE，默认 mock */
  kind?: string;
  /** mock 的 jsonl 账本路径 */
  ledgerPath: string;
  /** 文件日历设备的输出目录 */
  calendarDir: string;
  caldav?: {
    /** --caldav-url 或 RELATIONSHIP_CALDAV_URL */
    url?: string;
    /** --caldav-user 或 RELATIONSHIP_CALDAV_USER */
    username?: string;
    /** 只从 RELATIONSHIP_CALDAV_PASSWORD 读，不接受命令行参数（会留在 shell 历史里） */
    password?: string;
  };
}

export function parseDeviceKind(value: string | undefined): DeviceKind {
  const kind = (value ?? "mock").trim().toLowerCase();
  if (kind === "mock") return "mock";
  if (kind === "ics" || kind === "ics-file") return "ics-file";
  if (kind === "caldav") return "caldav";
  throw new Error(`未知设备 ${JSON.stringify(value)}，可选：mock / ics-file / caldav`);
}

export function createDevice(options: CreateDeviceOptions): DeviceAdapter {
  const kind = parseDeviceKind(options.kind);
  if (kind === "ics-file") return new IcsFileDevice({ dir: options.calendarDir });
  if (kind === "caldav") {
    const url = options.caldav?.url;
    if (!url) {
      throw new Error("caldav 设备需要日历集合地址：--caldav-url 或 RELATIONSHIP_CALDAV_URL");
    }
    return new CalDavDevice({
      url,
      username: options.caldav?.username,
      password: options.caldav?.password,
    });
  }
  return new MockDevice(options.ledgerPath);
}