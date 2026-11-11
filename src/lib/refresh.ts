import { classify } from "./classify";
import { randomUUID } from "node:crypto";
import { HISTORY_RETENTION_MS, MANUAL_COOLDOWN_MS, SOURCE_TIMEOUT_MS } from "./config";
import {
  acquireLease, renewLease, releaseLease, pruneHistory,
  beginImmediate,
  commit,
  deleteDeal,
  findDealByCanonical,
  finishRound,
  getMeta,
  insertDeal,
  insertRound,
  insertSourceRun,
  listDeals,
  listDealsInsertedInRound,
  listSourceRuns,
  rollback,
  setMeta,
  updateDeal,
  type DealRow,
} from "./db";
import { normalizeError, type FetchLike } from "./http";
import { isStale } from "./retention";
import { listSources, loadSource } from "./sources";
import type { BoardState, ParsedItem } from "./types";
import { canonicalUrl } from "./url";
import { getBoardState } from "./board";
import { classifyFailure, logEvent, logFailure } from "./log";
import { writeDealSnapshot } from "./snapshot";
import { releaseRefreshLock, resetRefreshLockForTests, tryAcquireRefreshLock } from "./refresh-lock";
import { notifyRound, type NotifyRound, type RoundNotification } from "./telegram";

export { resetRefreshLockForTests };

export class RefreshRejected extends Error {
  code: "BUSY" | "COOLDOWN";
  retryAfterMs?: number;
  constructor(code: "BUSY" | "COOLDOWN", message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RefreshRejected";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

type LoadedSource =
  | {
      sourceId: string;
      ok: true;
      items: ParsedItem[];
      finalUrl: string;
      startedAt: number;
      finishedAt: number;
    }
  | {
      sourceId: string;
      ok: false;
      error: string;
      startedAt: number;
      finishedAt: number;
    };

export type RefreshOptions = {
  trigger: "manual" | "schedule";
  now?: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  cooldownMs?: number;
  /** Test seam for the one outbound notification a round may send. */
  notify?: NotifyRound;
};

function startTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
  }, ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

async function fetchAll(options: Required<Pick<RefreshOptions, "now" | "timeoutMs">> & {
  fetchImpl: FetchLike;
}): Promise<LoadedSource[]> {
  const sources = listSources();
  return Promise.all(
    sources.map(async (source): Promise<LoadedSource> => {
      const startedAt = Date.now();
      const timeout = startTimeout(options.timeoutMs);
      try {
        const loaded = await loadSource(source, {
          fetchImpl: options.fetchImpl,
          signal: timeout.signal,
          now: options.now,
        });
        return {
          sourceId: source.id,
          ok: true,
          items: loaded.items,
          finalUrl: loaded.finalUrl,
          startedAt,
          finishedAt: Date.now(),
        };
      } catch (error) {
        return {
          sourceId: source.id,
          ok: false,
          error: normalizeError(error),
          startedAt,
          finishedAt: Date.now(),
        };
      } finally {
        timeout.cancel();
      }
    }),
  );
}

function applySource(loaded: LoadedSource, roundId: number, now: number): number {
  if (loaded.ok === false) {
    insertSourceRun({
      roundId,
      sourceId: loaded.sourceId,
      ok: false,
      fetchedCount: 0,
      insertedCount: 0,
      error: loaded.error,
      finalUrl: null,
      startedAt: loaded.startedAt,
      finishedAt: loaded.finishedAt,
    });
    return 0;
  }

  let inserted = 0;
  const epicKeep = new Set<string>();
  for (const item of loaded.items) {
    let canonical: string;
    try {
      canonical = canonicalUrl(item.url);
    } catch {
      continue;
    }
    const publishedAt = item.publishedAt;
    const expiresAt = item.expiresAt;
    if (isStale({ publishedAt, firstSeenAt: now, expiresAt }, now)) {
      continue;
    }
    const title = item.title.trim();
    if (!title) continue;
    const existing = findDealByCanonical(canonical);
    if (existing && existing.sourceId !== loaded.sourceId) {
      if (loaded.sourceId === "epic") epicKeep.add(existing.canonicalUrl);
      continue;
    }
    const category = classify(title, loaded.sourceId);
    if (!existing) {
      insertDeal({
        canonicalUrl: canonical,
        url: canonical,
        title,
        summary: item.summary,
        category,
        sourceId: loaded.sourceId,
        publishedAt,
        expiresAt,
        firstSeenAt: now,
        firstSeenRoundId: roundId,
        updatedAt: now,
      });
      inserted += 1;
    } else {
      updateDeal(existing.id, {
        url: canonical,
        title,
        summary: item.summary,
        category,
        publishedAt: publishedAt ?? existing.publishedAt,
        expiresAt,
        updatedAt: now,
      });
    }
    if (loaded.sourceId === "epic") epicKeep.add(canonical);
  }

  if (loaded.sourceId === "epic") {
    for (const deal of listDeals()) {
      if (deal.sourceId === "epic" && !epicKeep.has(deal.canonicalUrl)) deleteDeal(deal.id);
    }
  }

  insertSourceRun({
    roundId,
    sourceId: loaded.sourceId,
    ok: true,
    fetchedCount: loaded.items.length,
    insertedCount: inserted,
    error: null,
    finalUrl: loaded.finalUrl,
    startedAt: loaded.startedAt,
    finishedAt: loaded.finishedAt,
  });
  return inserted;
}

function purgeStale(now: number): void {
  for (const deal of listDeals()) {
    if (
      isStale(
        {
          publishedAt: deal.publishedAt,
          firstSeenAt: deal.firstSeenAt,
          expiresAt: deal.expiresAt,
        },
        now,
      )
    ) {
      deleteDeal(deal.id);
    }
  }
}

/**
 * One refresh round. Overlapping calls fail fast.
 * A source that throws does not update deals already stored for that source.
 * Epic is reconciled only after a successful parse: games no longer free are removed.
 * Other sources keep items that scrolled off the feed until the 7-day or expiry boundary.
 */
export async function runRefresh(options: RefreshOptions): Promise<BoardState> {
  const now = options.now ?? Date.now();
  const cooldownMs = options.cooldownMs ?? MANUAL_COOLDOWN_MS;
  if (!tryAcquireRefreshLock()) {
    throw new RefreshRejected("BUSY", "已有刷新进行中");
  }

  const leaseOwner = randomUUID();
  let persistentLock = false;
  let notification: RoundNotification | null = null;
  try {
  persistentLock = acquireLease("refresh", leaseOwner, Date.now(), 180_000);
  if (!persistentLock) throw new RefreshRejected("BUSY", "另一进程已有刷新进行中");
  if (options.trigger === "manual") {
    const last = getMeta("last_manual_at");
    if (last && now - Number(last) < cooldownMs) {
      throw new RefreshRejected(
        "COOLDOWN",
        "刷新过于频繁，请稍后再试",
        cooldownMs - (now - Number(last)),
      );
    }
    setMeta("last_manual_at", String(now));
  }
    logEvent("round_start", { trigger: options.trigger, sources: listSources().length });
    const loaded = await fetchAll({
      now,
      timeoutMs: options.timeoutMs ?? SOURCE_TIMEOUT_MS,
      fetchImpl: options.fetchImpl ?? fetch,
    });
    if (!renewLease("refresh", leaseOwner, Date.now(), 180_000)) throw new Error("刷新租约已失效，丢弃本轮结果");
    beginImmediate();
    let roundId = 0;
    let roundStatus: "success" | "partial" | "failed" = "failed";
    let okSources = 0;
    let totalSources = 0;
    let newDeals: DealRow[] = [];
    let failures: RoundNotification["failures"] = [];
    try {
      if (!renewLease("refresh", leaseOwner, Date.now(), 180_000)) throw new Error("刷新租约已失效，丢弃本轮结果");
      roundId = insertRound(options.trigger, now);
      let totalInserted = 0;
      for (const source of loaded) totalInserted += applySource(source, roundId, now);
      purgeStale(now);
      const okCount = loaded.filter((source) => source.ok).length;
      roundStatus = okCount === loaded.length ? "success" : okCount === 0 ? "failed" : "partial";
      okSources = okCount;
      totalSources = loaded.length;
      finishRound(roundId, Date.now(), roundStatus);
      pruneHistory(now - HISTORY_RETENTION_MS);
      if (!renewLease("refresh", leaseOwner, Date.now(), 180_000)) throw new Error("刷新租约已失效，回滚本轮结果");
      commit();
      const runs = listSourceRuns(roundId);
      newDeals = listDealsInsertedInRound(roundId);
      failures = runs
        .filter((run) => !run.ok)
        .map((run) => ({ sourceId: run.sourceId, error: run.error }));
      logEvent("round_finished", {
        roundId,
        trigger: options.trigger,
        status: roundStatus,
        okSources: okCount,
        totalSources: loaded.length,
        inserted: totalInserted,
      });
      for (const run of runs) {
        logEvent("source_round", {
          roundId,
          sourceId: run.sourceId,
          ok: run.ok,
          attemptedAt: new Date(run.startedAt).toISOString(),
          completedAt: run.finishedAt == null ? null : new Date(run.finishedAt).toISOString(),
          durationMs: run.finishedAt == null ? null : run.finishedAt - run.startedAt,
          parsed: run.fetchedCount,
          inserted: run.insertedCount,
          finalUrl: run.finalUrl,
          error: run.error,
          reason: run.ok ? null : classifyFailure(run.error ?? ""),
        });
      }
    } catch (error) {
      try {
        rollback();
      } catch {
        // Already rolled back or never opened.
      }
      logFailure("round_write_failed", error, { trigger: options.trigger });
      throw error;
    }
    // After the commit only: a Telegram outage must never roll back a stored round.
    notification = {
      trigger: options.trigger,
      roundId,
      status: roundStatus,
      now,
      newDeals,
      failures,
      okSources,
      totalSources,
    };
  } finally {
    try { if (persistentLock) releaseLease("refresh", leaseOwner); } finally { releaseRefreshLock(); }
  }
  // Outside the lease: an unreachable Telegram must not block the next refresh.
  const payload = notification;
  if (payload) {
    try {
      await (options.notify ?? notifyRound)(payload);
    } catch (error) {
      logFailure("notification_failed", error, {
        roundId: payload.roundId,
        trigger: payload.trigger,
      });
    }
  }
  const board = getBoardState(now);
  try {
    writeDealSnapshot(board);
  } catch (error) {
    logFailure("snapshot_write_failed", error);
  }
  return board;
}
