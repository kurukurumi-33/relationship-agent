import type { StorePort } from "./port.js";
import { SqliteDb } from "./sqlite-db.js";
import { PgDb } from "./pg-db.js";
import { SqlStore } from "./sql-store.js";

export type { StorePort } from "./port.js";
export { GenerationConflictError, NotFoundError } from "./port.js";
export { SqlStore } from "./sql-store.js";
export { SqliteDb } from "./sqlite-db.js";
export { PgDb } from "./pg-db.js";

/** 上层只依赖这个类型，不关心底下是 SQLite 还是 PostgreSQL。 */
export type Store = StorePort;

export interface OpenStoreOptions {
  /** SQLite 文件路径（没有 DATABASE_URL 时使用） */
  path?: string;
  /** PostgreSQL 连接串（优先级高于 path，也高于环境变量） */
  url?: string;
}

/**
 * 唯一的入口：有 DATABASE_URL 就连 PG，没有就用本地 SQLite。
 *
 * 换库不改业务代码，就靠这一层。
 */
export async function openStore(opts: OpenStoreOptions = {}): Promise<StorePort> {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (url) return SqlStore.fromDb(await PgDb.open(url));
  return SqlStore.fromDb(await SqliteDb.open(opts.path ?? "data/state.db"));
}

/**
 * 兼容旧调用点的门面。
 *
 * 之所以同时导出 `const Store` 和 `type Store`：TS 允许值空间和类型空间同名，
 * 这样 `Store.open(path)` 和 `store: Store` 都不用改。
 */
export const Store = {
  async open(path: string): Promise<StorePort> {
    return openStore({ path });
  },
  /** 测试用：清掉 SQLite 文件及其 WAL 附属文件 */
  async reset(path: string): Promise<void> {
    await SqliteDb.resetFiles(path);
  },
};