import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../src/lib/classify";
import { parseEpicFreeGames } from "../src/lib/parse/epic";
import { parseFeed } from "../src/lib/parse/feed";
import { isStale } from "../src/lib/retention";

/**
 * Negative cases for data quality.
 *
 * Product decision recorded in README: v0.1.0 keeps the "aggregate every feed
 * item inside a 7-day window" behaviour and describes itself as a lead
 * aggregator, NOT a certified deal list. These tests therefore lock down the
 * boundaries we can honestly guarantee: no invented fields, no invented deals,
 * empty results are allowed, and misclassifications are recorded as known
 * behaviour instead of being silently "fixed" by dropping real leads.
 */

const NOW = Date.parse("2026-11-08T08:00:00.000Z");
const HOUR = 3_600_000;

type Offer = { startDate: string; endDate: string; discountSetting: { discountPercentage: number } };

function offer(startOffsetMs: number, endOffsetMs: number, percentage = 0): Offer {
  return {
    startDate: new Date(NOW + startOffsetMs).toISOString(),
    endDate: new Date(NOW + endOffsetMs).toISOString(),
    discountSetting: { discountPercentage: percentage },
  };
}

function epicElement(options: {
  title?: string;
  slug?: string;
  price?: number;
  current?: Offer[];
  upcoming?: Offer[];
} = {}): unknown {
  return {
    title: options.title ?? "SYNTHETIC 游戏",
    description: "SYNTHETIC description",
    productSlug: options.slug ?? "synthetic-game",
    price: { totalPrice: { discountPrice: options.price ?? 0 } },
    promotions: {
      promotionalOffers: [{ promotionalOffers: options.current ?? [] }],
      upcomingPromotionalOffers: [{ promotionalOffers: options.upcoming ?? [] }],
    },
  };
}

function catalog(elements: unknown[]): unknown {
  return { data: { Catalog: { searchStore: { elements } } } };
}

describe("data quality negative cases", () => {
  it("keeps chit-chat and want-to-buy titles out of deal categories", () => {
    assert.equal(classify("英雄联盟预测闲聊", "v2ex"), "其他");
    assert.equal(classify("求上车自建 5元一月左右足以", "v2ex"), "其他");
    assert.equal(classify("dmit 今天连不上ip", "v2ex"), "其他");
    assert.equal(classify("【避雷】无良商家应当被置顶", "v2ex"), "其他");
  });

  it("keeps lotteries, vague offers, and questions out of deal categories", () => {
    assert.equal(classify("【抽奖】10个免费gpt账号（未接码）", "linuxdo"), "其他");
    assert.equal(classify("有打篮球 v2er 吗？ 送会员了！", "v2ex"), "其他");
    assert.equal(classify("收team优惠码？", "v2ex"), "其他");
    assert.equal(classify("求购二手路由器", "v2ex"), "其他");
    assert.equal(classify("优惠码评测", "appinn"), "其他");
  });

  it("drops expired items and keeps the exact millisecond boundaries", () => {
    assert.equal(
      isStale({ publishedAt: NOW - 8 * 24 * HOUR, firstSeenAt: NOW, expiresAt: null }, NOW),
      true,
    );
    assert.equal(
      isStale({ publishedAt: NOW - 7 * 24 * HOUR, firstSeenAt: NOW, expiresAt: null }, NOW),
      false,
    );
    assert.equal(
      isStale({ publishedAt: NOW, firstSeenAt: NOW, expiresAt: NOW }, NOW),
      true,
    );
    assert.equal(
      isStale({ publishedAt: NOW, firstSeenAt: NOW, expiresAt: NOW + 1 }, NOW),
      false,
    );
  });

  it("excludes upcoming promotions and a permanently free base game without an active window", () => {
    const upcoming = epicElement({ upcoming: [offer(HOUR, 48 * HOUR)] });
    assert.equal(parseEpicFreeGames(catalog([upcoming]), NOW).length, 0);
    const permanent = epicElement({ current: [] });
    assert.equal(parseEpicFreeGames(catalog([permanent]), NOW).length, 0);
  });

  it("excludes paid discounts, ended promotions and non-free percentages", () => {
    assert.equal(parseEpicFreeGames(catalog([epicElement({ price: 990, current: [offer(-HOUR, HOUR)] })]), NOW).length, 0);
    assert.equal(parseEpicFreeGames(catalog([epicElement({ current: [offer(-48 * HOUR, -HOUR)] })]), NOW).length, 0);
    assert.equal(
      parseEpicFreeGames(catalog([epicElement({ current: [offer(-HOUR, HOUR, 50)] })]), NOW).length,
      0,
    );
  });

  it("accepts a limited-time free bundle and uses the promotion window as publish/expiry", () => {
    const current = [offer(-HOUR, 48 * HOUR)];
    const [item] = parseEpicFreeGames(catalog([epicElement({ title: "SYNTHETIC 限时礼包", current })]), NOW);
    assert.equal(item?.title, "SYNTHETIC 限时礼包");
    assert.equal(item?.publishedAt, Date.parse(current[0]!.startDate));
    assert.equal(item?.expiresAt, Date.parse(current[0]!.endDate));
    assert.equal(item?.url, "https://store.epicgames.com/zh-CN/p/synthetic-game");
  });

  it("allows an empty result instead of padding the board with ordinary posts", () => {
    const emptyFeed = '<?xml version="1.0"?><rss version="2.0"><channel><title>empty</title></channel></rss>';
    assert.deepEqual(parseFeed(emptyFeed), []);
    // An empty catalog is an upstream anomaly, not a legitimate empty result:
    // accepting it would make refresh delete every stored Epic row.
    assert.throws(() => parseEpicFreeGames(catalog([]), NOW), /商品列表为空/);
    assert.deepEqual(
      parseEpicFreeGames(catalog([epicElement({ current: [], upcoming: [offer(HOUR, 48 * HOUR)] })]), NOW),
      [],
    );
  });

  it("never invents a summary, a price, or a publish date for a plain post", () => {
    const xml = [
      '<?xml version="1.0"?><rss version="2.0"><channel><title>feed</title><item>',
      "<title>今天天气不错</title>",
      "<link>https://example.com/post-1</link>",
      "</item></channel></rss>",
    ].join("");
    const [item] = parseFeed(xml);
    assert.equal(item?.title, "今天天气不错");
    assert.equal(item?.url, "https://example.com/post-1");
    assert.equal(item?.summary, "");
    assert.equal(item?.publishedAt, null);
    assert.equal(item?.expiresAt, null);
    assert.equal("price" in (item ?? {}), false);
  });
});
