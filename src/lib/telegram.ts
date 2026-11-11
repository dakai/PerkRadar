import { TELEGRAM_MAX_DEALS, TELEGRAM_MESSAGE_MAX, TELEGRAM_TIMEOUT_MS } from "./config";
import { classifySignals } from "./classify";
import type { DealRow } from "./db";
import type { FetchLike } from "./http";
import { logEvent, logFailure } from "./log";
import { sourceName } from "./source-defs";
import { formatBeijing } from "./time";

/**
 * Outbound Telegram messages.
 *
 * Delivery is best-effort: a missing token, an unreachable Telegram or a rejected
 * message must never fail a refresh round or roll back a stored one. Only public
 * deal fields are sent; access tokens, cookies and personal state never are.
 */

export type TelegramConfig = {
  botToken: string;
  chatId: string;
  messageThreadId: string | null;
  apiBase: string;
  timeoutMs: number;
  maxDeals: number;
  notifyFailures: boolean;
};

export type RoundNotification = {
  trigger: "manual" | "schedule";
  roundId: number;
  status: "success" | "partial" | "failed";
  now: number;
  newDeals: DealRow[];
  failures: { sourceId: string; error: string | null }[];
  okSources: number;
  totalSources: number;
};

export type NotifyRound = (input: RoundNotification) => Promise<void>;

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const raw = (value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function flag(value: string | undefined, fallback: boolean): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw);
}

/**
 * Read the bot configuration from the environment.
 * Both the bot token and the chat id are required; partial configuration stays off.
 */
export function readTelegramConfig(
  env: Record<string, string | undefined> = process.env,
): TelegramConfig | null {
  if (flag(env.TELEGRAM_DISABLE, false)) return null;
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = (env.TELEGRAM_CHAT_ID ?? "").trim();
  if (!botToken || !chatId) return null;
  return {
    botToken,
    chatId,
    messageThreadId: (env.TELEGRAM_MESSAGE_THREAD_ID ?? "").trim() || null,
    apiBase: ((env.TELEGRAM_API_BASE ?? "").trim() || "https://api.telegram.org").replace(/\/+$/, ""),
    timeoutMs: integer(env.TELEGRAM_TIMEOUT_MS, TELEGRAM_TIMEOUT_MS, 1_000, 30_000),
    maxDeals: integer(env.TELEGRAM_MAX_DEALS, TELEGRAM_MAX_DEALS, 1, 50),
    notifyFailures: flag(env.TELEGRAM_NOTIFY_FAILURES, true),
  };
}

/** Telegram HTML parse mode only understands a few tags, so all input is escaped. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dealBlock(index: number, deal: DealRow): string {
  const title = escapeHtml(deal.title.slice(0, 200));
  const meta = escapeHtml(`${deal.category} · ${sourceName(deal.sourceId)}`);
  // A truncated link is useless. Very long URLs are dropped instead of sent broken.
  const url = deal.url.length <= 500 ? escapeHtml(deal.url) : "链接过长，见看板";
  return `${index}. <b>${title}</b>\n${meta}\n${url}`;
}

/** Cut escaped text without leaving a half-written entity such as `&am`. */
function clipHtml(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, Math.max(0, max - 1));
  const amp = cut.lastIndexOf("&");
  if (amp !== -1 && !cut.slice(amp).includes(";")) cut = cut.slice(0, amp);
  return `${cut}…`;
}

/**
 * Split blocks into messages that stay below Telegram's 4096-character cap.
 * Every message repeats the header so a multi-part digest still reads on its own.
 */
function paginate(header: string, blocks: string[], limit: number): string[] {
  const messages: string[] = [];
  let current: string[] = [];
  let length = header.length;
  const flush = () => {
    if (current.length === 0) return;
    messages.push(`${header}\n\n${current.join("\n\n")}`);
    current = [];
    length = header.length;
  };
  for (const block of blocks) {
    const room = limit - header.length - 2;
    const safe = block.length > room ? clipHtml(block, room) : block;
    if (current.length > 0 && length + 2 + safe.length > limit) flush();
    current.push(safe);
    length += 2 + safe.length;
  }
  flush();
  return messages;
}

export function formatNewDealMessages(input: RoundNotification, maxDeals = TELEGRAM_MAX_DEALS): string[] {
  const total = input.newDeals.length;
  const shown = input.newDeals.slice(0, maxDeals);
  const header =
    `🎁 <b>PerkRadar 新增 ${total} 条优惠</b>\n` +
    `${formatBeijing(input.now)} · ${input.trigger === "manual" ? "手动刷新" : "定时刷新"}`;
  const blocks = shown.map((deal, index) => dealBlock(index + 1, deal));
  if (total > shown.length) blocks.push(`…另有 ${total - shown.length} 条，见看板。`);
  return paginate(header, blocks, TELEGRAM_MESSAGE_MAX);
}

export function formatRoundFailure(input: RoundNotification): string {
  const lines = [
    "⚠️ <b>PerkRadar 本轮刷新失败</b>",
    `${formatBeijing(input.now)} · ${input.trigger === "manual" ? "手动刷新" : "定时刷新"}`,
    `可用来源 ${input.okSources}/${input.totalSources}`,
  ];
  for (const failure of input.failures.slice(0, 10)) {
    const reason = escapeHtml((failure.error ?? "未知错误").slice(0, 160));
    lines.push(`- ${escapeHtml(sourceName(failure.sourceId))}：${reason}`);
  }
  if (input.failures.length > 10) lines.push(`…另有 ${input.failures.length - 10} 个来源失败。`);
  return lines.join("\n");
}

async function sendMessage(
  config: TelegramConfig,
  message: string,
  fetchImpl: FetchLike,
): Promise<boolean> {
  const url = `${config.apiBase}/bot${config.botToken}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), config.timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(config.messageThreadId ? { message_thread_id: Number(config.messageThreadId) } : {}),
      }),
      signal: controller.signal,
      redirect: "error",
    });
    const body = await response.text();
    let delivered = false;
    let description = "";
    try {
      const parsed = JSON.parse(body) as { ok?: boolean; description?: string };
      delivered = response.ok && parsed.ok === true;
      description = typeof parsed.description === "string" ? parsed.description.slice(0, 200) : "";
    } catch {
      delivered = false;
    }
    if (!delivered) {
      // Telegram echoes the offending text in some errors; keep only the reason.
      logFailure("telegram_send_failed", new Error(description || `HTTP ${response.status}`), {
        status: response.status,
      });
      return false;
    }
    return true;
  } catch (error) {
    logFailure("telegram_send_failed", error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send at most one digest per round: new deals when there are any, otherwise a
 * single failure alert for a round where every source failed. Silent rounds are
 * normal and produce no request at all.
 *
 * Only titles the classifier treats as deals are sent. General posts, software
 * updates, questions and second-hand trading threads land in 其他 and stay out,
 * matching the board's default view instead of pushing raw feed titles.
 */
export async function notifyRound(
  input: RoundNotification,
  config: TelegramConfig | null = readTelegramConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (!config) return;

  const eligible = input.newDeals.filter(
    (deal) => classifySignals(deal.title, deal.sourceId).contentType === "deal",
  );

  let messages: string[];
  if (eligible.length > 0) {
    messages = formatNewDealMessages({ ...input, newDeals: eligible }, config.maxDeals);
  } else if (input.status === "failed" && config.notifyFailures) {
    messages = [formatRoundFailure(input)];
  } else {
    if (input.newDeals.length > 0) {
      logEvent("telegram_skipped", {
        roundId: input.roundId,
        trigger: input.trigger,
        reason: "no_deal_content",
        newDeals: input.newDeals.length,
      });
    }
    return;
  }

  let sent = 0;
  for (const message of messages) {
    if (await sendMessage(config, message, fetchImpl)) sent += 1;
  }
  logEvent("telegram_notified", {
    roundId: input.roundId,
    trigger: input.trigger,
    status: input.status,
    newDeals: eligible.length,
    skipped: input.newDeals.length - eligible.length,
    messages: messages.length,
    sent,
  });
}
