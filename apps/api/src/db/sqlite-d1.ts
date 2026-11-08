/**
 * Node-only Cloudflare D1 emulator for local development and tests.
 *
 * It implements the small subset of the D1 binding API that our adapter uses
 * (`prepare().bind().all()/run()/first()`, `batch()`, `exec()`) on top of
 * sql.js (SQLite compiled to WASM). Production Pages Functions never import
 * this file — they receive the real `DB` binding from Cloudflare.
 */
import { createRequire } from 'node:module';
import { D1_MIGRATIONS } from './d1-schema';

const require = createRequire(import.meta.url);
const initSqlJs: any = require('sql.js');

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = any>(): Promise<{ results: T[]; success: boolean }>;
  first<T = any>(column?: string): Promise<T | null>;
  run<T = any>(): Promise<{ success: boolean; results?: T[]; meta?: any }>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<any[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}

function normalise(v: unknown): any {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

export class SqliteD1 implements D1DatabaseLike {
  private db: any;
  private constructor(db: any) { this.db = db; }

  static async create(): Promise<SqliteD1> {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = OFF;');
    return new SqliteD1(db);
  }

  prepare(sql: string): D1PreparedStatement {
    let params: any[] = [];
    const self = this;
    const stmt = {
      bind(...values: unknown[]) { params = values.map(normalise); return stmt; },
      async all<T = any>() {
        const results = self.query<T>(sql, params);
        return { results, success: true };
      },
      async first<T = any>(column?: string) {
        const rows = self.query<any>(sql, params);
        const row = rows[0] ?? null;
        return column && row ? (row[column] as T) : (row as T | null);
      },
      async run<T = any>() {
        self.execute(sql, params);
        return { success: true as const, results: [] as T[], meta: { changes: self.db.getRowsModified() } };
      },
    };
    return stmt;
  }

  private query<T = any>(sql: string, params: any[] = []): T[] {
    const st = this.db.prepare(sql);
    try {
      if (params.length) st.bind(params);
      const rows: T[] = [];
      while (st.step()) rows.push(st.getAsObject() as T);
      return rows;
    } finally { st.free(); }
  }

  private execute(sql: string, params: any[] = []) {
    if (params.length) this.db.run(sql, params); else this.db.run(sql);
  }

  async batch(statements: D1PreparedStatement[]): Promise<any[]> {
    this.db.run('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.all());
      this.db.run('COMMIT');
      return out;
    } catch (e) { this.db.run('ROLLBACK'); throw e; }
  }

  async exec(sql: string) {
    const start = Date.now();
    this.db.exec(sql);
    return { count: this.db.getRowsModified(), duration: Date.now() - start };
  }

  /** Apply the same generated migrations a real D1 database receives. */
  async migrate(): Promise<string[]> {
    const applied: string[] = [];
    for (const m of D1_MIGRATIONS) {
      const ready = this.query<any>(`select name from sqlite_master where type='table' and name='_d1_migrations'`);
      const exists = ready.length
        ? this.query<any>(`select name from _d1_migrations where name = ?`, [m.name])
        : [];
      if (exists.length) continue;
      this.db.exec(m.sql);
      this.db.run('insert into _d1_migrations (name) values (?)', [m.name]);
      applied.push(m.name);
    }
    return applied;
  }

  /** Raw export used for provider-switch backups and tests. */
  export(): Uint8Array { return this.db.export(); }
  static async fromExport(bytes: Uint8Array): Promise<SqliteD1> {
    const SQL = await initSqlJs();
    return new SqliteD1(new SQL.Database(bytes));
  }
}
