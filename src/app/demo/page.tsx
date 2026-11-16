"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Bookmark, Check, ChevronDown, ExternalLink, Radar, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import "../../components/deal-board.css";

// 仅用于界面预览：不读取接口，不写入数据库或浏览器存储。
const deals = [
  { id: 1, title: "开发者工具限时体验", description: "代码编辑、部署与协作工具体验线索，适合寻找下一款开发工具。具体资格与使用限制需查看原文。", source: "LINUX DO", category: "开发工具", fresh: true },
  { id: 2, title: "本周游戏发现：独立游戏与周末试玩", description: "独立游戏与周末试玩合集，方便集中浏览感兴趣的作品。试玩范围与开放时间需以原文为准。", source: "Epic", category: "游戏娱乐", fresh: true },
  { id: 3, title: "轻量云服务器资源优惠线索", description: "面向个人博客、实验项目与小型服务的云资源信息。配置、地区与续费价格需进一步确认。", source: "V2EX", category: "云与主机", fresh: true },
  { id: 4, title: "效率应用清单：窗口管理与笔记整理", description: "收集窗口管理、笔记整理等日常效率工具，便于比较使用场景。支持平台与授权方式需查看原文。", source: "小众软件", category: "软件应用", fresh: false },
  { id: 5, title: "开源工具箱：日常开发实用项目", description: "社区分享的开发工具与开源项目，涵盖常见的日常工作需求。功能说明与开源许可需以项目原文为准。", source: "V2EX", category: "开发工具", fresh: false },
  { id: 6, title: "桌面工具推荐：文件整理、阅读与知识管理", description: "桌面应用体验线索，覆盖文件整理、阅读与个人知识管理。是否免费及适用系统需查看原文说明。", source: "异次元", category: "软件应用", fresh: false },
  { id: 7, title: "闲聊：最近大家在用什么桌面小工具", description: "综合源里的普通讨论，仅用于演示「其他」默认隐藏；不代表优惠线索。", source: "V2EX", category: "其他", fresh: false },
];
const sources = ["全部来源", "LINUX DO", "V2EX", "Epic", "小众软件", "果核剥壳", "异次元"];
const categories = ["全部", "开发工具", "游戏娱乐", "云与主机", "软件应用", "其他"];
type Deal = (typeof deals)[number];

/** 纯视觉演示：筛选、收藏与标记只存在于当前页面内存。 */
export default function DemoPage() {
  const [source, setSource] = useState("全部来源");
  const [category, setCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [newOnly, setNewOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [favorites, setFavorites] = useState<number[]>([]);
  const [claimed, setClaimed] = useState<number[]>([]);
  const [selected, setSelected] = useState<Deal | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  // 演示页在客户端挂载后展开，避免开发浏览器扩展注入属性造成 SSR 警告。
  useEffect(() => setMounted(true), []);
  const term = query.trim().toLowerCase();
  const hideOther = !showAll && category === "全部";
  const matching = deals.filter((deal) =>
    (source === "全部来源" || source === deal.source) &&
    (category === "全部" || category === deal.category) &&
    (!favoritesOnly || favorites.includes(deal.id)) &&
    (!newOnly || deal.fresh) &&
    `${deal.title} ${deal.description} ${deal.source} ${deal.category}`.toLowerCase().includes(term),
  );
  const visible = matching.filter((deal) => !hideOther || deal.category !== "其他");
  const hiddenOtherCount = hideOther ? matching.filter((deal) => deal.category === "其他").length : 0;
  const activeFilters = [source !== "全部来源", category !== "全部", term.length > 0, favoritesOnly, newOnly].filter(Boolean).length;

  function resetFilters() {
    setSource("全部来源");
    setCategory("全部");
    setQuery("");
    setFavoritesOnly(false);
    setNewOnly(false);
    setShowAll(false);
  }
  function toggleFavorite(id: number) {
    setFavorites((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }
  function toggleClaimed(id: number) {
    setClaimed((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }
  function openDetails(deal: Deal) {
    setSelected(deal);
    dialog.current?.showModal();
  }

  if (!mounted) return <div className="perk-board"><div className="board-loading">正在打开示例…</div></div>;

  return (
    <div className="perk-board">
      <div className="demo-shell">
        <header className="demo-header">
          <Link className="demo-brand" href="/demo"><Radar aria-hidden="true" />PerkRadar</Link>
          <div className="demo-header-actions">
            <Button variant="ghost" asChild><a href="http://127.0.0.1:38471/">返回正式站<ExternalLink data-icon="inline-end" /></a></Button>
          </div>
        </header>
        <div className="demo-layout">
          <aside className="demo-sidebar" aria-label="搜索与筛选">
            <button className="demo-filter-toggle" type="button" aria-expanded={mobileFiltersOpen} aria-controls="demo-filter-body" onClick={() => setMobileFiltersOpen(!mobileFiltersOpen)}>
              <SlidersHorizontal aria-hidden="true" />搜索与筛选{activeFilters ? <span className="demo-filter-count">{activeFilters}</span> : null}<ChevronDown aria-hidden="true" />
            </button>
            <div id="demo-filter-body" className="demo-filter-body" data-open={mobileFiltersOpen ? "true" : "false"}>
              <div className="demo-sidebar-head"><h2>筛选</h2><Button className="demo-reset" variant="ghost" size="sm" onClick={resetFilters}>重置</Button></div>
              <form className="demo-search" role="search" onSubmit={(event) => event.preventDefault()}>
                <label className="sr-only" htmlFor="demo-search">搜索示例线索</label>
                <Input id="demo-search" type="search" placeholder="搜索工具、软件或关键词…" value={query} onChange={(event) => setQuery(event.target.value)} />
                <Button type="submit" size="icon" aria-label="搜索示例线索"><Search /></Button>
              </form>
              <section className="demo-filter-group" aria-label="来源筛选">
                <h3>来源</h3>
                <div className="demo-filter-row">
                  {sources.map((name) => <Button key={name} className="demo-pill" variant={source === name ? "default" : "outline"} aria-pressed={source === name} onClick={() => setSource(name)}>{name}<span>{name === "全部来源" ? deals.length : deals.filter((deal) => deal.source === name).length}</span></Button>)}
                </div>
              </section>
              <section className="demo-filter-group" aria-label="分类与收藏筛选">
                <h3>分类</h3>
                <div className="demo-filter-row">
                  {categories.map((name) => <Button key={name} className="demo-pill" variant={category === name ? "default" : "outline"} aria-pressed={category === name} onClick={() => setCategory(name)}>{name}</Button>)}
                  <Button className="demo-pill" variant={favoritesOnly ? "default" : "outline"} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}><Bookmark data-icon="inline-start" />我的收藏<span>{favorites.length}</span></Button>
                </div>
              </section>
              <p className="demo-sidebar-note">全部为示例内容，非真实优惠。</p>
            </div>
          </aside>
          <main className="demo-content">
            <div className="demo-results-heading"><h1>信息列表</h1><span role="status" data-testid="visible-count">{visible.length} 条示例</span>{hiddenOtherCount > 0 ? <span className="board-hidden-note" role="status" data-testid="hidden-note">已隐藏 {hiddenOtherCount} 条「其他」示例</span> : null}<div className="demo-results-actions"><label className="demo-new-toggle demo-results-toggle"><input type="checkbox" data-testid="show-all" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /><span className="demo-switch" aria-hidden="true" />查看全部线索</label><label className="demo-new-toggle demo-results-toggle"><input type="checkbox" checked={newOnly} onChange={(event) => setNewOnly(event.target.checked)} /><span className="demo-switch" aria-hidden="true" />只看新增</label></div></div>
            <div className="demo-cards">
              {visible.map((deal) => {
                const isFavorite = favorites.includes(deal.id);
                const isClaimed = claimed.includes(deal.id);
                return <article key={deal.id} className="demo-deal" data-claimed={isClaimed}>
                  <div className="deal-heading">
                    <h2>{deal.title}</h2>
                    <Button variant="ghost" className="demo-favorite" aria-label={`${isFavorite ? "取消收藏" : "收藏"}：${deal.title}`} aria-pressed={isFavorite} onClick={() => toggleFavorite(deal.id)}><Bookmark /><span>{isFavorite ? "已收藏" : "收藏"}</span></Button>
                  </div>
                  <div className="deal-summary"><span>摘要 · 示例</span><p>{deal.description}</p></div>
                  <details className="deal-original"><summary>查看原文摘要</summary><p>当前为界面演示，正式页面会在这里展示抓取到的原文信息。</p></details>
                  <div className="deal-tags">{deal.fresh ? <span className="deal-fresh">本轮新增</span> : null}<Badge variant="secondary">{deal.category}</Badge><Badge variant="outline">{deal.source}</Badge>{isClaimed ? <span className="deal-claimed-state">已标记已领</span> : null}</div>
                  <div className="deal-actions">
                    <Button variant={isClaimed ? "secondary" : "default"} onClick={() => openDetails(deal)}>查看详情<ArrowUpRight data-icon="inline-end" /></Button>
                    <Button variant="outline" aria-pressed={isClaimed} onClick={() => toggleClaimed(deal.id)}><Check data-icon="inline-start" />{isClaimed ? "撤销已领" : "标记已领"}</Button>
                  </div>
                </article>;
              })}
            </div>
            {visible.length === 0 ? <div className="demo-empty"><Search aria-hidden="true" /><h2>没有匹配的示例</h2><p>{hiddenOtherCount > 0 ? "当前条件下只剩已隐藏的「其他」示例，打开「查看全部线索」即可查看。" : "试试其他关键词，或清除来源、分类和收藏筛选。"}</p><Button variant="outline" onClick={resetFilters}>清除筛选</Button></div> : null}
            <footer className="demo-footer">7 条设计示例中，默认隐藏 1 条「其他」示例；收藏与已领标记仅在本页临时生效，刷新后重置。</footer>
          </main>
        </div>
      </div>
      <dialog ref={dialog} className="demo-dialog" aria-label="示例线索详情">
        <div className="dialog-top"><Badge variant="secondary">示例详情</Badge><Button variant="ghost" size="icon" aria-label="关闭详情" onClick={() => dialog.current?.close()}><X /></Button></div>
        {selected ? <><h2>{selected.title}</h2><div className="deal-tags"><Badge variant="secondary">{selected.category}</Badge><Badge variant="outline">{selected.source}</Badge></div><p>{selected.description}</p><p className="dialog-note">此条为设计示例，没有真实优惠或原文链接，不代表已经核实可领取。</p><div className="dialog-actions"><Button variant="outline" aria-pressed={favorites.includes(selected.id)} onClick={() => toggleFavorite(selected.id)}><Bookmark data-icon="inline-start" />{favorites.includes(selected.id) ? "取消收藏" : "收藏"}</Button><Button aria-pressed={claimed.includes(selected.id)} onClick={() => toggleClaimed(selected.id)}><Check data-icon="inline-start" />{claimed.includes(selected.id) ? "撤销已领" : "标记已领"}</Button></div></> : null}
      </dialog>
    </div>
  );
}
