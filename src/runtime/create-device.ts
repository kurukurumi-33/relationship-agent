import type { DeviceAdapter } from "./device.js";
import { MockDevice } from "./device.js";
import { IcsFileDevice } from "./ics-file-device.js";

export type DeviceKind = "mock" | "ics-file";

export interface CreateDeviceOptions {
  /** 命令行 --device 或环境变量 RELATIONSHIP_DEVICE，默认 mock */
  kind?: string;
  /** mock 的 jsonl 账本路径 */
  ledgerPath: string;
  /** 文件日历设备的输出目录 */
  calendarDir: string;
}

export function parseDeviceKind(value: string | undefined): DeviceKind {
  const kind = (value ?? "mock").trim().toLowerCase();
  if (kind === "mock") return "mock";
  if (kind === "ics" || kind === "ics-file") return "ics-file";
  throw new Error(`未知设备 ${JSON.stringify(value)}，可选：mock / ics-file`);
}

export function createDevice(options: CreateDeviceOptions): DeviceAdapter {
  const kind = parseDeviceKind(options.kind);
  if (kind === "ics-file") return new IcsFileDevice({ dir: options.calendarDir });
  return new MockDevice(options.ledgerPath);
}