export type SourceDef = {
  id: string;
  name: string;
  url: string;
  /** Item links must stay on the source's own domain: feed content is untrusted input. */
  allowedHosts: string[];
};

/**
 * Fixed sources. Callers cannot substitute URLs.
 * V2EX must be the plural `promotions.xml`. `promotion.xml` returns an empty feed.
 * LINUX DO must go through the Jina reader. Direct category RSS is not used.
 * 异次元 is requested at the URL that 301-redirects; the client follows it.
 */
export const SOURCE_DEFS: SourceDef[] = [
  {
    id: "linuxdo",
    name: "LINUX DO福利羊毛",
    url: "https://r.jina.ai/https://linux.do/c/welfare/36.rss",
    allowedHosts: ["linux.do"],
  },
  {
    id: "v2ex",
    name: "V2EX推广",
    url: "https://www.v2ex.com/feed/promotions.xml",
    allowedHosts: ["v2ex.com"],
  },
  {
    id: "epic",
    name: "Epic",
    url: "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN",
    allowedHosts: ["store.epicgames.com"],
  },
  {
    id: "appinn",
    name: "小众软件",
    url: "https://www.appinn.com/feed/",
    allowedHosts: ["appinn.com"],
  },
  {
    id: "ghxi",
    name: "果核剥壳",
    url: "https://www.ghxi.com/feed",
    allowedHosts: ["ghxi.com"],
  },
  {
    id: "iplaysoft",
    name: "异次元软件世界",
    url: "https://www.iplaysoft.com/feed",
    allowedHosts: ["iplaysoft.com"],
  },
];

export function sourceName(id: string): string {
  return SOURCE_DEFS.find((source) => source.id === id)?.name ?? id;
}
