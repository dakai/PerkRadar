import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listDeals } from "../src/lib/db";
import { RefreshRejected, runRefresh } from "../src/lib/refresh";
import type { FetchLike } from "../src/lib/http";
import type { RoundNotification } from "../src/lib/telegram";
import { atomFeed, EMPTY_RSS, linuxdoItem, responseFor, rssFeed, useMemoryDb } from "./helpers";

const NOW = Date.parse("2026-11-08T00:00:00.000Z");
const RECENT = "Sun, 07 Nov 2026 00:00:00 +0000";
const OLD = "Sun, 31 Oct 2026 23:59:59 +0000";
const EXACT = "Sun, 01 Nov 2026 00:00:00 +0000";

function epicPayload(titles: { title: string; slug: string; end: string }[]) {
  return JSON.stringify({
    data: {
      Catalog: {
        searchStore: {
          elements: titles.map((game) => ({
            title: game.title,
            description: "SYNTHETIC epic description",
            productSlug: game.slug,
            price: { totalPrice: { discountPrice: 0 } },
            promotions: {
              promotionalOffers: [
                {
                  promotionalOffers: [
                    {
                      startDate: "2026-11-05T00:00:00.000Z",
                      endDate: game.end,
                      discountSetting: { discountPercentage: 0 },
                    },
                  ],
                },
              ],
            },
          })),
        },
      },
    },
  });
}

/** A healthy catalog with no current free promotion: the normal "game left" case. */
function epicPayloadWithoutFreePromotions(): string {
  return JSON.stringify({
    data: {
      Catalog: {
        searchStore: {
          elements: [
            {
              title: "SYNTHETIC paid game",
              productSlug: "synthetic-paid",
              price: { totalPrice: { discountPrice: 999 } },
              promotions: { promotionalOffers: [] },
            },
          ],
        },
      },
    },
  });
}

function bodies(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    linuxdo: [
      linuxdoItem("SYNTHETIC 免费领取测试", 101, RECENT),
      linuxdoItem("SYNTHETIC 过期七天", 102, OLD),
      linuxdoItem("SYNTHETIC 正好七天", 103, EXACT),
    ].join("\n"),
    v2ex: atomFeed([
      {
        title: "SYNTHETIC 优惠码",
        link: "https://www.v2ex.com/t/10#reply0",
        published: "2026-11-07T00:00:00Z",
      },
      {
        title: "SYNTHETIC 优惠码重复链接",
        link: "https://www.v2ex.com/t/10?utm_source=feed#reply9",
        published: "2026-11-07T00:00:00Z",
      },
    ]),
    epic: epicPayload([
      { title: "SYNTHETIC 喜加一", slug: "synthetic-free", end: "2026-11-10T00:00:00.000Z" },
    ]),
    nodeseek: rssFeed([
      {
        title: "SYNTHETIC 论坛帖",
        link: "https://www.nodeseek.com/post-1-1",
        pubDate: "Sat, 07 Nov 2026 00:00:00 +0000",
      },
    ]),
    appinn: EMPTY_RSS,
    ghxi: EMPTY_RSS,
    iplaysoft: rssFeed([
      {
        title: "SYNTHETIC 会员打折",
        link: "https://www.iplaysoft.com/p/synthetic/",
        pubDate: "Sat, 07 Nov 2026 00:00:00 +0000",
        description: "SYNTHETIC summary",
      },
    ]),
    ...overrides,
  };
}

function fetchFrom(map: Record<string, string>, fail: string[] = []): FetchLike {
  return async (input) => {
    const url = String(input);
    const key = Object.keys(map).find((name) => {
      if (name === "linuxdo") return url.includes("r.jina.ai");
      if (name === "v2ex") return url.includes("v2ex.com");
      if (name === "epic") return url.includes("epicgames.com");
      if (name === "nodeseek") return url.includes("nodeseek.com");
      if (name === "appinn") return url.includes("appinn.com");
      if (name === "ghxi") return url.includes("ghxi.com");
      if (name === "iplaysoft") return url.includes("iplaysoft.com");
      return false;
    });
    if (!key) throw new Error(`unexpected url ${url}`);
    if (fail.includes(key)) throw new Error("HTTP 503");
    const finalUrl = key === "iplaysoft" ? "https://feed.iplaysoft.com/" : url;
    return responseFor(map[key]!, finalUrl);
  };
}

describe("refresh", { concurrency: false }, () => {
  it("dedupes URLs, drops items outside 7 days, marks only this round as new, and classifies", async () => {
    useMemoryDb();
    const board = await runRefresh({
      trigger: "schedule",
      now: NOW,
      fetchImpl: fetchFrom(bodies()),
    });
    const titles = board.deals.map((deal) => deal.title);
    assert.equal(titles.includes("SYNTHETIC 过期七天"), false);
    assert.equal(titles.includes("SYNTHETIC 正好七天"), true);
    assert.equal(board.deals.filter((deal) => deal.url === "https://linux.do/t/topic/101").length, 1);
    const shared = board.deals.find((deal) => deal.url === "https://linux.do/t/topic/101");
    assert.equal(shared?.sourceId, "linuxdo");
    assert.equal(shared?.category, "限免");
    assert.equal(shared?.isNew, true);
    const v2ex = board.deals.find((deal) => deal.sourceId === "v2ex");
    assert.equal(v2ex?.url, "https://www.v2ex.com/t/10");
    assert.equal(v2ex?.category, "低价优惠");
    const member = board.deals.find((deal) => deal.title === "SYNTHETIC 会员打折");
    assert.equal(member?.category, "会员订阅");
    const game = board.deals.find((deal) => deal.sourceId === "epic");
    assert.equal(game?.category, "游戏");
    assert.equal(game?.expiresLabel, "2026-11-10 08:00");
    assert.equal(board.sources.find((source) => source.id === "iplaysoft")?.lastFinalUrl, "https://feed.iplaysoft.com/");
    assert.equal(board.newCount, board.deals.length);
    assert.equal(board.sourceHealth.ok, 7);
    assert.equal(board.refreshInProgress, false);

    const second = await runRefresh({
      trigger: "schedule",
      now: NOW + 60_000,
      fetchImpl: fetchFrom(
        bodies({
          linuxdo: [
            linuxdoItem("SYNTHETIC 免费领取测试", 101, RECENT),
            linuxdoItem("SYNTHETIC 正好七天", 103, EXACT),
            linuxdoItem("SYNTHETIC 本轮白嫖", 104, RECENT),
          ].join("\n"),
          v2ex: atomFeed([
            {
              title: "SYNTHETIC 优惠码已改写",
              link: "https://www.v2ex.com/t/10#reply3",
              published: "2026-11-07T00:00:00Z",
            },
          ]),
        }),
      ),
    });
    const kept = second.deals.find((deal) => deal.url === "https://www.v2ex.com/t/10");
    assert.equal(kept?.title, "SYNTHETIC 优惠码已改写");
    assert.equal(kept?.isNew, false);
    const fresh = second.deals.find((deal) => deal.url === "https://linux.do/t/topic/104");
    assert.equal(fresh?.isNew, true);
    assert.equal(fresh?.category, "免费白嫖");
    assert.deepEqual(
      second.deals.filter((deal) => deal.isNew).map((deal) => deal.url),
      ["https://linux.do/t/topic/104"],
    );
    assert.equal(second.newCount, 1);
  });

  it("keeps a failed source's metadata and still records the failure", async () => {
    useMemoryDb();
    await runRefresh({ trigger: "schedule", now: NOW, fetchImpl: fetchFrom(bodies()) });
    const before = listDeals().find((deal) => deal.sourceId === "v2ex");
    assert.ok(before);
    const after = await runRefresh({
      trigger: "schedule",
      now: NOW + 120_000,
      fetchImpl: fetchFrom(bodies(), ["v2ex"]),
    });
    const deal = listDeals().find((row) => row.id === before!.id);
    assert.equal(deal?.title, before!.title);
    assert.equal(deal?.summary, before!.summary);
    assert.equal(deal?.publishedAt, before!.publishedAt);
    assert.equal(deal?.firstSeenRoundId, before!.firstSeenRoundId);
    assert.equal(deal?.updatedAt, before!.updatedAt);
    const failure = after.failures.find((item) => item.sourceId === "v2ex");
    assert.equal(failure?.error, "HTTP 503");
    assert.equal(after.deals.find((item) => item.id === before!.id)?.isNew, false);
    assert.equal(after.roundStatus, "partial");
    assert.equal(after.sourceHealth.ok, 6);
  });

  it("removes an Epic game that is no longer free without touching a failed Epic round", async () => {
    useMemoryDb();
    await runRefresh({ trigger: "schedule", now: NOW, fetchImpl: fetchFrom(bodies()) });
    const removed = await runRefresh({
      trigger: "schedule",
      now: NOW + 60_000,
      fetchImpl: fetchFrom(bodies({ epic: epicPayloadWithoutFreePromotions() })),
    });
    assert.equal(removed.deals.some((deal) => deal.sourceId === "epic"), false);

    await runRefresh({
      trigger: "schedule",
      now: NOW + 120_000,
      fetchImpl: fetchFrom(bodies()),
    });
    const failed = await runRefresh({
      trigger: "schedule",
      now: NOW + 180_000,
      fetchImpl: fetchFrom(bodies(), ["epic"]),
    });
    assert.equal(failed.deals.some((deal) => deal.sourceId === "epic"), true);
    assert.ok(failed.failures.some((item) => item.sourceId === "epic"));
  });

  it("treats an empty Epic catalog as a failed source and keeps stored rows", async () => {
    useMemoryDb();
    await runRefresh({ trigger: "schedule", now: NOW, fetchImpl: fetchFrom(bodies()) });
    assert.equal(listDeals().filter((deal) => deal.sourceId === "epic").length, 1);
    const board = await runRefresh({
      trigger: "schedule",
      now: NOW + 60_000,
      fetchImpl: fetchFrom(bodies({ epic: epicPayload([]) })),
    });
    assert.equal(board.deals.filter((deal) => deal.sourceId === "epic").length, 1);
    assert.ok(board.failures.some((item) => item.sourceId === "epic"));
  });

  it("rejects overlapping refresh and manual cooldown, while a schedule may follow", async () => {
    useMemoryDb();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes("r.jina.ai") && !held) {
        held = true;
        await gate;
      }
      if (init?.signal?.aborted) throw init.signal.reason ?? new Error("aborted");
      return fetchFrom(bodies())(input, init);
    };
    const first = runRefresh({ trigger: "manual", now: NOW, cooldownMs: 60_000, fetchImpl });
    try {
      await assert.rejects(
        () => runRefresh({ trigger: "manual", now: NOW + 1, cooldownMs: 60_000, fetchImpl }),
        (error: unknown) => error instanceof RefreshRejected && error.code === "BUSY",
      );
    } finally {
      release?.();
    }
    await first;
    await assert.rejects(
      () => runRefresh({ trigger: "manual", now: NOW + 2_000, cooldownMs: 60_000, fetchImpl: fetchFrom(bodies()) }),
      (error: unknown) => error instanceof RefreshRejected && error.code === "COOLDOWN",
    );
    const scheduled = await runRefresh({
      trigger: "schedule",
      now: NOW + 3_000,
      fetchImpl: fetchFrom(bodies()),
    });
    assert.equal(scheduled.roundStatus, "success");
  });

  it("records a timeout without deleting deals gathered earlier", async () => {
    useMemoryDb();
    await runRefresh({ trigger: "schedule", now: NOW, fetchImpl: fetchFrom(bodies()) });
    const before = listDeals().length;
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const fail = () => reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
        if (!signal) return;
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    const board = await runRefresh({
      trigger: "schedule",
      now: NOW,
      timeoutMs: 30,
      fetchImpl: hanging,
    });
    assert.equal(listDeals().length, before);
    assert.equal(board.roundStatus, "failed");
    assert.equal(board.failures.length, 7);
    assert.ok(board.failures.every((failure) => failure.error === "超时"));
    assert.equal(board.newCount, 0);
  });

  it("notifies once per round with only the deals that round first stored", async () => {
    useMemoryDb();
    const sent: RoundNotification[] = [];
    const notify = async (input: RoundNotification) => {
      sent.push(input);
    };

    const first = await runRefresh({ trigger: "schedule", now: NOW, fetchImpl: fetchFrom(bodies()), notify });
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.roundId > 0);
    assert.equal(sent[0]!.status, "success");
    assert.equal(sent[0]!.newDeals.length, first.newCount);
    assert.ok(sent[0]!.newDeals.every((deal) => deal.firstSeenRoundId === sent[0]!.roundId));
    assert.equal(sent[0]!.totalSources, 7);

    const second = await runRefresh({
      trigger: "schedule",
      now: NOW + 60_000,
      fetchImpl: fetchFrom(bodies()),
      notify,
    });
    assert.equal(sent.length, 2);
    assert.equal(second.newCount, 0);
    assert.equal(sent[1]!.newDeals.length, 0);
  });

  it("reports an all-source failure with the per-source reasons", async () => {
    useMemoryDb();
    const sent: RoundNotification[] = [];
    await runRefresh({
      trigger: "manual",
      now: NOW,
      fetchImpl: fetchFrom(bodies(), ["linuxdo", "v2ex", "epic", "nodeseek", "appinn", "ghxi", "iplaysoft"]),
      notify: async (input) => {
        sent.push(input);
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.status, "failed");
    assert.equal(sent[0]!.okSources, 0);
    assert.equal(sent[0]!.failures.length, 7);
    assert.ok(sent[0]!.failures.every((failure) => failure.error === "HTTP 503"));
  });

  it("keeps a stored round when the notifier throws", async () => {
    useMemoryDb();
    const board = await runRefresh({
      trigger: "schedule",
      now: NOW,
      fetchImpl: fetchFrom(bodies()),
      notify: async () => {
        throw new Error("telegram unavailable");
      },
    });
    assert.equal(board.roundStatus, "success");
    assert.ok(listDeals().length > 0);
  });
});
