import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classify, classifySignals } from "../src/lib/classify";
import { parseEpicFreeGames } from "../src/lib/parse/epic";
import { parseLinuxDoMarkdown } from "../src/lib/parse/linuxdo";
import { publishTime } from "../src/lib/publish-time";
import { boardPage } from "../src/lib/board-page";
import { normalizeBoardState } from "../src/lib/board-view";
import { getBoardState } from "../src/lib/board";
import { expireBoard } from "../src/lib/board-client";
import { openDatabase, useDatabase, getDb, acquireLease, renewLease, releaseLease, insertRound, finishRound, insertSourceRun, pruneHistory, listSourceRuns } from "../src/lib/db";
import { HttpError, retryAfter } from "../src/lib/http";
import { resilientSource, resetCircuitsForTests } from "../src/lib/source-resilience";
import { middleware } from "../src/middleware";
import { NextRequest } from "next/server";
import { uiAuthorized } from "../src/lib/auth-edge";
import { authorized, createSession, validSession } from "../src/lib/auth";
import { loadPersonal, loadShowAll, STORAGE_KEY, SHOW_ALL_KEY, LEGACY_STORAGE_KEY, LEGACY_SHOW_ALL_KEY } from "../src/lib/personal-storage";
import { probeExitCode } from "../src/lib/probe-outcome";
import { snapshotDirectory } from "../src/lib/snapshot";
import { resetGuards } from "../src/lib/guard";
import { POST as sessionPost, DELETE as sessionDelete } from "../src/app/api/session/route";
import { useMemoryDb } from "./helpers";

const NOW = Date.parse("2026-11-11T00:00:00Z");
const catalog = (elements: unknown[]) => ({ data: { Catalog: { searchStore: { elements } } } });
const paid = { title: "SYNTHETIC paid", price: { totalPrice: { discountPrice: 9 } }, promotions: { promotionalOffers: [] } };

describe("audit regressions", { concurrency: false }, () => {
  it("scores deal signals without Pro/punctuation/update vetoes", () => {
    assert.equal(classify("iPhone 17 Pro 降价", "v2ex"), "低价优惠");
    assert.equal(classify("XX 限免更新", "appinn"), "限免");
    assert.equal(classify("限免领取？", "v2ex"), "限免");
    assert.equal(classify("ChatGPT Pro 套餐", "v2ex"), "会员订阅");
    assert.equal(classifySignals("XX 限免更新", "v2ex").confidence, "high");
  });
  it("recognises common offer wording and keeps second-hand trades and questions out", () => {
    assert.equal(classify("SYNTHETIC 域名双十一优惠，COM 限时不限量", "v2ex"), "低价优惠");
    assert.equal(classify("SYNTHETIC 年付 6 折优惠券", "v2ex"), "低价优惠");
    assert.equal(classify("SYNTHETIC 中转站 新用户注册送 5 元体验额度", "linuxdo"), "免费白嫖");
    assert.equal(classify("SYNTHETIC 话费羊毛 冲50返120", "linuxdo"), "免费白嫖");
    assert.equal(classify("SYNTHETIC 口令红包", "linuxdo"), "免费白嫖");
    for (const title of ["70 出 SYNTHETIC 6 折券", "+40收 SYNTHETIC 7.5折优惠券", "【出】SYNTHETIC 免费号", "清机出 SYNTHETIC 5 折", "总价80出 SYNTHETIC 5折 小杯", "SYNTHETIC 20x 拼车 80元一位 优惠"]) {
      assert.equal(classify(title, "v2ex"), "其他", title);
      assert.equal(classifySignals(title, "v2ex").contentType, "discussion", title);
    }
    for (const title of ["SYNTHETIC 要上特价是真的吗？", "请问哪里有免费的 SYNTHETIC API", "SYNTHETIC 首月免费试用吗？", "SYNTHETIC 为什么突然免费升级"]) {
      assert.equal(classify(title, "v2ex"), "其他", title);
    }
    // 出/收 inside ordinary words must not be read as a trade marker.
    assert.equal(classify("SYNTHETIC 推出 5 折优惠", "appinn"), "低价优惠");
    assert.equal(classify("SYNTHETIC 收到 100 元红包", "linuxdo"), "免费白嫖");
  });
  it("caps an absurd upstream Retry-After", () => {
    assert.equal(retryAfter("999999999", NOW), 6 * 3_600_000);
    assert.equal(retryAfter(new Date(NOW + 30 * 86_400_000).toUTCString(), NOW), 6 * 3_600_000);
    assert.equal(retryAfter("not-a-date", NOW), 0);
  });
  it("sends a browser back to the login page on failure and clears the cookie on sign-out", async () => {
    const previous = process.env.PERKRADAR_ACCESS_TOKEN;
    const token = "synthetic-test-token-0123456789abcdef";
    const form = (value: string, accept: string) => new Request("https://perks.example.com/api/session", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://perks.example.com", host: "perks.example.com", accept },
      body: new URLSearchParams({ token: value }),
    });
    try {
      process.env.PERKRADAR_ACCESS_TOKEN = token;
      resetGuards();
      const html = await sessionPost(form("wrong", "text/html,application/xhtml+xml"));
      assert.equal(html.status, 303);
      assert.equal(html.headers.get("location"), "/login?error=invalid");
      assert.equal(html.headers.get("set-cookie"), null);
      const json = await sessionPost(form("wrong", "application/json"));
      assert.equal(json.status, 401);
      const ok = await sessionPost(form(token, "text/html"));
      assert.equal(ok.status, 303);
      assert.equal(ok.headers.get("location"), "/");
      assert.match(ok.headers.get("set-cookie") ?? "", /perkradar-session=.+HttpOnly/i);
      const out = sessionDelete(new Request("https://perks.example.com/api/session", { method: "DELETE", headers: { origin: "https://perks.example.com", host: "perks.example.com" } }));
      assert.equal(out.status, 204);
      assert.match(out.headers.get("set-cookie") ?? "", /perkradar-session=;.*Max-Age=0/i);
      const crossSite = sessionDelete(new Request("https://perks.example.com/api/session", { method: "DELETE", headers: { "sec-fetch-site": "cross-site" } }));
      assert.equal(crossSite.status, 403);
    } finally {
      resetGuards();
      if (previous === undefined) delete process.env.PERKRADAR_ACCESS_TOKEN; else process.env.PERKRADAR_ACCESS_TOKEN = previous;
    }
  });
  it("fails closed on complete and partial Epic schema drift", () => {
    for (const elements of [[{}], [{ ...paid, price: { totalPrice: { newDiscountPrice: 0 } } }], [{ ...paid, price: { totalPrice: { discountPrice: "0" } } }], [paid, {}], [{ ...paid, promotions: { promotionalOffers: "changed" } }]]) {
      assert.throws(() => parseEpicFreeGames(catalog(elements), NOW), /结构异常/);
    }
    assert.throws(() => parseEpicFreeGames(catalog([]), NOW), /为空/);
    assert.deepEqual(parseEpicFreeGames(catalog([paid]), NOW), []);
  });
  it("applies the shared date boundary to Markdown, including alternate headings", () => {
    const sample = fs.readFileSync(new URL("./fixtures/linuxdo-synthetic-variants.md", import.meta.url), "utf8");
    const items = parseLinuxDoMarkdown(sample, NOW);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.publishedAt, Date.parse("Sun, 08 Nov 2026 05:36:12 +0000"));
    assert.equal(items[1]?.publishedAt, null);
    assert.equal(publishTime("2099-01-01", NOW), null);
    assert.equal(publishTime("1990-01-01", NOW), null);
  });
  it("preserves >2000 deals and reports bounded API pagination", () => {
    useMemoryDb();
    const board = getBoardState(NOW);
    const deal = { id: 1, url: "https://www.v2ex.com/t/1", canonicalUrl: "https://www.v2ex.com/t/1", title: "SYNTHETIC", summary: "", category: "其他" as const, sourceId: "v2ex", sourceName: "V2EX", publishedAt: null, publishedLabel: null, expiresAt: null, expiresLabel: null, expiresSoon: false, isNew: false };
    board.deals = Array.from({ length: 2001 }, (_, index) => ({ ...deal, id: index, canonicalUrl: `https://www.v2ex.com/t/${index}` }));
    assert.equal(normalizeBoardState(board)?.deals.length, 2001);
    const page = boardPage(board, new URLSearchParams("offset=2000&limit=500"));
    assert.equal(page.deals.length, 1);
    assert.equal(page.pagination?.total, 2001);
    assert.equal(page.pagination?.hasMore, false);
    assert.equal(boardPage(board, new URLSearchParams("limit=500")).pagination?.hasMore, true);
    for (const query of ["limit=999999", "offset=-1", "offset=1.5", "limit=NaN"]) assert.throws(() => boardPage(board, new URLSearchParams(query)));
    const expired = expireBoard({ ...board, deals: [{ ...deal, expiresAt: NOW }] }, NOW);
    assert.equal(expired.activeCount, 0);
  });
  it("accepts bearer or signed expiring HttpOnly-session values, not forged cookies", () => {
    const token = "synthetic-test-token-not-a-secret-123456789";
    const cookie = createSession(token, NOW);
    assert.equal(authorized(new Headers(), null, NOW), true);
    assert.equal(authorized(new Headers(), token, NOW), false);
    assert.equal(authorized(new Headers({ authorization: `Bearer ${token}` }), token, NOW), true);
    assert.equal(authorized(new Headers({ cookie: `perkradar-session=${cookie}` }), token, NOW), true);
    assert.equal(validSession(cookie + "x", token, NOW), false);
    assert.equal(validSession(cookie, token, NOW + 8 * 3_600_000), false);
    assert.equal(validSession(cookie, "other", NOW), false);
  });
  it("checks the same signed session in the pre-streaming WebCrypto UI gate", async () => {
    const token = "synthetic-test-token-not-a-secret-123456789";
    const cookie = createSession(token, NOW);
    assert.equal(await uiAuthorized(new Headers(), token, NOW), false);
    assert.equal(await uiAuthorized(new Headers({ authorization: `Bearer ${token}` }), token, NOW), true);
    assert.equal(await uiAuthorized(new Headers({ cookie: `perkradar-session=${cookie}` }), token, NOW), true);
    assert.equal(await uiAuthorized(new Headers({ cookie: `perkradar-session=${cookie}x` }), token, NOW), false);
    assert.equal(await uiAuthorized(new Headers({ cookie: `perkradar-session=${cookie}` }), token, NOW + 8 * 3_600_000), false);
  });
  it("redirects unauthenticated UI before streaming with an absolute middleware URL", async () => {
    const previous = process.env.PERKRADAR_ACCESS_TOKEN;
    const token = "synthetic-test-token-not-a-secret-123456789";
    try {
      process.env.PERKRADAR_ACCESS_TOKEN = token;
      const denied = await middleware(new NextRequest("https://perks.example.com/"));
      assert.equal(denied.status, 307);
      assert.equal(denied.headers.get("location"), "https://perks.example.com/login");
      const accepted = await middleware(new NextRequest("https://perks.example.com/", { headers: { authorization: `Bearer ${token}` } }));
      assert.equal(accepted.status, 200);
      // Behind a reverse proxy request.url is the listen address; the visitor's Host must win.
      const proxied = await middleware(new NextRequest("http://localhost:38471/", { headers: { host: "perks.example.com", "x-forwarded-proto": "https" } }));
      assert.equal(proxied.headers.get("location"), "https://perks.example.com/login");
      const local = await middleware(new NextRequest("http://localhost:38471/", { headers: { host: "127.0.0.1:38481" } }));
      assert.equal(local.headers.get("location"), "http://127.0.0.1:38481/login");
      const hostile = await middleware(new NextRequest("http://localhost:38471/", { headers: { host: "evil.example/x?y" } }));
      assert.equal(hostile.headers.get("location"), "http://localhost:38471/login");
    } finally { if (previous === undefined) delete process.env.PERKRADAR_ACCESS_TOKEN; else process.env.PERKRADAR_ACCESS_TOKEN = previous; }
  });
  it("migrates old browser keys without deleting fallback, tolerating quota failures", () => {
    const values = new Map([[LEGACY_STORAGE_KEY, JSON.stringify({ favorites: ["https://example.com"], claimed: [] })], [LEGACY_SHOW_ALL_KEY, "0"]]);
    const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    assert.equal(loadPersonal(store).favorites.length, 1);
    assert.ok(values.has(STORAGE_KEY)); assert.ok(values.has(LEGACY_STORAGE_KEY));
    assert.equal(loadShowAll(store), false); assert.equal(values.get(SHOW_ALL_KEY), "0");
    const fallback = { favorites: ["in-memory"], claimed: [] };
    assert.deepEqual(loadPersonal({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } }, fallback), fallback);
    assert.equal(loadShowAll({ getItem: () => null, setItem() {} }), true);
  });
  it("honors Retry-After and bounds exponential retries without network", async () => {
    resetCircuitsForTests(); let calls = 0; const waits: number[] = [];
    const value = await resilientSource("synthetic", async () => { if (++calls < 3) throw new HttpError(429, 700); return "ok"; }, new AbortController().signal, { now: () => NOW, wait: async (ms) => { waits.push(ms); } });
    assert.equal(value, "ok"); assert.deepEqual(waits, [700, 1000]);
    assert.equal(retryAfter("2", NOW), 2000);
    assert.equal(retryAfter(new Date(NOW + 3000).toUTCString(), NOW), 3000);
    let blockedCalls = 0;
    await assert.rejects(() => resilientSource("blocked", async () => { blockedCalls++; throw new HttpError(429, 60_000); }, new AbortController().signal, { now: () => NOW }), /429/);
    await assert.rejects(() => resilientSource("blocked", async () => { blockedCalls++; return "bad"; }, new AbortController().signal, { now: () => NOW }), /circuit_open/);
    assert.equal(blockedCalls, 1);
    resetCircuitsForTests();
  });
  it("migrates idempotently, retains latest history, and fences lease ownership", () => {
    useMemoryDb();
    assert.equal(getDb().prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(acquireLease("test", "a", NOW, 100), true);
    assert.equal(acquireLease("test", "b", NOW + 1, 100), false);
    assert.equal(acquireLease("test", "b", NOW + 100, 100), true);
    assert.equal(renewLease("test", "a", NOW + 100, 100), false);
    releaseLease("test", "a");
    assert.equal(acquireLease("test", "c", NOW + 101, 100), false);
    const old = insertRound("schedule", NOW - 1000); finishRound(old, NOW - 900, "success");
    insertSourceRun({ roundId: old, sourceId: "v2ex", ok: true, fetchedCount: 1, insertedCount: 1, error: null, finalUrl: null, startedAt: NOW - 1000, finishedAt: NOW - 900 });
    const latest = insertRound("schedule", NOW - 800); finishRound(latest, NOW - 700, "success");
    pruneHistory(NOW);
    assert.equal(listSourceRuns(old).length, 0);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM rounds").get()?.n, 1);
  });
  it("serializes leases across actual independent Node processes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perkradar-lease-test-"));
    try {
      useDatabase(openDatabase(path.join(dir, "deals.db")));
      assert.equal(acquireLease("scheduler", "parent", Date.now(), 60_000), true);
      const script = `const d=require('./src/lib/db.ts'); console.log(d.acquireLease('scheduler','child',Date.now(),60000)); d.useDatabase(null);`;
      const output = execFileSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dir }, encoding: "utf8" });
      assert.equal(output.trim(), "false");
    } finally { useDatabase(null); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("makes probe failures actionable and snapshots opt-in", () => {
    useMemoryDb(); const board = getBoardState(NOW);
    assert.equal(probeExitCode(board), 1);
    assert.equal(probeExitCode({ ...board, sourceHealth: { ok: 1, total: 7 } }), 0);
    assert.equal(probeExitCode({ ...board, sourceHealth: { ok: 1, total: 7 }, sources: [{ ...board.sources[0]!, diagnostic: "structure_anomaly" }] }), 1);
    const previous = process.env.DEALS_SNAPSHOT_DIR;
    try { delete process.env.DEALS_SNAPSHOT_DIR; assert.equal(snapshotDirectory(), null); }
    finally { if (previous === undefined) delete process.env.DEALS_SNAPSHOT_DIR; else process.env.DEALS_SNAPSHOT_DIR = previous; }
  });
});
