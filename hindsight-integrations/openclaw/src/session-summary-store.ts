import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { dirname } from "path";

export const SESSION_SUMMARY_SCHEMA_VERSION = 1;

export interface SessionSummaryStoreOptions {
  dbPath: string;
  busyTimeoutMs?: number;
}

export interface SessionSummaryRecord {
  summaryKey: string;
  identityScope: string;
  summaryJson: unknown | null;
  summaryText: string;
  schemaVersion: number;
  version: number;
  turn: number;
  turnHash: string;
  lastInputHash: string;
  parentSummaryKey: string | null;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummaryWrite {
  summaryKey: string;
  identityScope: string;
  summaryJson?: unknown | null;
  summaryText?: string;
  schemaVersion?: number;
  turn?: number;
  turnHash?: string;
  lastInputHash: string;
  parentSummaryKey?: string | null;
  status?: string;
  lastError?: string | null;
  expectedVersion?: number | null;
  now?: string | Date;
}

export interface SessionSummaryWriteResult {
  record: SessionSummaryRecord | null;
  inserted: boolean;
  updated: boolean;
  stale: boolean;
  idempotent: boolean;
}

interface SessionSummaryRow {
  summary_key: string;
  identity_scope: string;
  summary_json: string | null;
  summary_text: string;
  schema_version: number;
  version: number;
  turn: number;
  turn_hash: string;
  last_input_hash: string;
  parent_summary_key: string | null;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class SessionSummaryStore {
  private readonly dbPath: string;
  private readonly busyTimeoutMs: number;
  private db: Database.Database;

  constructor(opts: SessionSummaryStoreOptions) {
    this.dbPath = opts.dbPath;
    this.busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
    this.db = this.openWithRecovery();
    this.configure();
    this.migrate();
  }

  get(summaryKey: string): SessionSummaryRecord | null {
    const row = this.db
      .prepare("SELECT * FROM session_summaries WHERE summary_key = ?")
      .get(summaryKey) as SessionSummaryRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  upsert(write: SessionSummaryWrite): SessionSummaryWriteResult {
    validateWrite(write);
    const existing = this.get(write.summaryKey);
    if (existing && existing.lastInputHash === write.lastInputHash) {
      return {
        record: existing,
        inserted: false,
        updated: false,
        stale: false,
        idempotent: true,
      };
    }

    if (existing && write.expectedVersion != null && write.expectedVersion !== existing.version) {
      return {
        record: existing,
        inserted: false,
        updated: false,
        stale: true,
        idempotent: false,
      };
    }

    if (!existing && write.expectedVersion != null && write.expectedVersion > 0) {
      return {
        record: null,
        inserted: false,
        updated: false,
        stale: true,
        idempotent: false,
      };
    }

    const now = normalizeTimestamp(write.now);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO session_summaries (
            summary_key, identity_scope, summary_json, summary_text,
            schema_version, version, turn, turn_hash, last_input_hash,
            parent_summary_key, status, last_error, created_at, updated_at
          ) VALUES (
            @summaryKey, @identityScope, @summaryJson, @summaryText,
            @schemaVersion, 1, @turn, @turnHash, @lastInputHash,
            @parentSummaryKey, @status, @lastError, @createdAt, @updatedAt
          )`
        )
        .run(toWriteParams(write, now));
      return {
        record: this.get(write.summaryKey),
        inserted: true,
        updated: false,
        stale: false,
        idempotent: false,
      };
    }

    this.db
      .prepare(
        `UPDATE session_summaries
           SET identity_scope = @identityScope,
               summary_json = @summaryJson,
               summary_text = @summaryText,
               schema_version = @schemaVersion,
               version = version + 1,
               turn = @turn,
               turn_hash = @turnHash,
               last_input_hash = @lastInputHash,
               parent_summary_key = @parentSummaryKey,
               status = @status,
               last_error = @lastError,
               updated_at = @updatedAt
         WHERE summary_key = @summaryKey`
      )
      .run(toWriteParams(write, now));
    return {
      record: this.get(write.summaryKey),
      inserted: false,
      updated: true,
      stale: false,
      idempotent: false,
    };
  }

  close(): void {
    this.db.close();
  }

  private openWithRecovery(): Database.Database {
    const parentDir = dirname(this.dbPath);
    if (this.dbPath !== ":memory:" && parentDir !== ".") {
      mkdirSync(parentDir, { recursive: true });
    }
    try {
      const db = new Database(this.dbPath);
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") {
        db.close();
        throw new Error(`SQLite integrity_check failed: ${String(integrity)}`);
      }
      return db;
    } catch (err) {
      if (this.dbPath === ":memory:" || !existsSync(this.dbPath)) throw err;
      const corruptPath = this.corruptPath();
      try {
        unlinkSync(`${this.dbPath}-wal`);
      } catch {
        /* no wal file */
      }
      try {
        unlinkSync(`${this.dbPath}-shm`);
      } catch {
        /* no shm file */
      }
      renameSync(this.dbPath, corruptPath);
      return new Database(this.dbPath);
    }
  }

  private configure(): void {
    this.db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        summary_key TEXT PRIMARY KEY,
        identity_scope TEXT NOT NULL,
        summary_json TEXT,
        summary_text TEXT NOT NULL DEFAULT '',
        schema_version INTEGER NOT NULL,
        version INTEGER NOT NULL,
        turn INTEGER NOT NULL,
        turn_hash TEXT NOT NULL,
        last_input_hash TEXT NOT NULL,
        parent_summary_key TEXT,
        status TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_summaries_identity_scope
        ON session_summaries(identity_scope);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_parent
        ON session_summaries(parent_summary_key);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_status
        ON session_summaries(status);
      PRAGMA user_version = ${SESSION_SUMMARY_SCHEMA_VERSION};
    `);
  }

  private corruptPath(): string {
    return `${this.dbPath}.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  }
}

function validateWrite(write: SessionSummaryWrite): void {
  if (!write.summaryKey) throw new Error("summaryKey is required");
  if (!write.identityScope) throw new Error("identityScope is required");
  if (!write.lastInputHash) throw new Error("lastInputHash is required");
}

function normalizeTimestamp(value?: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  if (value) return value;
  return new Date().toISOString();
}

function toWriteParams(write: SessionSummaryWrite, now: string): Record<string, unknown> {
  return {
    summaryKey: write.summaryKey,
    identityScope: write.identityScope,
    summaryJson:
      write.summaryJson === undefined || write.summaryJson === null
        ? null
        : JSON.stringify(write.summaryJson),
    summaryText: write.summaryText ?? "",
    schemaVersion: write.schemaVersion ?? SESSION_SUMMARY_SCHEMA_VERSION,
    turn: write.turn ?? 0,
    turnHash: write.turnHash ?? "",
    lastInputHash: write.lastInputHash,
    parentSummaryKey: write.parentSummaryKey ?? null,
    status: write.status ?? "ready",
    lastError: write.lastError ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

function rowToRecord(row: SessionSummaryRow): SessionSummaryRecord {
  return {
    summaryKey: row.summary_key,
    identityScope: row.identity_scope,
    summaryJson: row.summary_json ? JSON.parse(row.summary_json) : null,
    summaryText: row.summary_text,
    schemaVersion: row.schema_version,
    version: row.version,
    turn: row.turn,
    turnHash: row.turn_hash,
    lastInputHash: row.last_input_hash,
    parentSummaryKey: row.parent_summary_key,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
