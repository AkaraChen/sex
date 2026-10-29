import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/**
 * `node:sqlite`, which Node 24 and Bun both have, with the two things the stores need on top: statements are prepared once
 * per connection (preparing on every call costs about half again as much per operation), and `transaction` wraps a function in
 * BEGIN / COMMIT with a ROLLBACK when it throws.
 */
export class Sqlite {
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

  /** The first row, or undefined. Parameters are named without their `$` prefix. */
  get<T>(sql: string, params: Record<string, SQLInputValue> = {}): T | undefined {
    return this.prepare(sql).get(params) as T | undefined;
  }

  all<T>(sql: string, params: Record<string, SQLInputValue> = {}): T[] {
    return this.prepare(sql).all(params) as T[];
  }

  run(sql: string, params: Record<string, SQLInputValue> = {}): void {
    this.prepare(sql).run(params);
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
