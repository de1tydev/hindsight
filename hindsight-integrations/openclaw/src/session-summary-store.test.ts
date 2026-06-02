import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SESSION_SUMMARY_SCHEMA_VERSION, SessionSummaryStore } from "./session-summary-store.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hindsight-openclaw-summary-"));
  tempDirs.push(dir);
  return join(dir, "summary.sqlite");
}

function makeWrite(overrides = {}) {
  return {
    summaryKey: "bank/session",
    identityScope: "bank",
    summaryJson: { topics: ["setup"] },
    summaryText: "setup summary",
    turn: 4,
    turnHash: "turn-hash",
    lastInputHash: "input-hash-1",
    parentSummaryKey: null,
    status: "ready",
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("SessionSummaryStore", () => {
  it("creates the v1 schema and enables WAL plus busy timeout", () => {
    const dbPath = tempDbPath();
    const store = new SessionSummaryStore({ dbPath, busyTimeoutMs: 1234 });
    const storeDb = (store as unknown as { db: Database.Database }).db;
    expect(storeDb.pragma("busy_timeout", { simple: true })).toBe(1234);
    store.close();

    const db = new Database(dbPath);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("user_version", { simple: true })).toBe(SESSION_SUMMARY_SCHEMA_VERSION);
    const columns = db
      .prepare("PRAGMA table_info(session_summaries)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "summary_json",
        "summary_text",
        "schema_version",
        "version",
        "turn",
        "turn_hash",
        "identity_scope",
        "parent_summary_key",
        "status",
        "last_error",
      ])
    );
    db.close();
  });

  it("inserts and reads summary records without raw history fields", () => {
    const store = new SessionSummaryStore({ dbPath: tempDbPath() });
    const result = store.upsert(makeWrite());

    expect(result.inserted).toBe(true);
    expect(result.record).toMatchObject({
      summaryKey: "bank/session",
      identityScope: "bank",
      summaryJson: { topics: ["setup"] },
      summaryText: "setup summary",
      schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
      version: 1,
      turn: 4,
      turnHash: "turn-hash",
      lastInputHash: "input-hash-1",
      parentSummaryKey: null,
      status: "ready",
      lastError: null,
    });
    expect(Object.keys(result.record!)).not.toContain("rawTurns");
    store.close();
  });

  it("drops stale CAS writes without overwriting the current record", () => {
    const store = new SessionSummaryStore({ dbPath: tempDbPath() });
    store.upsert(makeWrite({ lastInputHash: "hash-1", summaryText: "one" }));
    const current = store.upsert(
      makeWrite({ expectedVersion: 1, lastInputHash: "hash-2", summaryText: "two" })
    );

    const stale = store.upsert(
      makeWrite({ expectedVersion: 1, lastInputHash: "hash-3", summaryText: "stale" })
    );

    expect(current.record?.version).toBe(2);
    expect(stale).toMatchObject({ inserted: false, updated: false, stale: true });
    expect(store.get("bank/session")).toMatchObject({ summaryText: "two", version: 2 });
    store.close();
  });

  it("drops cross-connection stale CAS writes interleaved after the initial read", () => {
    const dbPath = tempDbPath();
    const staleStore = new SessionSummaryStore({ dbPath });
    const currentStore = new SessionSummaryStore({ dbPath });
    staleStore.upsert(makeWrite({ lastInputHash: "hash-1", summaryText: "one" }));

    const originalGet = staleStore.get.bind(staleStore);
    let didInterleave = false;
    staleStore.get = (summaryKey: string) => {
      const record = originalGet(summaryKey);
      if (!didInterleave && record?.version === 1) {
        didInterleave = true;
        currentStore.upsert(
          makeWrite({ expectedVersion: 1, lastInputHash: "hash-2", summaryText: "two" })
        );
      }
      return record;
    };

    const stale = staleStore.upsert(
      makeWrite({ expectedVersion: 1, lastInputHash: "hash-3", summaryText: "stale" })
    );

    expect(didInterleave).toBe(true);
    expect(stale).toMatchObject({ inserted: false, updated: false, stale: true });
    expect(originalGet("bank/session")).toMatchObject({ summaryText: "two", version: 2 });
    staleStore.close();
    currentStore.close();
  });

  it("is idempotent for the same summary key and last input hash", () => {
    const store = new SessionSummaryStore({ dbPath: tempDbPath() });
    store.upsert(makeWrite({ lastInputHash: "same", summaryText: "first" }));
    const again = store.upsert(makeWrite({ lastInputHash: "same", summaryText: "second" }));

    expect(again).toMatchObject({
      inserted: false,
      updated: false,
      stale: false,
      idempotent: true,
    });
    expect(again.record).toMatchObject({ summaryText: "first", version: 1 });
    store.close();
  });

  it("renames a corrupt database and creates a fresh migrated database", () => {
    const dbPath = tempDbPath();
    writeFileSync(dbPath, "not a sqlite database", "utf8");

    const store = new SessionSummaryStore({ dbPath });
    const result = store.upsert(makeWrite());

    expect(result.inserted).toBe(true);
    expect(readdirSync(join(dbPath, "..")).some((name) => name.includes(".corrupt."))).toBe(true);
    store.close();
  });
});
