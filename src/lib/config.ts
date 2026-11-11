/** Seven days, measured in milliseconds. Equality with the cutoff is still kept. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Real server interval. Not a browser timer. */
export const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;

/** Delay before the first scheduled round after the process starts. */
export const SCHEDULER_BOOT_DELAY_MS = 4_000;

/** How often the scheduler compares the wall clock with the due time and renews its lease. */
export const SCHEDULER_TICK_MS = 20_000;

/** Scheduler lease lifetime. A killed process blocks its successor for at most this long. */
export const SCHEDULER_LEASE_TTL_MS = 90_000;

/** Retry delay when a scheduled slot found another refresh already running. */
export const SCHEDULER_BUSY_RETRY_MS = 60_000;

/** First retry delay after a round where every source failed; doubles up to the interval. */
export const SCHEDULER_FAILED_RETRY_MS = 10 * 60 * 1000;

/** Upper bound for an upstream Retry-After, so a bogus header cannot pause a source for days. */
export const MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** Manual refresh cooldown. Scheduled runs are not subject to it. */
export const MANUAL_COOLDOWN_MS = 60_000;

/** Per-source network timeout. One slow source does not extend the others. */
export const SOURCE_TIMEOUT_MS = 25_000;

/** Expiry badge turns red inside this window. */
export const EXPIRING_SOON_MS = 48 * 60 * 60 * 1000;

/** Manual attempts allowed per IP inside the window below. */
export const MANUAL_IP_LIMIT = 8;
export const MANUAL_IP_WINDOW_MS = 10 * 60 * 1000;

/** A round still marked running after this is treated as interrupted. */
export const DANGLING_ROUND_MS = 3 * 60 * 1000;

/** Telegram delivery timeout. A notification must never hold a refresh round open. */
export const TELEGRAM_TIMEOUT_MS = 8_000;

/** Per-message character budget, below Telegram's 4096 cap so HTML escaping still fits. */
export const TELEGRAM_MESSAGE_MAX = 3_500;

/** New deals listed in one digest; the rest are summarized as a count. */
export const TELEGRAM_MAX_DEALS = 10;

/** Freshness thresholds surfaced by /api/health and the page banner. */
export const STALE_AFTER_MS = 2.5 * 60 * 60 * 1000;
export const SEVERE_AFTER_MS = 4 * 60 * 60 * 1000;

export const USER_AGENT = "PerkRadar/0.2.0 (+https://github.com/luobinger/PerkRadar)";
export const BOARD_PAGE_SIZE = 500;
export const BOARD_MAX_ITEMS = 100_000;
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_RESPONSE_CHARS = 1_500_000;
export const MAX_FEED_ITEMS = 2_000;
export const MAX_URL_CHARS = 2_048;
export const FUTURE_PUBLISH_TOLERANCE_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PUBLISH_MS = Date.UTC(2000, 0, 1);
export const SUMMARY_MAX = 160;
export const TITLE_MAX = 300;
