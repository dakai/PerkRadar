import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DANGLING_ROUND_MS } from "./config";

export type DealRow = {
  id: number;
  canonicalUrl: string;
  url: string;
  title: string;
  summary: string;
  category: string;
  sourceId: string;
  publishedAt: number | null;
  expiresAt: number | null;
  firstSeenAt: number;
  firstSeenRoundId: number;
  updatedAt: number;
};

export type RoundRow = {
  id: number;
  trigger: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
};

export type SourceRunRow = {
  id: number;
  roundId: number;
  sourceId: string;
  ok: boolean;
  fetchedCount: number;
  insertedCount: number;
  error: string | null;
  finalUrl: string | null;
  startedAt: number;
  finishedAt: number | null;
};

let current: DatabaseSync | null = null;

export function databaseFile(): string {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dir, "deals.db");
}

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  // Set the wait first: switching to WAL and the schema statements below take a lock too,
  // and without it they fail immediately when another process is mid-write.
  db.exec("PRAGMA busy_timeout = 5000;");
  if (filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY,
      canonical_url TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      source_id TEXT NOT NULL,
      published_at INTEGER,
      expires_at INTEGER,
      first_seen_at INTEGER NOT NULL,
      first_seen_round_id INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY,
      trigger TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_runs (
      id INTEGER PRIMARY KEY,
      round_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      ok INTEGER NOT NULL,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      final_url TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deals_source ON deals(source_id);
    CREATE INDEX IF NOT EXISTS idx_source_runs_round ON source_runs(round_id);
  `);
  migrateDatabase(db);
  return db;
}

export function migrateDatabase(db: DatabaseSync): void {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version > 1) { db.close(); throw new Error("数据库版本高于程序支持版本，拒绝降级"); }
  if (version === 1) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_source_runs_source_round ON source_runs(source_id, round_id DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_rounds_finished ON rounds(finished_at);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      PRAGMA user_version = 1;
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function acquireLease(name: string, owner: string, now: number, ttlMs: number): boolean {
  const result = getDb().prepare(`INSERT INTO leases(name, owner, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
    WHERE leases.expires_at <= ? OR leases.owner = ?`).run(name, owner, now + ttlMs, now, owner);
  return Number(result.changes) === 1;
}
export function renewLease(name: string, owner: string, now: number, ttlMs: number): boolean {
  return Number(getDb().prepare("UPDATE leases SET expires_at=? WHERE name=? AND owner=? AND expires_at>?").run(now + ttlMs, name, owner, now).changes) === 1;
}
export function releaseLease(name: string, owner: string): void {
  getDb().prepare("DELETE FROM leases WHERE name=? AND owner=?").run(name, owner);
}
/** Keep the latest completed round even after prolonged downtime. Never touch deals here. */
export function pruneHistory(cutoff: number): void {
  getDb().prepare(`DELETE FROM source_runs WHERE round_id IN
    (SELECT id FROM rounds WHERE finished_at < ? AND status != 'running' AND id !=
      (SELECT COALESCE(MAX(id),0) FROM rounds WHERE status != 'running'))`).run(cutoff);
  getDb().prepare(`DELETE FROM rounds WHERE finished_at < ? AND status != 'running' AND id !=
    (SELECT COALESCE(MAX(id),0) FROM rounds WHERE status != 'running')`).run(cutoff);
}

export function useDatabase(db: DatabaseSync | null): void {
  if (current && current !== db) {
    try {
      current.close();
    } catch {
      // The previous handle may already be closed in tests.
    }
  }
  current = db;
}

export function getDb(): DatabaseSync {
  if (!current) current = openDatabase(databaseFile());
  return current;
}

function asNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapDeal(row: Record<string, unknown>): DealRow {
  return {
    id: asNumber(row.id) ?? 0,
    canonicalUrl: String(row.canonical_url),
    url: String(row.url),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    category: String(row.category),
    sourceId: String(row.source_id),
    publishedAt: asNumber(row.published_at),
    expiresAt: asNumber(row.expires_at),
    firstSeenAt: asNumber(row.first_seen_at) ?? 0,
    firstSeenRoundId: asNumber(row.first_seen_round_id) ?? 0,
    updatedAt: asNumber(row.updated_at) ?? 0,
  };
}

export function getMeta(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? String(row.value) : null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function listDeals(): DealRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM deals ORDER BY COALESCE(published_at, first_seen_at) DESC, id DESC",
    )
    .all()
    .map(mapDeal);
}

/** Deals first stored by one round. Used for the one notification that round may send. */
export function listDealsInsertedInRound(roundId: number): DealRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM deals WHERE first_seen_round_id = ? ORDER BY COALESCE(published_at, first_seen_at) DESC, id DESC",
    )
    .all(roundId)
    .map(mapDeal);
}

export function findDealByCanonical(canonicalUrl: string): DealRow | null {
  const row = getDb().prepare("SELECT * FROM deals WHERE canonical_url = ?").get(canonicalUrl);
  return row ? mapDeal(row) : null;
}

export function insertDeal(input: Omit<DealRow, "id">): number {
  const result = getDb()
    .prepare(
      `INSERT INTO deals (
        canonical_url, url, title, summary, category, source_id,
        published_at, expires_at, first_seen_at, first_seen_round_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.canonicalUrl,
      input.url,
      input.title,
      input.summary,
      input.category,
      input.sourceId,
      input.publishedAt,
      input.expiresAt,
      input.firstSeenAt,
      input.firstSeenRoundId,
      input.updatedAt,
    );
  return Number(result.lastInsertRowid);
}

export function updateDeal(
  id: number,
  input: {
    url: string;
    title: string;
    summary: string;
    category: string;
    publishedAt: number | null;
    expiresAt: number | null;
    updatedAt: number;
  },
): void {
  getDb()
    .prepare(
      `UPDATE deals
       SET url = ?, title = ?, summary = ?, category = ?, published_at = ?, expires_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.url,
      input.title,
      input.summary,
      input.category,
      input.publishedAt,
      input.expiresAt,
      input.updatedAt,
      id,
    );
}

export function deleteDeal(id: number): void {
  getDb().prepare("DELETE FROM deals WHERE id = ?").run(id);
}

export function insertRound(trigger: string, startedAt: number): number {
  const result = getDb()
    .prepare("INSERT INTO rounds (trigger, started_at, status) VALUES (?, ?, 'running')")
    .run(trigger, startedAt);
  return Number(result.lastInsertRowid);
}

export function finishRound(id: number, finishedAt: number, status: string): void {
  getDb()
    .prepare("UPDATE rounds SET finished_at = ?, status = ? WHERE id = ?")
    .run(finishedAt, status, id);
}

export function insertSourceRun(input: Omit<SourceRunRow, "id">): void {
  getDb()
    .prepare(
      `INSERT INTO source_runs (
        round_id, source_id, ok, fetched_count, inserted_count, error, final_url, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.roundId,
      input.sourceId,
      input.ok ? 1 : 0,
      input.fetchedCount,
      input.insertedCount,
      input.error,
      input.finalUrl,
      input.startedAt,
      input.finishedAt,
    );
}

/** Runs from the most recent finished round before `roundId`, for anomaly checks. */
export function previousSourceRuns(roundId: number): SourceRunRow[] {
  const row = getDb()
    .prepare("SELECT MAX(id) AS id FROM rounds WHERE status != 'running' AND id < ?")
    .get(roundId) as Record<string, unknown> | undefined;
  const id = asNumber(row?.id);
  return id == null ? [] : listSourceRuns(id);
}

/** Return recent completed runs for one source, bounded for predictable health reads. */
export function recentSourceRuns(sourceId: string, limit = 8): SourceRunRow[] {
  const bounded = Math.max(1, Math.min(32, Math.floor(limit)));
  return getDb()
    .prepare(
      `SELECT sr.*
       FROM source_runs sr
       JOIN rounds r ON r.id = sr.round_id
       WHERE sr.source_id = ? AND r.status != 'running'
       ORDER BY sr.round_id DESC, sr.id DESC
       LIMIT ?`,
    )
    .all(sourceId, bounded)
    .map((row) => ({
      id: asNumber(row.id) ?? 0,
      roundId: asNumber(row.round_id) ?? 0,
      sourceId: String(row.source_id),
      ok: Number(row.ok) === 1,
      fetchedCount: asNumber(row.fetched_count) ?? 0,
      insertedCount: asNumber(row.inserted_count) ?? 0,
      error: row.error == null ? null : String(row.error),
      finalUrl: row.final_url == null ? null : String(row.final_url),
      startedAt: asNumber(row.started_at) ?? 0,
      finishedAt: asNumber(row.finished_at),
    }));
}

function mapRound(row: Record<string, unknown>): RoundRow {
  return {
    id: asNumber(row.id) ?? 0,
    trigger: String(row.trigger),
    startedAt: asNumber(row.started_at) ?? 0,
    finishedAt: asNumber(row.finished_at),
    status: String(row.status),
  };
}

export function latestFinishedRound(): RoundRow | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM rounds WHERE status != 'running' ORDER BY id DESC LIMIT 1",
    )
    .get();
  return row ? mapRound(row) : null;
}

export function listSourceRuns(roundId: number): SourceRunRow[] {
  return getDb()
    .prepare("SELECT * FROM source_runs WHERE round_id = ? ORDER BY id ASC")
    .all(roundId)
    .map((row) => ({
      id: asNumber(row.id) ?? 0,
      roundId: asNumber(row.round_id) ?? 0,
      sourceId: String(row.source_id),
      ok: Number(row.ok) === 1,
      fetchedCount: asNumber(row.fetched_count) ?? 0,
      insertedCount: asNumber(row.inserted_count) ?? 0,
      error: row.error == null ? null : String(row.error),
      finalUrl: row.final_url == null ? null : String(row.final_url),
      startedAt: asNumber(row.started_at) ?? 0,
      finishedAt: asNumber(row.finished_at),
    }));
}

/** Mark rounds abandoned by a crashed process so the UI does not stay on "running" forever. */
export function recoverDanglingRounds(now: number): void {
  const rows = getDb()
    .prepare("SELECT id, started_at FROM rounds WHERE status = 'running'")
    .all();
  const finish = getDb().prepare(
    "UPDATE rounds SET status = 'failed', finished_at = ? WHERE id = ?",
  );
  const markRuns = getDb().prepare(
    `UPDATE source_runs
     SET ok = 0, error = COALESCE(error, '进程中断'), finished_at = COALESCE(finished_at, ?)
     WHERE round_id = ? AND finished_at IS NULL`,
  );
  for (const row of rows) {
    const started = asNumber(row.started_at) ?? 0;
    if (now - started < DANGLING_ROUND_MS) continue;
    const id = asNumber(row.id) ?? 0;
    finish.run(now, id);
    markRuns.run(now, id);
  }
}

export function beginImmediate(): void {
  getDb().exec("BEGIN IMMEDIATE");
}

export function commit(): void {
  getDb().exec("COMMIT");
}

export function rollback(): void {
  getDb().exec("ROLLBACK");
}
