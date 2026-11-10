import { Pool, type PoolClient, type QueryResult } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db, Row } from "./db.js";

const SCHEMA = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");

/**
 * PostgreSQL 适配器。
 *
 * 两个关键点：
 *   1. 占位符：上层统一写 `?`，这里翻译成 `$1..$n`，所以 40 个方法的 SQL 一份就够；
 *   2. 事务：必须从连接池里**借一个独占 client**，不能 `pool.query("BEGIN")` ——
 *      池会把 BEGIN 和后面的语句分到不同连接上，事务等于没开。
 */
export class PgDb implements Db {
  private txDepth = 0;
  private txClient: PoolClient | undefined;

  private constructor(private readonly pool: Pool) {}

  static async open(url: string): Promise<PgDb> {
    const pool = new Pool({ connectionString: url });
    // 建表是多语句脚本，用 pool.query 走简单查询协议
    await pool.query(SCHEMA);
    return new PgDb(pool);
  }

  /** `?` → `$1, $2, ...`。我们的 SQL 里没有字符串字面量含问号，可以安全替换。 */
  private toPg(sql: string): string {
    let index = 0;
    return sql.replace(/\?/g, () => `$${(index += 1)}`);
  }

  private async exec(sql: string, params: unknown[]): Promise<QueryResult<Row>> {
    const text = this.toPg(sql);
    const runner = this.txClient ?? this.pool;
    return runner.query<Row>(text, params as never[]);
  }

  async all(sql: string, params: unknown[]): Promise<Row[]> {
    return (await this.exec(sql, params)).rows;
  }

  async one(sql: string, params: unknown[]): Promise<Row | undefined> {
    return (await this.exec(sql, params)).rows[0];
  }

  async run(sql: string, params: unknown[]): Promise<number> {
    return (await this.exec(sql, params)).rowCount ?? 0;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0) return fn();
    const client = await this.pool.connect();
    this.txClient = client;
    this.txDepth += 1;
    try {
      await client.query("BEGIN");
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      this.txDepth -= 1;
      this.txClient = undefined;
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}