import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type { SQLInputValue };

/**
 * `node:sqlite`, which Node 24 and Bun both have, with the two things the job store needs on top: statements are prepared once
 * per connection, and `transaction` wraps a function in BEGIN / COMMIT with a ROLLBACK when it throws. Parameters are positional.
 */
export class Db {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** The first row, or undefined. Rows are plain objects (node:sqlite's have no prototype). */
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    const row = this.prepare(sql).get(...params);
    return row === undefined ? undefined : ({ ...row } as T);
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }) as T);
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    return { changes: Number(this.prepare(sql).run(...params).changes) };
  }

  /**
   * Rows one by one. The statement is prepared afresh and not kept: a caller that stops early must not leave a cached statement
   * half-stepped for the next call.
   */
  *iterate<T>(sql: string, ...params: SQLInputValue[]): Generator<T> {
    for (const row of this.db.prepare(sql).iterate(...params)) yield { ...row } as T;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
