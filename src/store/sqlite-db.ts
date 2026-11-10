import { DatabaseSync } from "node:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Row } from "./db.js";

const SCHEMA = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");

/**
 * 同一进程内、同一个库文件上的事务串行闸门。
 *
 * 为什么需要：事务体是 async 的，`await` 会让出事件循环，另一个 Store 实例的
 * BEGIN IMMEDIATE 就会撞上写锁，拿到 SQLITE_BUSY 而不是我们想要的 CAS 冲突。
 * SQLite 本来也只允许一个写者，串行化不损失性能，还能让冲突语义和 PostgreSQL 一致。
 */
const txGates = new Map<string, Promise<unknown>>();

/**
 * SQLite 适配器：Node 内置 node:sqlite（同步 API），这里包成 Promise。
 *
 * 事务用 BEGIN IMMEDIATE —— 一开始就拿写锁，冲突早暴露，
 * 不会出现"读到旧值、写的时候才发现别人改过"的升级死锁。
 */
export class SqliteDb implements Db {
  private txDepth = 0;
  private readonly gateKey: string;

  private constructor(
    private readonly db: DatabaseSync,
    path: string,
  ) {
    this.gateKey = resolve(path);
  }

  static async open(path: string): Promise<SqliteDb> {
    await mkdir(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    // SQLite 特有的开关，放在这里而不是共用的 DDL 里
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    // 跨进程抢锁时最多等 5 秒，而不是立刻报 database is locked
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    return new SqliteDb(db, path);
  }

  /** 测试/演示用：连同 WAL 附属文件一起删干净。 */
  static async resetFiles(path: string): Promise<void> {
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
  }

  async all(sql: string, params: unknown[]): Promise<Row[]> {
    return this.db.prepare(sql).all(...(params as never[])) as Row[];
  }

  async one(sql: string, params: unknown[]): Promise<Row | undefined> {
    return this.db.prepare(sql).get(...(params as never[])) as Row | undefined;
  }

  async run(sql: string, params: unknown[]): Promise<number> {
    const result = this.db.prepare(sql).run(...(params as never[]));
    return Number(result.changes);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0) return fn();

    // 进程内串行：等前一个事务释放，避免 BEGIN IMMEDIATE 直接撞锁
    const previous = txGates.get(this.gateKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    txGates.set(this.gateKey, previous.then(() => gate));
    await previous;

    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth += 1;
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.txDepth -= 1;
      release();
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}