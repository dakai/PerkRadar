import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DealRow } from "../src/lib/db";
import type { FetchLike } from "../src/lib/http";
import {
  TELEGRAM_MESSAGE_MAX,
  TELEGRAM_TIMEOUT_MS,
} from "../src/lib/config";
import {
  escapeHtml,
  formatNewDealMessages,
  formatRoundFailure,
  notifyRound,
  readTelegramConfig,
  type RoundNotification,
  type TelegramConfig,
} from "../src/lib/telegram";

const NOW = Date.parse("2026-11-11T06:30:00.000Z");

function deal(id: number, overrides: Partial<DealRow> = {}): DealRow {
  return {
    id,
    canonicalUrl: `https://example.com/${id}`,
    url: `https://example.com/${id}`,
    title: `SYNTHETIC 优惠 ${id}`,
    summary: "",
    category: "免费白嫖",
    sourceId: "linuxdo",
    publishedAt: NOW,
    expiresAt: null,
    firstSeenAt: NOW,
    firstSeenRoundId: 1,
    updatedAt: NOW,
    ...overrides,
  };
}

function round(overrides: Partial<RoundNotification> = {}): RoundNotification {
  return {
    trigger: "schedule",
    roundId: 1,
    status: "success",
    now: NOW,
    newDeals: [deal(1)],
    failures: [],
    okSources: 7,
    totalSources: 7,
    ...overrides,
  };
}

function config(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    botToken: "123:secret",
    chatId: "-100200",
    messageThreadId: null,
    apiBase: "https://tg.example",
    timeoutMs: 1_000,
    maxDeals: 10,
    notifyFailures: true,
    ...overrides,
  };
}

type RecordedCall = { url: string; body: Record<string, unknown> };

function recordingFetch(calls: RecordedCall[], reply: { ok: boolean; status: number; text: string } = {
  ok: true,
  status: 200,
  text: '{"ok":true}',
}): FetchLike {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return { ...reply, url, text: async () => reply.text };
  };
}

describe("telegram configuration", () => {
  it("needs both the bot token and the chat id, and honours the disable switch", () => {
    assert.equal(readTelegramConfig({}), null);
    assert.equal(readTelegramConfig({ TELEGRAM_BOT_TOKEN: "123:secret" }), null);
    assert.equal(readTelegramConfig({ TELEGRAM_CHAT_ID: "-100200" }), null);
    assert.equal(readTelegramConfig({ TELEGRAM_BOT_TOKEN: " ", TELEGRAM_CHAT_ID: "-100200" }), null);
    assert.equal(
      readTelegramConfig({ TELEGRAM_BOT_TOKEN: "123:secret", TELEGRAM_CHAT_ID: "-100200", TELEGRAM_DISABLE: "1" }),
      null,
    );

    const parsed = readTelegramConfig({
      TELEGRAM_BOT_TOKEN: " 123:secret ",
      TELEGRAM_CHAT_ID: "-100200",
      TELEGRAM_MESSAGE_THREAD_ID: "7",
      TELEGRAM_API_BASE: "https://tg.example/",
      TELEGRAM_MAX_DEALS: "999",
      TELEGRAM_TIMEOUT_MS: "10",
    });
    assert.equal(parsed?.botToken, "123:secret");
    assert.equal(parsed?.chatId, "-100200");
    assert.equal(parsed?.messageThreadId, "7");
    assert.equal(parsed?.apiBase, "https://tg.example");
    assert.equal(parsed?.maxDeals, 50);
    assert.equal(parsed?.timeoutMs, 1_000);
    assert.equal(parsed?.notifyFailures, true);
  });

  it("uses the documented defaults", () => {
    const parsed = readTelegramConfig({ TELEGRAM_BOT_TOKEN: "123:secret", TELEGRAM_CHAT_ID: "-100200" });
    assert.equal(parsed?.apiBase, "https://api.telegram.org");
    assert.equal(parsed?.messageThreadId, null);
    assert.equal(parsed?.timeoutMs, TELEGRAM_TIMEOUT_MS);
    assert.equal(parsed?.maxDeals, 10);
    assert.equal(readTelegramConfig({
      TELEGRAM_BOT_TOKEN: "123:secret",
      TELEGRAM_CHAT_ID: "-100200",
      TELEGRAM_NOTIFY_FAILURES: "off",
    })?.notifyFailures, false);
  });
});

describe("telegram formatting", () => {
  it("escapes feed text and URLs instead of passing markup through", () => {
    const messages = formatNewDealMessages(
      round({
        newDeals: [
          deal(1, {
            title: "<b>折</b> & 免费",
            url: "https://example.com/a?x=1&y=2",
            category: "免费白嫖",
          }),
        ],
      }),
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /&lt;b&gt;折&lt;\/b&gt; &amp; 免费/);
    assert.match(messages[0]!, /x=1&amp;y=2/);
    assert.equal(messages[0]!.includes("<b>折"), false);
    assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
  });

  it("splits a long digest and summarizes the deals it did not list", () => {
    const deals = Array.from({ length: 25 }, (_, index) =>
      deal(index + 1, { title: "长标题".repeat(60) }),
    );
    const limited = formatNewDealMessages(round({ newDeals: deals }));
    assert.ok(limited.length >= 1);
    assert.ok(limited.every((message) => message.length <= TELEGRAM_MESSAGE_MAX));
    assert.match(limited[0]!, /新增 25 条优惠/);
    assert.match(limited[limited.length - 1]!, /另有 15 条/);

    const complete = formatNewDealMessages(round({ newDeals: deals }), 25);
    assert.ok(complete.length > 1);
    assert.ok(complete.every((message) => message.length <= TELEGRAM_MESSAGE_MAX));
  });

  it("lists per-source reasons in a failure alert", () => {
    const message = formatRoundFailure(
      round({
        status: "failed",
        newDeals: [],
        okSources: 0,
        failures: [
          { sourceId: "v2ex", error: "HTTP 503" },
          { sourceId: "linuxdo", error: "超时" },
        ],
      }),
    );
    assert.match(message, /可用来源 0\/7/);
    assert.match(message, /V2EX推广：HTTP 503/);
    assert.match(message, /LINUX DO福利羊毛：超时/);
  });
});

describe("telegram delivery", () => {
  it("posts one HTML message with the thread id and never throws on rejection", async () => {
    const calls: RecordedCall[] = [];
    await notifyRound(round(), config({ messageThreadId: "7" }), recordingFetch(calls));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://tg.example/bot123:secret/sendMessage");
    assert.equal(calls[0]!.body.chat_id, "-100200");
    assert.equal(calls[0]!.body.parse_mode, "HTML");
    assert.equal(calls[0]!.body.message_thread_id, 7);
    assert.equal(calls[0]!.body.disable_web_page_preview, true);

    const rejected = recordingFetch([], {
      ok: false,
      status: 400,
      text: '{"ok":false,"description":"Bad Request: chat not found"}',
    });
    await notifyRound(round(), config(), rejected);
  });

  it("stays silent for a quiet round and for a missing configuration", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = recordingFetch(calls);
    await notifyRound(round({ newDeals: [] }), null, fetchImpl);
    await notifyRound(round({ newDeals: [] }), config(), fetchImpl);
    assert.equal(calls.length, 0);
  });

  it("sends a failure alert only when failure notices are enabled", async () => {
    const input = round({
      status: "failed",
      newDeals: [],
      okSources: 0,
      failures: [{ sourceId: "v2ex", error: "HTTP 503" }],
    });
    const calls: RecordedCall[] = [];
    await notifyRound(input, config({ notifyFailures: false }), recordingFetch(calls));
    assert.equal(calls.length, 0);

    await notifyRound(input, config({ notifyFailures: true }), recordingFetch(calls));
    assert.equal(calls.length, 1);
    assert.match(String(calls[0]!.body.text), /本轮刷新失败/);
    assert.match(String(calls[0]!.body.text), /V2EX推广：HTTP 503/);
  });

  it("sends every chunk of a large digest", async () => {
    const deals = Array.from({ length: 25 }, (_, index) =>
      deal(index + 1, { title: "长标题".repeat(60) }),
    );
    const calls: RecordedCall[] = [];
    await notifyRound(round({ newDeals: deals }), config({ maxDeals: 25 }), recordingFetch(calls));
    assert.ok(calls.length > 1);
    assert.ok(calls.every((call) => String(call.body.text).length <= TELEGRAM_MESSAGE_MAX));
  });
});
