# 变更记录

格式参考 Keep a Changelog，版本遵循语义化版本。日期为北京时间。测试项数以 `npm test` 输出为准，在架条数以 `/api/deals` 为准，不写进文档。

## [Unreleased]

- 安全：npm 默认回环监听；可选 PERKRADAR_ACCESS_TOKEN、签名会话和 Bearer 保护网页/数据/刷新 API；补 TLS 代理模板和登录限流。
- 数据质量：分类改信号评分并读时重算（可回退）；修 Pro/更新/问号误判，默认显示全部、搜索不隐藏其他。Epic 逐条结构验证，异常不清旧记录；所有文本源共享日期防护。
- 稳定性：429/503 有限退避、尊重 Retry-After、短时熔断和 Jina 配置诊断；SQLite scheduler/refresh 租约与心跳、重启超期只补一轮。
- 展示：可见页面30秒更新/重新聚焦检查、超时取消、过期重算；API分页与总数、页面分组展开，不再把单源2000条当整站上限；本地存储失败保留内存改动。
- 迁移：快照改显式配置，UA改PerkRadar；浏览器键迁移到perkradar-*并保留旧键。Compose project/container/image改为perkradar，旧部署必须在停机备份窗口迁移，不能同时启动；本次提交不自动重启任何服务。
- 调度修复：上个进程被强杀后 90 秒内重启不再因调度租约让整个服务启动失败（此前所有请求 500）；租约丢失后自动重新获取，不再永久停止抓取；改为每 20 秒对照墙上时钟，休眠醒来立即补一轮；全部来源失败 10 分钟后重试并指数退避，撞上进行中的刷新 60 秒后重试。容器改为直接启动 node，停止时释放租约。
- 认证修复：未登录跳转按访客 Host 与 `x-forwarded-proto` 生成，反向代理后不再跳到 `localhost:38471`；登录页套用看板样式并显示失败原因，已登录或未开启认证时回首页；新增「退出」与 `DELETE /api/session`；会话过期后页面回登录页而不是一直提示数据不可用。
- 分类：补充优惠码/券、折扣、促销、特价、返现、羊毛、红包、注册送额度等信号；二手买卖帖和提问句扣分，不再因为带价格或「免费」字样被算成优惠。
- 稳定性：上游 Retry-After 封顶 6 小时；打开数据库时先设置等待超时再切换 WAL。
- 工程：最低Node22.13、对齐Node类型，事务化user_version=1迁移/复合索引/30天运行历史保留，实时探测异常退出非零，多阶段镜像和日志轮转；新增离线回归、真实跨进程租约验证。


- 仓库卫生：移除两份本机验收报告，清理对外文档里指向本地工具目录、本地验收日志的失效链接，以及本机运行状态与工作区内容的描述；归档目录示例改为中性名称。
- 安全：新增 `.github/workflows/secret-scan.yml`，在 push / PR / 每日定时用 gitleaks 扫描全部历史，防止凭据再次进入版本库。
- 部署：新增 Dokploy 用的 `docker-compose.dokploy.yml`、`deploy/dokploy.env.example` 和 [docs/DOKPLOY.md](docs/DOKPLOY.md)：接入 `dokploy-network`、数据改命名卷、公网强制要求访问令牌，并提供可选的 `Deploy to Dokploy` Webhook 工作流。
- 部署：新增 `build-image.yml` 与 `docker-compose.dokploy-image.yml`，在 GitHub Actions 构建并推送 GHCR 镜像，Dokploy 只拉取分层；镜像推送完成后再触发部署，避免在 3 GB 主机上编译；构建模式保留为回退方案。
- 通知：新增可选 Telegram 推送（`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`）。每轮提交后只推本轮新条目，整轮全部来源失败时发告警；发送失败只记日志，不回滚数据，也不阻塞下一轮刷新。日志不写令牌、chat id 或消息正文。
- 通知修复：Telegram 只推送被分类为优惠的新条目，资讯、软件更新、求助和二手交易（「其他」）不再推送，与看板默认视图一致；整轮只有这类条目时记 `telegram_skipped`，`telegram_notified` 增加过滤后的 `newDeals` 和 `skipped`。

- 文档：补充结构化日志的逐轮排查命令、事件与 `/api/health` / `/api/deals` 字段的对应关系，以及手动刷新拒绝事件的 `code` / `status` 组合；运维排障表新增按轮次看日志的入口，并说明重建容器后旧日志不再可见、留档需先导出。

## [0.2.0] - 2026-11-09

本版本源码已通过本地回归与构建检查；对应 GitHub Release 随本次发布创建。

### 界面重构与数据校验（2026-11-09）

- 界面：正式首页按 `/demo` 的布局重构——顶部只保留品牌与「立即刷新」，搜索、排序、来源、分类、收藏、运行状态与逐源结果移到左侧状态区和提示区，「只看新增」放在「信息列表」标题行右侧；卡片只保留标题、收藏文字按钮、摘要框、原文信息、标签、「打开原文」与「标记已领」。浅色底、`RGB(20,148,130)` 小面积强调，未实现深色模式，使用系统字体、不加载外部字体或 CDN。
- 样式与预览：正式页与 `/demo` 共用 `src/components/deal-board.css`，移除 `src/app/demo/demo.css`；`/demo` 是 7 条示例的本地 dev 预览（其中 1 条「其他」默认隐藏，「只看新增」仍为 3 条，开关只在当前页面内存生效、刷新重置），只在本地源码与 dev 预览可用，生产镜像的构建结果只有 `/`、`/_not-found` 与三个 API，不含 `/demo`。
- 数据校验：新增 `src/lib/board-view.ts`，在客户端校验 `/api/deals`、`/api/refresh` 与 SSR 快照：拒绝 `javascript:` / `data:` / 带凭据 / 超长 URL，截断异常文本，关键结构损坏时拒绝整份数据，计数从校验后的 `deals` 推导；`filterDeals` 容忍畸形字段，搜索按字面包含匹配。
- 交互与状态：正式页仍用 `/api/deals` 轮询、`/api/refresh` 刷新、`/api/health` 数据；`daily-deals-personal-v1` 与 `{ claimed, favorites }` 形状不变，`storage` 事件跨标签同步；本地状态写入失败、轮询失败、空库、筛选为空，以及刷新 429 / 断网 / 畸形响应各有区分提示。
- 默认隐藏「其他」：正式页「全部」视图默认隐藏分类为「其他」的条目，结果标题行显示可见条数与「已隐藏 N 条「其他」线索」，并放「查看全部线索」与「只看新增」两个开关。显式选「其他」分类或「我的收藏」时不隐藏；搜索仍受默认隐藏影响，结果为空会提示打开开关；重置回默认隐藏。「查看全部线索」用独立 `localStorage` 键 `daily-deals-show-all-v1` 记住选择并监听 `storage` 事件跨标签同步，刷新后保留。隐藏只作用于展示：数据库、抓取源、分类规则、`filterDeals` 默认行为均不变（`src/lib/filter-deals.ts` 新增可选 `includeOther`，省略时沿用旧行为；`tests/filter.test.ts` 新增覆盖）。正式页底部不再链接到只在 dev 存在的 `/demo`，避免生产环境预取 404。
- 测试与验收：新增看板视图、对抗性与筛选测试；`npm test`、`npm run lint`、`npx --no-install tsc --noEmit`、`npm run build`、`git diff --check` 通过；1280 桌面与 390 手机预览无控制台报错、无失败请求、无关键视觉缺陷（左栏文字重叠已修），干净浏览器会话 console errors=0、network failed=[]、healthy=true，390px 无横向溢出；默认隐藏、查看全部线索开关、只看新增组合、显式选「其他」/「我的收藏」、重置、刷新后开关保留等主流程均通过。测试项数以 `npm test` 输出为准。
- 文档：README 与各文档同步为当前布局与默认隐藏「其他」的行为；明确「其他」只是线索分类、不是优惠判定，隐藏只改展示、不改收录规则；收紧入库关键词是尚未实施的后续选项。dev/build 共用 `.next` 的注意事项见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 加固与修正

- 解析：Epic 返回 200 但商品列表为空数组时视为上游异常、该源失败（「Epic 商品列表为空」），不删除库里已有的 Epic 行；正常「有商品但没有当前免费促销」仍返回空结果并按既有规则下架。
- 解析：feed 发布时间早于 2000-01-01 或晚于当前时刻 +7 天记为无效（`published_at` 为 `null`），留存改用 `first_seen_at`；单个 feed 最多解析 2000 条。
- 抓取：先用 `Content-Length` 预检，再按块流式读取，累计超过 150 万字符即停止下载并报「响应过大」；HTTP 错误状态在读取响应体之前就返回。单源 25 秒超时不变。
- 清洗：去掉 ANSI/SGR 控制序列（含只剩 `[1m` 这类残留与 `[H[J[3J` 这类裸 CSI 片段）、C0 控制字符，以及 8 个以上连续的 `+ * = _ ~ #` 分隔线；标题 300 字、摘要 160 字上限不变。读库展示时再做一次幂等清洗，早期已入库的历史行同样生效，不改写现有数据库。
- 链接：超过 2048 字符、含 `user:pass@` 凭证或非 http/https 协议的链接直接拒绝。
- 链接边界：七个来源各有一份允许域名，条目链接不在本源域名（含子域）内会被丢弃并记 `offsite_link_dropped`。来源 URL 未改，LINUX DO 仍走现有 Jina 地址。
- 界面：卡片按钮「打开原文」、左侧状态区「已收录」、持续可见的线索说明；修复 390px 宽度下状态区裁切与卡片底部控件溢出；本地状态写入失败有可见提示、监听 `storage` 事件跨标签同步、轮询接口失败有可见提示并与空库/筛选为空区分。`daily-deals-personal-v1` 与 `{ claimed, favorites }` 形状不变。
- 接口：`GET /api/deals` 数据库异常时返回 503 `数据库不可读` 并记 `deals_read_failed`；成功响应字段不变。三个接口都带 `cache-control: no-store`。
- 安全：客户端 IP 默认忽略 `x-forwarded-for` / `x-real-ip`（一律归 `local`），仅 `TRUST_PROXY_HEADERS=1` 时信任转发头；带 `sec-fetch-site: cross-site` 的刷新请求拒绝 403；不带 `Origin` 的请求仍放行。
- 日志：统一前缀 `[deals] {"event":...,"at":ISO,...}`，成功事件走 stdout、失败事件走 stderr，不含标题正文、Cookie、请求头或个人状态；事件清单见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
- 工程：`engines.node >=22` 与 `.nvmrc`（22）；`tsconfig.json` / `eslint.config.mjs` 排除 `deployment-backups/`；`.dockerignore` 排除根目录文档、`scripts/` 与 `.secrets/`；`.gitignore` 排除 `.secrets/`；两个 workflow 增加 `permissions: contents: read`，live-sources 的 cron 注明为 UTC。镜像仍以 `node`（uid 1000）非 root 运行。
- Docker/Jina：根目录 `.env` 变为可选；Compose 将 `JINA_API_KEY` 和 `JINA_API_KEY_FILE` 传入容器。密钥文件须由运行环境单独挂载，镜像构建上下文不会包含 `.secrets/`。

### 已知边界

规范化 URL 仍不统一 `www.` 前缀、http/https 与路径大小写，这是已知限制，不是已修复项。

## [v0.1.0] - 2026-11-08

首个公开版本，tag 与 GitHub Release 已发布。定位：**多来源优惠线索聚合**，不是逐条认证的领取平台。上传 GitHub 只代表源码公开，不代表网站已公网部署。

### 能力

- 7 个固定来源并发抓取，单源 25 秒超时与失败隔离；LINUX DO Markdown、RSS/Atom、Epic JSON 三类解析。
- Epic 当前免费促销的半开时间窗与 0 价判定；7 天留存与到期淘汰的毫秒边界；规范化 URL 去重。
- 进程内 2 小时调度、启动首轮、进程内锁；手动刷新的冷却、IP 限流与同源校验。
- 服务端渲染页面与 3 个接口；收藏与已领的浏览器本地持久化。
- 测试、lint、构建与 CI 覆盖；生产依赖审计（显式指定官方 registry）为 0 项。

### 已知限制

- 综合 RSS/Atom 源按 7 天窗口收录，闲聊、求购、抽奖、推广会进入列表；关键词分类会误判。保留「线索聚合」路线，不声称逐条优惠。
- 除 Epic 外没有真实截止时间；「近 7 天」是留存规则，不是活动截止日。
- 进程内定时器在休眠或停机期间不补轮；重启会立刻再抓一轮并改写下次计划。
- 公开快照在本机 Compose 默认关闭；外部推送渠道不属于本仓库。
- 单人单实例、非公网服务；品牌文案与运行标识保持分离（Compose 项目名、容器名、卷与收藏键未改名）。
