import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOURCE_DEFS } from "../src/lib/source-defs";
import {
  assertSameOrigin,
  assertSmallBody,
  clientIp,
  consumeManualAttempt,
  resetGuards,
  GuardError,
} from "../src/lib/guard";
import { REFRESH_INTERVAL_MS } from "../src/lib/config";

describe("guards and source URLs", () => {
  it("uses the required source URLs", () => {
    const byId = Object.fromEntries(SOURCE_DEFS.map((source) => [source.id, source.url]));
    assert.equal(byId.linuxdo, "https://r.jina.ai/https://linux.do/c/welfare/36.rss");
    assert.equal(byId.v2ex, "https://www.v2ex.com/feed/promotions.xml");
    assert.equal(byId.iplaysoft, "https://www.iplaysoft.com/feed");
    assert.equal(SOURCE_DEFS.length, 6);
    assert.equal(
      SOURCE_DEFS.some((source) => source.url.endsWith("/feed/promotion.xml")),
      false,
    );
    assert.equal(REFRESH_INTERVAL_MS, 2 * 60 * 60 * 1000);
  });

  it("limits manual attempts and rejects cross-site refresh", () => {
    resetGuards();
    for (let i = 0; i < 8; i += 1) assert.equal(consumeManualAttempt("10.0.0.8", 1_000 + i), true);
    assert.equal(consumeManualAttempt("10.0.0.8", 2_000), false);
    assert.equal(consumeManualAttempt("10.0.0.9", 2_000), true);

    const headers = new Headers({ origin: "https://evil.example", host: "deals.example" });
    assert.throws(() => assertSameOrigin(headers), GuardError);
    assert.doesNotThrow(() => assertSameOrigin(new Headers({ host: "deals.example" })));
    assert.throws(
      () => assertSmallBody(new Headers({ "content-length": "99999" })),
      GuardError,
    );
  });

  it("reads forwarded headers only when the proxy is explicitly trusted", () => {
    const previous = process.env.TRUST_PROXY_HEADERS;
    delete process.env.TRUST_PROXY_HEADERS;
    try {
      const spoofed = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
      assert.equal(clientIp(spoofed, { trustProxy: true }), "203.0.113.9");
      assert.equal(
        clientIp(new Headers({ "x-real-ip": "203.0.113.10" }), { trustProxy: true }),
        "203.0.113.10",
      );
    } finally {
      if (previous === undefined) delete process.env.TRUST_PROXY_HEADERS;
      else process.env.TRUST_PROXY_HEADERS = previous;
    }
  });

  it("ignores spoofed forwarded headers by default", () => {
    const previous = process.env.TRUST_PROXY_HEADERS;
    delete process.env.TRUST_PROXY_HEADERS;
    try {
      assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" })), "local");
      assert.equal(clientIp(new Headers({ "x-real-ip": "203.0.113.10" })), "local");
    } finally {
      if (previous === undefined) delete process.env.TRUST_PROXY_HEADERS;
      else process.env.TRUST_PROXY_HEADERS = previous;
    }
  });

  it("honours TRUST_PROXY_HEADERS=1 without an explicit option", () => {
    const previous = process.env.TRUST_PROXY_HEADERS;
    process.env.TRUST_PROXY_HEADERS = "1";
    try {
      assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
      assert.equal(clientIp(new Headers({ "x-real-ip": "203.0.113.10" })), "203.0.113.10");
    } finally {
      if (previous === undefined) delete process.env.TRUST_PROXY_HEADERS;
      else process.env.TRUST_PROXY_HEADERS = previous;
    }
  });

  it("rejects a cross-site fetch even without an Origin", () => {
    assert.throws(
      () => assertSameOrigin(new Headers({ host: "deals.example", "sec-fetch-site": "cross-site" })),
      (error: unknown) => error instanceof GuardError && error.status === 403 && error.message === "拒绝跨站刷新",
    );
    // curl 排障命令不带 Origin 也不带 Sec-Fetch-Site，必须继续放行。
    assert.doesNotThrow(() => assertSameOrigin(new Headers({ host: "deals.example" })));
  });
});
