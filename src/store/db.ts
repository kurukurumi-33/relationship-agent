/**
 * 数据库驱动的最小抽象。
 *
 * 上层（SqlStore）只写一份 SQL，用 `?` 占位符；SQLite 适配器原样执行，
 * PostgreSQL 适配器把 `?` 翻译成 `$1..$n`。
 *
 * 这样换库只需要换一个适配器，不用把 40 个方法重写一遍。
 */

export type Row = Record<string, unknown>;

export interface Db {
  all(sql: string, params: unknown[]): Promise<Row[]>;
  one(sql: string, params: unknown[]): Promise<Row | undefined>;
  /** 返回受影响行数 —— CAS 和幂等都靠这个信号 */
  run(sql: string, params: unknown[]): Promise<number>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}