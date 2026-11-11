# 在 Dokploy 上部署

本文件描述用 Dokploy 的 Docker Compose 应用部署 PerkRadar 的当前做法。仓库根目录的 `docker-compose.dokploy.yml` 是唯一入口；本地运行仍用 `docker-compose.yml`。两者都在容器内监听 `38471`，区别在于端口发布、数据卷和环境变量来源。

Dokploy 负责 TLS、域名和反向代理；应用本身不需要改监听地址，也不需要额外的 Caddy/Nginx。PerkRadar 是单实例应用：SQLite 只在一台机器的一个可写卷上，两小时的抓取轮次由进程内调度器执行。不要把副本数调到 2 以上。

## 文件

| 文件 | 用途 |
| --- | --- |
| `docker-compose.dokploy.yml` | Dokploy 应用使用的 Compose 文件；构建镜像、挂载数据卷、接入 `dokploy-network` |
| `deploy/dokploy.env.example` | 环境变量模板，复制到 Dokploy 的 Environment 面板，不要提交真实值 |
| `.github/workflows/dokploy.yml` | 可选：用 Dokploy 部署 Webhook 触发重新部署 |

## 前置条件

- 一台已安装 Dokploy 并完成初始化的服务器。
- 一个域名，DNS 已指向该服务器；Dokploy 默认用 Traefik 申请 Let's Encrypt 证书。
- Dokploy 能拉取本仓库（GitHub App 或访问令牌）。
- 服务器到 `r.jina.ai`、各来源站点和 `api.telegram.org` 的出站网络可用。

## 1. 创建应用

1. 在 Dokploy 新建 Project，再新建一个 **Docker Compose** 类型的服务。
2. 仓库选择 `dakai/PerkRadar`，分支按需要选择（生产通常为 `main`）。
3. Compose Path 填 `docker-compose.dokploy.yml`。
4. 构建方式保持 Compose 默认：文件里的 `build:` 会用仓库根目录的 `Dockerfile` 构建多阶段镜像。

不要改用 Nixpacks/Heroku 构建器，本仓库依赖 `Dockerfile` 里的 `npm ci`、`next build` 和 `scripts/serve.mjs`。

## 2. 环境变量

在应用的环境变量面板填入下表。模板见 `deploy/dokploy.env.example`。

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `PERKRADAR_ACCESS_TOKEN` | 是 | 共享访问令牌，至少 32 个字符的随机值。缺失时 Compose 拒绝渲染；少于 32 字符时应用拒绝所有请求 |
| `PERKRADAR_SECURE_COOKIE` | 是 | 保持 `1`。Dokploy 终止 HTTPS，浏览器会话必须带 `Secure` |
| `JINA_API_KEY` | 否 | LINUX DO 来源使用的 Jina 凭据；不配置时匿名请求可能被限流 |
| `TELEGRAM_BOT_TOKEN` | 否 | Telegram 机器人令牌；与 chat id 同时存在才启用通知 |
| `TELEGRAM_CHAT_ID` | 否 | 私聊、群组或频道的 chat id，群组通常以 `-100` 开头 |
| `TELEGRAM_MESSAGE_THREAD_ID` | 否 | 群组里的话题编号；普通会话留空 |
| `TELEGRAM_NOTIFY_FAILURES` | 否 | 默认 `1`：整轮所有来源失败时发一条告警；`0` 关闭 |
| `TELEGRAM_MAX_DEALS` | 否 | 一条通知最多列出多少条新增优惠，默认 `10`，范围 1–50 |
| `TELEGRAM_TIMEOUT_MS` | 否 | 发送超时，默认 `8000`；通知失败不会影响抓取结果 |

生成令牌时不要打印到屏幕或聊天窗口：

```bash
openssl rand -hex 32
```

把输出直接粘贴到 Dokploy 的变量值里。更换令牌会使所有已登录会话失效。

## 3. 域名

1. 在应用的 Domains 里新增域名，Service 选 `web`，Container Port 填 `38471`。
2. 开启 HTTPS，证书提供方选 Let's Encrypt。
3. 不要给 `web` 添加宿主端口映射。Compose 文件只声明 `expose`，公网流量由 Dokploy 的 Traefik 转发。

`docker-compose.dokploy.yml` 已把 `web` 接入外部的 `dokploy-network`。如果部署日志出现 Traefik 找不到服务或 502，先确认服务实际连上了这个网络：

```bash
docker network inspect dokploy-network --format '{{range .Containers}}{{.Name}} {{end}}'
```

## 4. 首次部署验证

部署完成后，用令牌检查健康状态（把域名替换成实际值）：

```bash
curl -fsS -H "Authorization: Bearer $PERKRADAR_ACCESS_TOKEN" https://perks.example.com/api/health
```

- HTTP 200 且 `ok` 为 `true`，说明进程和数据库都可用。
- 首次启动没有历史轮次时，调度器约 4 秒后跑第一轮；已有历史时按最后完成时间补足间隔，最多补一轮。
- `/api/deals` 返回 200 且 `deals` 非空即表示抓取写入正常；来源成败看 `sourceHealth` 和 `failures`。

在 Dokploy 的 Logs 面板里，日志是 `[deals]` 前缀的单行 JSON。正常一轮能看到 `round_start`、`round_finished` 和逐源 `source_round`；通知成功时还有 `telegram_notified`。

## 5. 数据持久化与备份

容器把 SQLite 写到 `/data`，对应命名卷 `perkradar-data`。重新部署、重启容器和回滚镜像都不会删除这个卷；只有在 Dokploy 里显式删除服务并勾选删除卷时才会丢掉数据。

不要同时运行两个实例或两个副本指向同一个卷。SQLite 的 WAL 不适合多主机或网络文件系统；调度器和刷新各自有租约，但那只防止重复抓取，不替代单实例约束。

停机备份（先停止应用，保证 WAL 已合并）：

```bash
docker volume ls | grep perkradar
docker run --rm -v <项目名>_perkradar-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/perkradar-data.tgz -C /data .
```

在线备份、恢复和一致性要求见 [OPERATIONS.md](OPERATIONS.md)。备份文件包含公开抓取数据，不包含访问令牌或 Telegram 凭据。

## 6. Telegram 通知

通知在每轮刷新成功提交之后发送，属于尽力而为：Telegram 不可达、令牌错误或消息被拒时只记录日志，不会回滚本轮数据，也不会让刷新接口失败。

### 创建机器人并取得 chat id

1. 在 Telegram 里找 `@BotFather`，执行 `/newbot`，记下返回的令牌。
2. 把机器人加入目标群组或频道（频道需要管理员权限），或直接私聊它。
3. 在目标会话里发一条消息，然后读取更新：

```bash
curl -sS "https://api.telegram.org/bot<令牌>/getUpdates"
```

在返回 JSON 里找 `message.chat.id`。私聊是正数，群组/频道通常是 `-100` 开头的负数。不要把带令牌的 URL 贴进聊天、Issue 或日志。

### 发送规则

- 本轮有新条目：一条摘要，列标题、分类、来源和原文链接；超过 `TELEGRAM_MAX_DEALS` 的部分只报数量。
- 本轮没有新条目：不发送，避免每两小时一条空消息。
- 整轮所有来源失败：发一条告警，列出可用来源数和各来源原因；`TELEGRAM_NOTIFY_FAILURES=0` 可关闭。
- 长摘要会拆成多条消息，每条都低于 Telegram 的 4096 字符上限，并重复标题行。
- 只发送公开的标题、分类、来源和链接。访问令牌、Cookie、收藏和已领状态不会进入消息。

配置后重新部署，点页面上的「立即刷新」或调用 `POST /api/refresh`，然后在日志里确认 `telegram_notified`（`sent` 为实际送达条数）。临时关闭通知：删除 `TELEGRAM_BOT_TOKEN`，或设置 `TELEGRAM_DISABLE=1`。

## 7. 更新与回滚

- 启用了 Dokploy 的 GitHub 自动部署时，推送即触发重新构建。
- 或者使用仓库里的 `Deploy to Dokploy` 工作流：在 GitHub 仓库 Secrets 里加 `DOKPLOY_DEPLOY_WEBHOOK`（Dokploy 应用页面提供的部署 Webhook 地址），之后手动触发或推送到 `main`。未配置该 Secret 时工作流直接跳过。
- 回滚使用 Dokploy 的部署历史，选择上一版本重新部署；命名卷保持不动。
- 数据库 schema 只会向前迁移。回滚到更旧的镜像前，先确认该版本的 schema 版本要求，并按 [OPERATIONS.md](OPERATIONS.md) 回滚源码与数据。

## 8. 常见问题

| 现象 | 排查 |
| --- | --- |
| `/api/health` 返回 401/403 | 请求没带 Bearer；或 `PERKRADAR_ACCESS_TOKEN` 少于 32 字符，应用会拒绝所有访问 |
| 页面能开但 502 | 容器未通过健康检查；确认服务端口是 `38471`、域名绑定到 `web`、服务已加入 `dokploy-network` |
| 健康检查一直失败 | 看容器日志是否有数据库不可读或构建产物缺失；首次部署要等镜像构建完成 |
| 日志出现 `database is locked` | 同一卷被两个进程或副本同时写入；保持单实例 |
| 收不到 Telegram | 令牌或 chat id 缺失、机器人未加入会话、频道未给管理员权限、本轮没有新增条目 |
| 日志有 `telegram_send_failed` | 看 `error` 字段的 Telegram 描述；常见是 chat 不存在、机器人被踢出或消息格式被拒 |
| 定时抓取停了 | 服务器休眠、容器被手动停止或 `DISABLE_SCHEDULER=1`；`restart: unless-stopped` 只在 Docker 仍运行时拉起容器 |
| 重新部署后日志消失 | 容器日志按 10 MB × 3 轮转；需要留档时先导出，持久数据在 `/data` 卷里 |

## 9. 与本地 Compose 的差别

| 项目 | `docker-compose.yml` | `docker-compose.dokploy.yml` |
| --- | --- | --- |
| 端口 | 发布到 `127.0.0.1:${HOST_PORT:-38471}` | 仅 `expose 38471`，由 Dokploy 反向代理 |
| 网络 | 默认 bridge | 外部 `dokploy-network`，供 Traefik 发现 |
| 数据 | 宿主 `./data` 绑定挂载 | 命名卷 `perkradar-data` |
| 环境变量 | 根目录 `.env`（可选） | Dokploy 环境变量面板 |
| 访问令牌 | 可留空（仅限可信本机） | 必填，Compose 缺少时拒绝渲染 |
