# PerkRadar

PerkRadar 是一个可自行部署的优惠线索聚合器。它定时读取固定的公开 RSS、Atom、JSON 和 Markdown 来源，把标题、原文链接和短摘要整理到一个轻量的 SQLite 数据库，再用网页看板帮助你搜索、筛选、收藏和标记已领。

条目来自公开订阅源，可能包含闲聊、求购、推广或失效活动。分类由标题规则推断，不构成优惠真实性、有效期或领取资格的核验；请以原文和活动官方说明为准。

## 部署方式

推荐让 Personal Agent 协助部署，也可按下方步骤自行运行。PerkRadar 适用于单机单实例部署，需要常驻 Node 进程和可写的本地 SQLite 数据目录。

- **本机使用**：默认绑定 `127.0.0.1:38471`，未启用认证时仅用于可信的单用户环境。
- **公网单机**：通过 TLS 反向代理访问，并设置至少 32 字符的随机 `PERKRADAR_ACCESS_TOKEN`；应用端口继续仅对宿主机开放。
- **Dokploy**：使用根目录的 `docker-compose.dokploy.yml`，由 Dokploy 负责域名、HTTPS 和反向代理；也可改用 `docker-compose.dokploy-image.yml`，由 GitHub Actions 构建镜像后只拉取部署。步骤见[在 Dokploy 上部署](docs/DOKPLOY.md)。

配置 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_CHAT_ID` 后，每轮新增优惠会推送一条 Telegram 摘要；没有新增时不发送。通知是尽力而为，失败不会影响抓取和已存数据。

## 快速开始

### 环境要求

- **Docker 方式**：Docker Engine 和 Docker Compose v2.24 或更高版本，也可使用 Docker Desktop；宿主机无需另装 Node.js。
- **直接运行源码**：Node.js 22.13 或更高版本，以及 npm。项目使用 Node 内置的 `node:sqlite`，依赖解析锁定在 `package-lock.json` 中。

### 获取源码

```bash
git clone https://github.com/luobinger/PerkRadar.git
cd PerkRadar
```

### 用 Docker 运行

此命令构建生产镜像并启动容器，SQLite 数据保存在宿主机的 `./data`。容器以非 root 的 `node` 用户（uid 1000）运行，宿主数据目录须允许该用户写入；权限设置见[运维文档](docs/OPERATIONS.md)。

Compose 可读取项目根目录的 `.env`。该文件被 Git 和镜像构建忽略；包含凭据时应使用 `600` 权限。配置项见下方[访问控制与配置](#访问控制与配置)。

```bash
docker compose -p perkradar up -d --build
```

打开 [http://127.0.0.1:38471/](http://127.0.0.1:38471/)。宿主端口被占用时，可只替换宿主端口，容器内端口仍为 `38471`：

```bash
HOST_PORT=38481 docker compose -p perkradar up -d --build
```

此时访问 [http://127.0.0.1:38481/](http://127.0.0.1:38481/)。

### 用 npm 开发

在项目目录安装依赖：

```bash
npm ci
```

以下示例使用独立端口和开发数据库，避免与默认部署共用：

```bash
DATA_DIR="$HOME/.local/share/perkradar-dev" PORT=38481 npm run dev
```

打开 [http://127.0.0.1:38481/](http://127.0.0.1:38481/)。调度器会抓取真实来源；端口如已占用，需换用空闲端口。未显式设置时，监听地址为 `127.0.0.1:38471`，数据库为 `./data/deals.db`。

开发环境的 `/demo` 使用示例数据展示界面，不代表真实抓取结果；生产 Docker 镜像不包含此路由。

## 访问控制与配置

| 配置项 | 用途与默认行为 |
| --- | --- |
| `PERKRADAR_ACCESS_TOKEN` | 本应用的共享访问令牌。未设置或为空时关闭认证；非空但少于 32 字符时拒绝访问 |
| `PERKRADAR_SECURE_COOKIE` | 生产会话默认启用 `Secure`；仅可信本机 HTTP 调试可设为 `0` |
| `JINA_API_KEY` | LINUX DO 来源使用的 Jina 凭据，与应用访问令牌无关；不配置时匿名请求可能受额度和限流影响 |
| `JINA_API_KEY_FILE` | 从文件读取 Jina 凭据；容器部署须单独挂载可读文件，仅放在宿主 `.secrets/` 下不会自动挂载 |
| `DATA_DIR` | 直接运行时默认 `./data`；Compose 固定为容器内 `/data`，挂载宿主 `./data` |
| `HOST` / `PORT` | 直接运行时默认 `127.0.0.1` / `38471`；Compose 使用 `HOST_PORT` 更改宿主端口 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 同时设置后推送每轮新增优惠；任一缺失即不发送 |
| `TELEGRAM_MESSAGE_THREAD_ID` | 可选；把消息发到群组话题 |
| `TELEGRAM_NOTIFY_FAILURES` | 默认 `1`：整轮所有来源失败时也发一条告警 |
| `TELEGRAM_MAX_DEALS` | 单条通知最多列出的新增条数，默认 `10` |

其他配置项见[运维文档](docs/OPERATIONS.md)。

### 登录与退出

启用认证后，首页与数据 API 均要求有效凭据。浏览器在 `/login` 输入令牌，获得有效期 8 小时的签名会话，cookie 带 `HttpOnly`、`SameSite=Strict`，生产默认带 `Secure`。仅使用 HTTP 的本机生产环境也需显式设置 `PERKRADAR_SECURE_COOKIE=0` 才能使用网页登录；公网保持开启。脚本使用 Bearer 请求头，不受 cookie 设置影响。

令牌从客户端的安全配置读取，例如在已设置环境变量的终端中检查健康状态：

```bash
curl -fsS -H "Authorization: Bearer $PERKRADAR_ACCESS_TOKEN" http://127.0.0.1:38471/api/health
```

不要将真实令牌写入 URL、源码或公开输出。

PerkRadar 没有独立的多用户账号系统。“退出”清除本浏览器的会话 cookie；要使所有旧会话失效，需更换访问令牌并重启应用。登录尝试使用进程共享限额，每分钟最多 10 次。

### TLS 反向代理

宿主机上的 Caddy 可使用以下配置，其中域名须替换为实际域名，并正确配置 DNS 和证书申请所需的网络访问：

```caddyfile
perks.example.com {
    reverse_proxy 127.0.0.1:38471
}
```

仅向公网开放反向代理的端口，保留应用的回环绑定和 Secure cookie。`TRUST_PROXY_HEADERS` 默认关闭，仅在代理会覆盖客户端转发头时开启。部署边界见 [SECURITY.md](SECURITY.md)。

## 页面能做什么

- 按标题搜索，使用字面包含匹配
- 按来源和分类筛选，并支持排序
- 查看本轮新增
- 收藏条目、标记已领
- 打开规范化后的原文链接
- 手动触发刷新，并查看刷新冷却、来源成功数和异常提示
- 查看当前在架条目、最近一轮状态、逐来源结果和数据新鲜度

首页默认显示全部分类。可取消“查看全部线索”来隐藏“其他”；搜索、显式选择“其他”或“我的收藏”时不隐藏。重置恢复显示全部；迁移用户保留已保存的展示偏好。每次渲染 100 条，可继续加载，提示当前范围。

收藏与已领状态只保存在当前浏览器的 `localStorage`：

- `perkradar-personal-v1`：`{ "claimed": string[], "favorites": string[] }`
- `perkradar-show-all-v1`：是否显示“其他”线索

新键不存在时会读取旧 `daily-deals-*` 键，并尝试迁移到新键；旧键保留，不会被删除。后续操作只写入新键，回退旧版前端时不会自动同步迁移后的新增收藏和已领状态。收藏或已领状态保存失败时，页面明确提示，本次操作只保留在当前页；展示偏好或自动迁移写入失败时，也不保证刷新后保留。

这些状态不会上传到服务端，也不会写入 SQLite，并且按浏览器站点隔离。更换协议、域名或端口后不会自动迁移；清除浏览器站点数据会清除它们。

## 数据来源与处理方式

当前使用七个固定来源。来源地址写在 [`src/lib/source-defs.ts`](src/lib/source-defs.ts) 中，应用调用方不能替换。

| 来源 | 格式 | 主要规则 |
| --- | --- | --- |
| LINUX DO 福利羊毛 | 经 Jina 转换的 Markdown | 解析福利区主题标题、主题链接和 RFC822 日期 |
| V2EX 推广 | Atom | 使用 `promotions.xml`，去掉链接中的 `#reply0` |
| Epic | JSON | 只收录当前时间处于促销窗口内、折扣价为 0 的促销 |
| NodeSeek | RSS / Atom | 收录允许域名内的 feed 条目 |
| 小众软件 | RSS / Atom | 收录允许域名内的 feed 条目 |
| 果核剥壳 | RSS / Atom | 收录允许域名内的 feed 条目 |
| 异次元软件世界 | RSS / Atom | 请求会跟随重定向到最终地址 |

所有来源的条目都使用 7 天在架窗口：Epic 按促销开始时间计算，其他来源优先使用有效发布日期，缺失时按首次入库时间计算，但不把首次入库时间显示为原文发布时间。RSS / Atom 可使用来源的更新日期等备用字段；LINUX DO 条目缺少可识别的日期字段时会被跳过。条目链接必须位于该来源允许的域名内。每个来源的网络抓取与重试共用 25 秒超时窗口，单个 RSS / Atom feed 最多解析 2000 条，响应大小受限。

来源返回 `429` 或 `503` 时最多额外重试两次，结合指数退避和上游 `Retry-After` 等待；等待过长时推迟到后续轮次，`Retry-After` 最多采信 6 小时。同一来源连续三次网络抓取失败后至少暂停 10 分钟，到期后的下一次抓取再尝试；这些退避状态保存在进程内，重启后重置。

链接会在入库前校验并规范化：只接受 `http` 和 `https`，拒绝过长链接、带 `user:pass@` 凭证的链接和跨来源域名链接。标题最多保存 300 个字符，摘要最多保存 160 个字符；来源没有提供简介时保持为空，不自行补写价格、日期或领取条件。

Epic 条目的 `expiresAt` 来自当前免费促销的结束时间；服务端读取时排除已到期条目，已打开的页面在下一次检查时移除。其他来源没有应用可确认的活动截止时间，`expiresAt` 留空。“近 7 天”表示在架规则，不是活动有效期。

Epic 商品列表为空或结构异常时，本轮该来源记为失败，不按异常结果清空旧条目；旧条目仍受上述在架和到期规则约束。若响应结构正常但没有符合条件的当前免费促销，则同步撤下旧 Epic 条目。其他来源抓取失败也不按失败结果清空已有条目。

Epic 固定归为“游戏”，其他来源按标题信号评分：优惠、限免等明确表达加分，抽奖、求购、二手交易、提问和讨论表达扣分；仍可能误判。“其他”既可能包含非优惠内容，也可能包含未被规则识别的优惠。默认读取时重算分类，不改写已有条目；设置 `PERKRADAR_STORED_CATEGORIES=1` 可使用数据库中保存的分类。来源边界见 [docs/SOURCES.md](docs/SOURCES.md)。

## 刷新和新鲜度

调度器运行在常驻 Node 进程内，正常抓取间隔为 2 小时。首次启动或上次轮次已超期时，约 4 秒后抓取一次当前数据；未超期则等待剩余间隔。每 20 秒检查到期时间并续租，机器休眠跨过到期时间后，在恢复运行的下一个检查点补抓一轮。不会重放所有错过的轮次，也不能恢复上游已经滚出的内容。

SQLite 调度租约有效期为 90 秒。租约被其他进程持有时，本进程仍可提供页面，只暂停定时抓取并继续尝试获取租约；前一个进程被强杀后，需等待剩余租约过期再接管。这是单机单实例部署的保护措施，不支持跨主机共享 SQLite 或多副本部署。

- 停止进程、关闭 Docker 或让电脑休眠时，抓取会停止
- 全部来源失败或调度任务抛错时，安排提前重试：初始等待 10 分钟，连续失败时翻倍，上限为正常的 2 小时间隔；已有刷新在运行时约 60 秒后再试
- 手动刷新和定时刷新共用进程内锁及 SQLite 轮次租约，失效持有者不能提交结果
- 手动刷新有 60 秒冷却；默认所有请求共享每 10 分钟 8 次的尝试限额。仅当 `TRUST_PROXY_HEADERS=1` 且代理可信时，才按转发 IP 分别计数。限流状态在进程重启后重置
- 最近一轮超过 2.5 小时会标记为过时，超过 4 小时会标记为严重过时
- 程序不会发送邮件、聊天消息或系统通知

`/api/health` 的 `ok: true` 只表示能读取数据库。`freshness` 按最近一轮的结束时间计算，即使该轮全部失败也会更新时间；尚无已结束轮次时，时间为空，过时标记为 `false`。因此应结合 `sourceHealth`、`failures` 和 `anomalies` 判断抓取状态，不能只看健康状态或更新时间。

`activeCount` 是符合在架规则的全部线索数，包含“其他”；`newCount` 是其中在最近一轮首次入库的数量。它们都不是逐条核实可领取的优惠数量。

## API

数据成功响应和认证接口使用 `cache-control: no-store`；数据库读取失败也明确禁止缓存。

### `GET /api/health`

读取服务和最近一轮抓取状态。数据库不可读时返回 HTTP 503。

```bash
curl -sS http://127.0.0.1:38471/api/health
```

重点字段：

- `ok`：进程是否能读取数据库
- `sourceHealth`：最近一轮成功的来源数和来源总数
- `failures`：最近一轮失败的来源及错误信息
- `fetchedAt`：最近一轮结束时间
- `freshness`：是否过时或严重过时
- `anomalies`：全失败、来源返回 0 条、条数骤降、连续失败达到 3 轮、解析结构异常等提示
- `sources[].quality`：每个来源近期轮次的连续失败数、条数骤降、解析结构异常和简短提醒

### `GET /api/deals`

返回 `BoardState` 和 `pagination: {offset, limit, total, hasMore}`。`offset` 为非负整数，`limit` 为 1–2000 的整数（默认 500）；无效参数返回 `400`，数据库不可读返回 `503`。全局统计不随分页变化。

页面按页读取列表（安全上限 10 万条），可见时每 30 秒读取数据库的最新结果，重新聚焦时立即检查；轮询不触发外部抓取，外部抓取由调度器或“立即刷新”触发。

```bash
curl -sS http://127.0.0.1:38471/api/deals
```

### `POST /api/refresh`

触发一次手动抓取。请求不需要 body。

```bash
curl -sS -X POST http://127.0.0.1:38471/api/refresh
```

常见响应：

| 状态码 | 含义 |
| --- | --- |
| `200` | 本轮已处理并返回看板数据；应继续检查 `roundStatus` 和 `sourceHealth`，来源可以部分或全部失败 |
| `400` | `Content-Length` 声明的请求体大小超过 2048 字节 |
| `401` | 开启访问认证后，缺少有效 Bearer 令牌或会话 |
| `403` | 跨站刷新请求被拒绝 |
| `409` | 已有一轮刷新正在运行 |
| `429` | 仍在冷却期或触发频率限制 |
| `500` | 未分类的刷新错误 |
| `503` | 访问认证配置无效，例如令牌短于 32 字符 |

上述 API 示例适用于未开启认证的本机环境。开启认证后，需携带有效 Bearer 令牌或会话 cookie；所有数据 API 在缺少有效凭据时返回 `401`，认证配置无效时返回 `503`。

### `/api/session`

- `POST`：提交 URL 编码表单，字段名为 `token`。校验成功后设置 8 小时会话并以 `303` 跳转首页；浏览器表单失败时跳回登录页显示原因，脚本请求返回相应 JSON 错误状态。
- `DELETE`：清除本浏览器的会话 cookie，成功返回 `204`。此操作不撤销其他浏览器已持有的签名会话。

登录和退出均检查浏览器请求来源；登录表单实际读取上限为 4096 字节。

## 项目结构

```text
src/
├── app/
│   ├── api/deals/       # 当前条目与看板数据
│   ├── api/health/      # 健康和新鲜度状态
│   ├── api/refresh/     # 手动刷新
│   ├── api/session/     # 登录与退出
│   ├── login/           # 访问令牌登录页
│   ├── demo/            # 仅开发环境的设计预览
│   └── page.tsx         # 正式首页
├── components/
│   ├── deal-board.tsx   # 搜索、筛选、排序、刷新和本地状态
│   └── deal-board.css   # 正式页与 demo 共用样式
├── lib/
│   ├── parse/           # 各来源解析器
│   ├── db.ts            # SQLite 读写
│   ├── refresh.ts       # 抓取编排、锁和失败隔离
│   ├── scheduler.ts     # 启动首轮和定时刷新
│   ├── telegram.ts      # 新增优惠与整轮失败的 Telegram 通知
│   ├── classify.ts      # 标题信号评分与分类
│   ├── filter-deals.ts  # 页面筛选和排序
│   ├── board-view.ts    # 客户端响应校验
│   ├── source-defs.ts   # 固定来源和允许域名
│   └── types.ts         # 看板和来源数据类型
tests/                   # 离线测试和脱敏夹具
docs/                    # 开发、运维、数据质量和来源说明
scripts/                 # 手动抓取报告等维护脚本
data/                    # 本机 SQLite 数据，不提交到 Git
```

## 开发与验证

安装依赖后，按下面顺序执行：

```bash
npm ci
npm test
npm run lint
npx --no-install tsc --noEmit
npm run build
git diff --check
```

测试使用 `tests/fixtures/` 和合成样本，不访问外网，也不写入生产目录 `./data`。`npm run report` 会访问真实来源并写入 `DATA_DIR` 指向的数据库，只应在明确需要实时抓取时使用；不要把它指向正在使用的生产库。

GitHub Actions 在推送 `main`、创建或更新 Pull Request、手动触发时运行常规 CI，使用 Node.js `22.13.0` 和 `24` 检查测试、Lint、类型、构建及生产依赖安全公告。依赖审计使用 npm 官方 registry。实时来源探测使用独立的定时工作流，与离线 CI 分开执行；探测结果反映上游可用性。

页面改动还需验证桌面与手机布局、交互和浏览器错误。详细验收要求见[开发文档](docs/DEVELOPMENT.md)，贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 运维与反馈

SQLite 位于 `./data/deals.db`，WAL 模式下还可能存在 `deals.db-wal` 和 `deals.db-shm`。运行中的数据库不能仅复制主文件备份；启停、日志、一致性备份、恢复与回滚步骤见[运维文档](docs/OPERATIONS.md)。

抓取日志使用 `[deals]` 前缀的单行 JSON，字段说明见[开发文档](docs/DEVELOPMENT.md)。内容错误、失效线索与来源问题可通过仓库的 Issue 模板反馈；安全问题按 [SECURITY.md](SECURITY.md) 报告。

## 文档索引

- [docs/DATA_QUALITY.md](docs/DATA_QUALITY.md)：来源、解析、分类、留存、时效和每轮验收规则
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)：架构、目录、命令、API 字段、日志和视觉验收
- [docs/OPERATIONS.md](docs/OPERATIONS.md)：Docker 启停、排障、备份、恢复和回滚
- [docs/DOKPLOY.md](docs/DOKPLOY.md)：Dokploy Compose 部署、域名、数据卷和 Telegram 通知
- [docs/SOURCES.md](docs/SOURCES.md)：来源清单、字段边界、使用条件和移除渠道
- [CONTRIBUTING.md](CONTRIBUTING.md)：本地准备、测试约定和新增来源要求
- [SECURITY.md](SECURITY.md)：漏洞报告和公网部署边界
- [CHANGELOG.md](CHANGELOG.md)：版本变更记录
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：第三方依赖许可说明
- [AGENTS.md](AGENTS.md)：本仓库维护规则

## 许可证

本项目采用 [MIT License](LICENSE)。你可以自由使用、修改和商用，但需要保留版权与许可证声明。第三方依赖的许可义务见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。来源站点的内容和使用条件不由本仓库的 MIT 许可证覆盖。

## Star History

<!-- star-history:start -->
<a href="https://www.star-history.com/?repos=luobinger/PerkRadar&type=date">
  <img alt="luobinger/PerkRadar Star history" src="assets/star-history/star-history-light.svg?v=602905cda0117f0b" width="800">
</a>
<!-- star-history:end -->
