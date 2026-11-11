# 运维

命令都在项目目录执行，并且只带 `-p perkradar`。不要对其他目录 `docker compose down`，不要 `docker system prune`，不要 `docker compose down` 不带项目名。默认只把端口发布到 `127.0.0.1`，不是公网。

本文针对本机 Compose 部署。用 Dokploy 托管时，域名、TLS 和命名卷由平台负责，步骤见 [DOKPLOY.md](DOKPLOY.md)。

机器休眠、关机、Docker Desktop 没启动，或这个容器被 stop，抓取都会停。`restart: unless-stopped` 只在 Docker 自己还在运行、且容器不是被手动 stop 时拉起它。

## 日常命令

```bash
docker compose -p perkradar config --quiet
docker compose -p perkradar up -d --build
docker compose -p perkradar ps
docker compose -p perkradar logs -f --tail=200
docker compose -p perkradar restart
docker compose -p perkradar stop
docker compose -p perkradar start
```

`config` 用来检查这次会使用的项目名、端口和卷，不会启动容器。`up -d --build` 构建镜像并启动。容器名是 `perkradar`，镜像名是 `perkradar:local`。宿主目录 `./data` 挂到容器内 `/data`。SQLite 文件是 `./data/deals.db`，WAL 模式下旁边还可能有 `deals.db-wal` 和 `deals.db-shm`。

容器以镜像内置的 `node` 用户（uid 1000）运行，不是 root。`./data` 是宿主 bind mount，该 uid 必须能创建并写入上述三个文件。换到 uid 映射不同的宿主时，先确认 `./data` 对 uid 1000 可写，否则健康检查会返回 503「数据库不可读」。不要用 `chmod 777` 绕过权限。

访问：

```bash
curl -sS http://127.0.0.1:38471/api/health
curl -sS http://127.0.0.1:38471/api/deals
curl -sS -X POST http://127.0.0.1:38471/api/refresh
```

这些 `curl` 命令不带 `Origin`，而刷新接口对不带 `Origin` 的请求仍放行，所以本机排障能直接触发手动刷新；带 `sec-fetch-site: cross-site` 或与 `Host` 不符的 `Origin` 才会被拒绝 403。接口防护细节见 [SECURITY.md](../SECURITY.md)，结构化日志见 [DEVELOPMENT.md](DEVELOPMENT.md)。

若 38471 已被别的程序占用，只改宿主端口，不要改容器内端口，也不要去停别的项目：

```bash
HOST_PORT=38481 docker compose -p perkradar up -d --build
curl -sS http://127.0.0.1:38481/api/health
```

健康检查在容器内请求 `http://127.0.0.1:38471/api/health`，每 30 秒一次，超时 5 秒，重试 3 次，启动宽限 60 秒。它通过只说明 HTTP 成功，也就是数据库还能读。

同一时间只运行这一个应用进程。指向同一个 `./data` 的第二个新版进程拿不到调度租约，会待命不抓取；但旧版镜像不认这个租约，新旧混跑仍会各自抓取并抢同一个 SQLite 文件。

## 排障

| 现象 | 先看什么 |
| --- | --- |
| 浏览器打不开 | `docker compose -p perkradar ps`。Docker 是否启动。端口是否用了 `HOST_PORT`。只应访问 `127.0.0.1` |
| 健康 503，`数据库不可读` | `./data` 是否存在、当前用户能否写。不要删库；先按下面备份，再看权限。读库失败会记 `health_check_failed` / `deals_read_failed` 日志；`GET /api/deals` 同样会返回 503 `数据库不可读` |
| 来源失败或超时 | `/api/health` 的 `failures`，以及 `docker compose -p perkradar logs` 里 `[deals]` 的 `source_round.reason` 与 `error`。25 秒超时记为「超时」（`timeout`）；HTTP 错误状态（`http_status`）、响应过大（`response_too_large`）、格式 / 解析错误（`malformed_response`）各有分类。LINUX DO 格式不对会写明可能被阻断。不要改去直连 |
| 想按轮次看完整日志 | 用 [DEVELOPMENT.md](DEVELOPMENT.md)「结构化日志」里按 `roundId` 过滤的命令；`at` 是 UTC，页面时间是北京时间。`up -d --build` 重建容器后旧日志不可见，留档要先导出 |
| 某源 0 条但 `lastOk` 为真 | 这次 feed 解析结果是空的，旧行是否还在由 7 天和到期规则决定 |
| 页面时间看起来差 8 小时 | 页面标签按 `Asia/Shanghai` 格式化。容器未设置 `TZ`，库内是 Unix 毫秒。先对照 `fetchedAt` 和 `fetchedAtBeijing`，不要只看容器 `date` |
| 手动刷新 409 | 已有一轮在跑，等它结束 |
| 手动刷新 429 | 60 秒冷却，或同一 IP 10 分钟超过 8 次 |
| 手动刷新 403 | `sec-fetch-site: cross-site`，或 `Origin` 的主机与 `Host` 不一致。本机 `curl` 不带这些头，不受影响 |
| 重启后很快又抓了一轮 | 这是未设置 `DEALS_SKIP_BOOT` 时的正常行为，见 [DATA_QUALITY.md](DATA_QUALITY.md) |
| 停机几小时后只多了一轮 | 代码不会把错过的每 2 小时都补抓一遍 |
| 日志里有 `scheduler_lease_waiting`，页面能开但不抓取 | 调度租约在别的持有者手里。刚强杀/崩溃重启时最多等 90 秒会出现 `scheduler_lease_acquired`；一直不出现说明还有另一个实例在用同一个 `./data` |
| 全部来源失败后很快又抓了一轮 | 正常：全失败的一轮 10 分钟后重试（`scheduled_refresh_retry`），连续失败间隔翻倍，封顶 2 小时 |
| 登录后又被送回登录页 | 公网必须经 TLS 代理访问：生产默认 Secure cookie，纯 HTTP 下浏览器不会带上它。会话 8 小时过期，换令牌也会让旧会话失效 |

构建日志里若再出现安装 TypeScript，说明镜像又在用 `next.config.ts`。当前仓库使用 `next.config.mjs`，启动不应为了配置文件联网安装依赖。

## Telegram 通知

刷新轮次提交成功后，进程可能发送一条 Telegram 消息。它是尽力而为的外部调用：未配置、超时、Telegram 返回错误都只记日志，不会回滚本轮数据，也不会让 `/api/refresh` 失败。

- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`：两者同时存在才启用。缺失任一项时不发请求。`TELEGRAM_DISABLE=1` 可临时关闭而不用删掉变量。
- `TELEGRAM_MESSAGE_THREAD_ID`：群组话题编号，普通会话留空。
- `TELEGRAM_NOTIFY_FAILURES`：默认开启；整轮所有来源失败时发一条告警。没有被分类为优惠的新条目且本轮未全失败时不发送。
- `TELEGRAM_MAX_DEALS` / `TELEGRAM_TIMEOUT_MS`：单条通知最多列出的新增条数（默认 10）和发送超时（默认 8 秒）。
- 只推送被分类为优惠的新条目。「其他」分类的资讯、软件更新、求助和二手交易不推送，与看板默认视图一致；整轮只有这类条目时记 `telegram_skipped`。

相关日志事件：`telegram_notified`（含 `roundId`、过滤后的 `newDeals`、`skipped`、`messages`、`sent`）、`telegram_skipped`（整轮没有可推条目）、`telegram_send_failed`（含 HTTP 状态或 Telegram 描述）、`notification_failed`（通知函数本身抛错）。日志不写令牌、chat id 和消息正文。

消息只包含公开字段：标题、分类、来源、原文链接，以及本轮可用来源数。收藏和已领状态保存在浏览器，不会进入通知。想验证配置是否生效，调一次 `POST /api/refresh`，再看日志里的 `telegram_notified.sent`。

Dokploy 上的配置步骤见 [DOKPLOY.md](DOKPLOY.md)。

## 备份

不要在数据库正在写的时候只复制 `deals.db` 一个文件。WAL 模式下，最新写入可能在 `deals.db-wal` 里，单文件副本会不一致。

### 在线备份

`node:sqlite` 的 `backup()` 可对打开着的 WAL 库生成一致副本：函数返回 Promise，完成后目标文件可以只读打开并读到已写入的行。若对正在服务的库返回 `database is locked`，改用下一节的停机复制。

在项目目录、且本机 Node 提供 node:sqlite backup() 时，可以写到 `./data` 以外的归档目录，避免和活库缠在一起：

```bash
mkdir -p "$HOME/perkradar-archives"
node --experimental-strip-types << 'EOF'
import { DatabaseSync, backup } from "node:sqlite";
const db = new DatabaseSync("./data/deals.db");
await backup(db, process.env.HOME + "/perkradar-archives/deals-online.db");
db.close();
EOF
```

这个命令会打开现有数据库。确认它没有报错之后，再把目标文件改成带日期的名字。不要在同一命令里删除现有的 `deals.db`。

### 停机后复制三个文件

只停止本项目，等容器退出，再复制当时存在的文件：

```bash
docker compose -p perkradar stop
dest="$HOME/perkradar-archives/stopped-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$dest"
cp -p ./data/deals.db "$dest/"
if [ -f ./data/deals.db-wal ]; then cp -p ./data/deals.db-wal "$dest/"; fi
if [ -f ./data/deals.db-shm ]; then cp -p ./data/deals.db-shm "$dest/"; fi
ls -l "$dest"
docker compose -p perkradar start
```

停机后这次复制到 `$dest` 的文件是一套。恢复时使用这一套，不要和更早的备份混放。复制前先 `ls "$dest"`，确认没有盖住另一份备份。

## 恢复

先按上一节再做一份当前库的备份。然后只停止本项目，把现有文件改名留在旁边，而不是删除：

```bash
docker compose -p perkradar stop
mkdir -p ./data/aside-$(date +%Y%m%d-%H%M)
mv ./data/deals.db ./data/deals.db-wal ./data/deals.db-shm ./data/aside-$(date +%Y%m%d-%H%M)/ 2>/dev/null || true
```

若恢复的是 `backup()` 生成的单个文件，把它放到 `./data/deals.db`。不要把旧的 `-wal` 或 `-shm` 留在旁边，否则 SQLite 可能把旧日志应用到新文件上。

若恢复的是停机时复制的三个文件，就把当时存在的那几个文件按原名放回 `./data/`。

```bash
docker compose -p perkradar start
curl -sS http://127.0.0.1:38471/api/health
```

确认条数和更新时间符合预期之前，不要清掉 `aside-*` 目录。

## 回滚镜像和源码

回滚前保留两样东西：当前还能用的镜像，以及当前源码的 tar。镜像可以用本项目的标签另存，例如：

```bash
docker image tag perkradar:local perkradar:before-rollback
```

源码和部署包打成 tar，放在仓库外面，例如 `$HOME/perkradar-archives/`。不要在项目目录里再展开一份旧源码。`tsconfig.json` 的 `include` 含有 `**/*.ts`，`tsconfig.json` 与 `eslint.config.mjs` 现在排除 `deployment-backups/`；但项目树其它位置若留下旧的 `next.config.ts` 或其他 `.ts`，TypeScript 仍会扫到它们。`deployment-backups` 保持为 tar，不要展开后留在项目树里。

回滚源码时只替换有记录的应用文件，不要用旧包覆盖 `./data`、`.env`，或用户后来自己加的文件。换回旧镜像后执行：

```bash
docker compose -p perkradar up -d --build
```

只有在明确要使用 `before-rollback` 这个标签、且 Compose 文件也改回对应构建时，才需要另作镜像标签处理。当前 Compose 固定构建 `perkradar:local`，所以上面的 `up -d --build` 会按当时目录里的源码重新构建。


## 0.2.0 审核修复升级（需要维护者手动确认）

本次改名后的 Compose project/container/image 为 perkradar；原来是 daily-free-info。**不要在旧容器仍运行时直接执行新的 up**，它们会共享 ./data 并冲突。先确认一致性备份，记录旧镜像与数据位置；在计划停机窗口停止旧项目，确认旧进程退出后再用新项目名构建/启动。不要 down -v，不删除 ./data，不混用两套 WAL。需要回滚先停止新实例并恢复升级前一致库与旧源码/镜像。这次代码修改不会自动停止、重建或迁移正在运行的容器。

首次新程序启动会执行 schema v1 的事务迁移，增加租约表、source_runs(source_id,round_id,id) 和 rounds.finished_at 索引，不改优惠正文/URL。旧历史轮次在刷新事务中按 30 天清理，始终保留最近完成轮次。不要将旧程序直接指向升级后的库。

环境变量：
- HOST/PORT：npm 默认 127.0.0.1/38471；容器 HOST=0.0.0.0，但宿主发布仍回环。
- PERKRADAR_ACCESS_TOKEN：可选，至少 32 字符随机值。云部署必须启用；所有数据 API 接受 Bearer，网页登录生成会话。
- PERKRADAR_SECURE_COOKIE：生产默认 1。仅本机纯 HTTP 测试可设 0；公网必须 1，前置 TLS 反向代理。
- PERKRADAR_STORED_CATEGORIES=1：回退到已存分类；默认按新规则读取时重算，不需要改历史数据。
- DEALS_SNAPSHOT_DIR：显式路径才生成快照，不再自动探测任何平台目录。
- PERKRADAR_OFFLINE=1：禁止抓取网络请求，返回离线来源失败；用于隔离测试，生产不要误开。
- DISABLE_SCHEDULER=1：禁用后台调度；DEALS_SKIP_BOOT=1 保留显式跳过启动检查的兼容开关，正常生产不要设置。
- NEXT_DIST_DIR：隔离构建输出，例如 .next-audit；构建和启动必须使用同一值。
- TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID：同时设置后发送每轮新增摘要；任一缺失即不发送。
- TELEGRAM_MESSAGE_THREAD_ID：可选，群组话题编号。
- TELEGRAM_NOTIFY_FAILURES：默认 1，整轮所有来源失败时告警；设 0 关闭。
- TELEGRAM_MAX_DEALS（默认 10）/ TELEGRAM_TIMEOUT_MS（默认 8000）：通知条数上限与发送超时。
- TELEGRAM_DISABLE=1：不发送任何通知，保留其余配置。

健康探测启用认证后必须带 Bearer；Compose 内部探针自动从环境取令牌，不输出它。不要直接执行会打印插值后令牌的 docker compose config；如需校验使用 config --quiet。JINA_API_KEY_FILE 需要在容器内单独只读挂载；读取失败只记录通用告警，不输出路径。密钥仍由用户通过安全渠道配置，不提供真实值示例。

调度启动按最后完成轮次的 startedAt 计算剩余间隔，超期只补一次当前数据；独立 SQLite 租约阻止重复调度及同时刷新；拿不到调度租约不会让进程启动失败，只是待命重试。休眠醒来后按墙上时钟立即补一轮。暂停超过租约期的旧进程不得继续提交旧结果。租约不适用于多主机共享 SQLite。

浏览器新键 perkradar-personal-v1 / perkradar-show-all-v1 自动兼容旧 daily-deals-*，不删除旧键。新页面内存状态在存储失败时仍可用，但不承诺刷新后保留；回退旧前端只读旧状态，不自动同步新前端后续收藏。

令牌的设置方式：由维护者在终端安全生成随机值并导出为环境变量，或使用权限600且不提交的.env传入Compose；不要把值贴入聊天、URL或命令行参数。示例仅生成并赋值，不打印：

```bash
export PERKRADAR_ACCESS_TOKEN="$(openssl rand -hex 32)"
```

保持此值稳定以免每次重启使会话失效；通过安全的凭证管理方式保存，不要在公开终端执行 env/printenv。npm/Compose会从环境接收它，应用源码没有默认令牌。
