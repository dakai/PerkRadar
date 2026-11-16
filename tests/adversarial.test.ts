import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FUTURE_PUBLISH_TOLERANCE_MS,
  MANUAL_IP_LIMIT,
  MAX_FEED_ITEMS,
  MAX_RESPONSE_CHARS,
} from "../src/lib/config";
import {
  GuardError,
  assertSameOrigin,
  clientIp,
  consumeManualAttempt,
  resetGuards,
} from "../src/lib/guard";
import { fetchText, type FetchLike } from "../src/lib/http";
import { classifyFailure } from "../src/lib/log";
import { parseEpicFreeGames } from "../src/lib/parse/epic";
import { parseFeed } from "../src/lib/parse/feed";
import { SOURCE_DEFS } from "../src/lib/source-defs";
import { loadSource } from "../src/lib/sources";
import { getBoardState } from "../src/lib/board";
import { insertDeal } from "../src/lib/db";
import { toPlain } from "../src/lib/text";
import { canonicalUrl } from "../src/lib/url";
import { atomFeed, responseFor, rssFeed, useMemoryDb } from "./helpers";

const NOW = Date.parse("2026-11-08T00:00:00.000Z");
const RECENT = "Sat, 07 Nov 2026 00:00:00 +0000";

/** Feed content is untrusted input. These cases pin what must never reach the board. */
describe("adversarial input", () => {
  it("strips script/style markup and HTML attributes from titles and summaries", () => {
    const xml = [
      '<?xml version="1.0"?><rss version="2.0"><channel><title>feed</title><item>',
      "<title><![CDATA[<script>alert(1)</script>免费领取]]></title>",
      "<link>https://www.v2ex.com/t/1</link>",
      `<pubDate>${RECENT}</pubDate>`,
      '<description><![CDATA[<img src=x onerror="fetch(\'//evil\')"> 正文 &amp; <b>加粗</b>]]></description>',
      "</item></channel></rss>",
    ].join("");
    const [item] = parseFeed(xml, NOW);
    assert.ok(item);
    assert.equal(item.title.includes("<"), false);
    assert.equal(item.title.includes(">"), false);
    assert.equal(item.summary.includes("<"), false);
    assert.equal(item.summary.includes(">"), false);
    assert.equal(item.summary.includes("正文"), true);
    assert.equal(item.title.includes("免费领取"), true);
  });

  it("rejects javascript:, data:, credential-bearing and overlong URLs", () => {
    const hostile = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://user:pass@www.v2ex.com/t/1",
      `https://www.v2ex.com/${"a".repeat(2100)}`,
      "ftp://www.v2ex.com/t/1",
    ];
    for (const raw of hostile) {
      assert.throws(() => canonicalUrl(raw), /无效链接/, raw.slice(0, 40));
    }
    assert.equal(canonicalUrl("https://www.v2ex.com/t/1#reply0"), "https://www.v2ex.com/t/1");
  });

  it("drops item links that point off the source's own domain", async () => {
    const source = SOURCE_DEFS.find((entry) => entry.id === "v2ex")!;
    const feed = rssFeed([
      { title: "phishing link", link: "https://evil.example/steal", pubDate: RECENT },
      { title: "legit", link: "https://www.v2ex.com/t/2", pubDate: RECENT },
    ]);
    const fetchImpl: FetchLike = async () => responseFor(feed, source.url);
    const loaded = await loadSource(source, { fetchImpl, signal: new AbortController().signal, now: NOW });
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0]?.url, "https://www.v2ex.com/t/2");
  });

  it("still accepts a first-party subdomain", async () => {
    const source = SOURCE_DEFS.find((entry) => entry.id === "v2ex")!;
    const feed = atomFeed([
      { title: "subdomain", link: "https://go.v2ex.com/t/3", published: "2026-11-07T00:00:00Z" },
    ]);
    const fetchImpl: FetchLike = async () => responseFor(feed, source.url);
    const loaded = await loadSource(source, { fetchImpl, signal: new AbortController().signal, now: NOW });
    assert.equal(loaded.items.length, 1);
  });

  it("rejects a huge Content-Length before opening a reader", async () => {
    let readerCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(100)));
        controller.close();
      },
    });
    const originalGetReader = body.getReader.bind(body);
    // A stream prefetches one chunk on construction, so counting pull() gives a
    // false positive. Count reader creation: the length check must happen first.
    Object.defineProperty(body, "getReader", {
      value: () => {
        readerCalls += 1;
        return originalGetReader();
      },
    });
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      url: "https://www.v2ex.com/feed/promotions.xml",
      text: async () => "",
      body,
      headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? String(MAX_RESPONSE_CHARS + 1) : null) },
    });
    await assert.rejects(
      () => fetchText("https://www.v2ex.com/feed/promotions.xml", { fetchImpl, signal: new AbortController().signal }),
      /响应过大/,
    );
    assert.equal(readerCalls, 0);
  });

  it("stops a streaming response as soon as the character cap is crossed", async () => {
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        if (chunks > 30) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode("x".repeat(100_000)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      url: "https://www.v2ex.com/feed/promotions.xml",
      text: async () => "",
      body,
    });
    await assert.rejects(
      () => fetchText("https://www.v2ex.com/feed/promotions.xml", { fetchImpl, signal: new AbortController().signal }),
      /响应过大/,
    );
    assert.equal(cancelled, true);
    assert.ok(chunks < 30, `expected early abort, read ${chunks} chunks`);
  });

  it("caps the response even for engines without a readable stream", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      url: "https://www.v2ex.com/feed/promotions.xml",
      text: async () => "x".repeat(MAX_RESPONSE_CHARS + 1),
    });
    await assert.rejects(
      () => fetchText("https://www.v2ex.com/feed/promotions.xml", { fetchImpl, signal: new AbortController().signal }),
      /响应过大/,
    );
  });

  it("returns HTTP failures before downloading an error body", async () => {
    let textCalled = false;
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 503,
      url: "https://www.v2ex.com/feed/promotions.xml",
      text: async () => {
        textCalled = true;
        return "x".repeat(2_000_000);
      },
    });
    await assert.rejects(
      () => fetchText("https://www.v2ex.com/feed/promotions.xml", { fetchImpl, signal: new AbortController().signal }),
      /HTTP 503/,
    );
    assert.equal(textCalled, false);
  });

  it("refuses future and implausible publish dates instead of pinning them to the top", () => {
    const feed = rssFeed([
      { title: "future", link: "https://www.v2ex.com/t/10", pubDate: "Fri, 01 Jan 2099 00:00:00 +0000" },
      { title: "ancient", link: "https://www.v2ex.com/t/11", pubDate: "Mon, 01 Jan 1990 00:00:00 +0000" },
      { title: "ok", link: "https://www.v2ex.com/t/12", pubDate: RECENT },
    ]);
    const items = parseFeed(feed, NOW);
    assert.equal(items.length, 3);
    assert.equal(items.find((item) => item.title === "future")?.publishedAt, null);
    assert.equal(items.find((item) => item.title === "ancient")?.publishedAt, null);
    assert.equal(items.find((item) => item.title === "ok")?.publishedAt, Date.parse(RECENT));
  });

  it("tolerates a clock-skewed date inside the allowed window", () => {
    const skew = new Date(NOW + FUTURE_PUBLISH_TOLERANCE_MS - 60_000).toUTCString();
    const feed = rssFeed([{ title: "skew", link: "https://www.v2ex.com/t/13", pubDate: skew }]);
    assert.notEqual(parseFeed(feed, NOW)[0]?.publishedAt, null);
  });

  it("caps the number of entries parsed from one feed", () => {
    const feed = rssFeed(
      Array.from({ length: MAX_FEED_ITEMS + 150 }, (_, index) => ({
        title: `entry ${index}`,
        link: `https://www.v2ex.com/t/${index + 100}`,
        pubDate: RECENT,
      })),
    );
    assert.equal(parseFeed(feed, NOW).length, MAX_FEED_ITEMS);
  });

  it("removes ANSI sequences, bare SGR remnants, control bytes and ASCII-art separators", () => {
    const plain = toPlain("第二台💻基本信息[1m++++++++++++++++++++++++++++++++[0m\x1b[31m硬\x07件");
    assert.equal(plain.includes("[1m"), false);
    assert.equal(plain.includes("[0m"), false);
    assert.equal(plain.includes("++++"), false);
    assert.equal(plain.includes("\x1b"), false);
    assert.equal(plain.includes("\x07"), false);
    assert.equal(plain.includes("硬"), true);
    assert.equal(plain.includes("件"), true);
  });

  it("removes bare CSI fragments without mangling ordinary bracketed text", () => {
    const plain = toPlain("💻基本信息[H[J[3J++++++++++++++++[1m硬件[36m152.1");
    assert.equal(plain.includes("[H"), false);
    assert.equal(plain.includes("[3J"), false);
    assert.equal(plain.includes("[36m"), false);
    assert.equal(plain.includes("++++"), false);
    assert.ok(plain.includes("硬件"));
    assert.equal(toPlain("推荐 [3D] 打印笔"), "推荐 [3D] 打印笔");
  });

  it("re-cleans historical rows on read without rewriting the database", () => {
    useMemoryDb();
    insertDeal({
      canonicalUrl: "https://www.v2ex.com/post-ansi",
      url: "https://www.v2ex.com/post-ansi",
      title: "[1m旧标题",
      summary: "[H[J[3J++++++++++++++++[36m旧摘要",
      category: "其他",
      sourceId: "v2ex",
      publishedAt: NOW - 60_000,
      expiresAt: null,
      firstSeenAt: NOW,
      firstSeenRoundId: 1,
      updatedAt: NOW,
    });
    const deal = getBoardState(NOW).deals[0];
    assert.equal(deal?.title, "旧标题");
    assert.ok(deal?.summary.includes("旧摘要"));
    assert.equal(deal?.summary.includes("+++"), false);
    assert.equal(deal?.summary.includes("[3J"), false);
  });

  it("fails closed on HTML challenge pages and malformed XML", () => {
    assert.throws(
      () => parseFeed("<!DOCTYPE html><html><body>Just a moment...</body></html>", NOW),
      /网页而不是订阅源/,
    );
    assert.deepEqual(parseFeed("<rss><channel><item>", NOW), []);
  });

  it("treats an empty Epic catalog as a broken upstream response", () => {
    assert.throws(
      () => parseEpicFreeGames({ data: { Catalog: { searchStore: { elements: [] } } } }, NOW),
      /商品列表为空/,
    );
    assert.throws(
      () => parseEpicFreeGames({ data: { Catalog: { searchStore: {} } } }, NOW),
      /缺少商品列表/,
    );
  });

  it("classifies failure reasons for operator triage", () => {
    assert.equal(classifyFailure("超时"), "timeout");
    assert.equal(classifyFailure("HTTP 503"), "http_status");
    assert.equal(classifyFailure("响应过大"), "response_too_large");
    assert.equal(classifyFailure("Epic 响应不是 JSON"), "malformed_response");
    assert.equal(classifyFailure("Epic 商品列表为空"), "malformed_response");
    assert.equal(classifyFailure("未能解析 RSS/Atom"), "malformed_response");
    assert.equal(classifyFailure("unrecognised"), "unknown");
  });
});

describe("adversarial refresh guards", () => {
  it("ignores client-forged forwarded IPs unless a trusted proxy is declared", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.10" });
    assert.equal(clientIp(headers), "local");
    assert.equal(clientIp(headers, { trustProxy: true }), "203.0.113.9");
  });

  it("cannot bypass the per-IP budget by rotating a forged header", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    resetGuards();
    for (let index = 0; index < MANUAL_IP_LIMIT; index += 1) {
      const ip = clientIp(new Headers({ "x-forwarded-for": `10.0.0.${index}` }));
      assert.equal(consumeManualAttempt(ip, NOW), true);
    }
    const bypass = clientIp(new Headers({ "x-forwarded-for": "10.99.99.99" }));
    assert.equal(consumeManualAttempt(bypass, NOW), false);
  });

  it("blocks cross-site refresh while keeping the documented curl command usable", () => {
    assert.throws(
      () => assertSameOrigin(new Headers({ "sec-fetch-site": "cross-site" })),
      (error: unknown) => error instanceof GuardError && error.status === 403,
    );
    assert.doesNotThrow(() => assertSameOrigin(new Headers()));
    assert.doesNotThrow(() => assertSameOrigin(new Headers({ "sec-fetch-site": "same-origin" })));
    assert.throws(
      () => assertSameOrigin(new Headers({ origin: "https://evil.example", host: "127.0.0.1:38471" })),
      /拒绝跨站刷新/,
    );
    assert.equal(
      (() => {
        try {
          assertSameOrigin(new Headers({ "content-length": "9999" }));
          return "allowed";
        } catch {
          return "blocked";
        }
      })(),
      "allowed",
    );
  });
});
