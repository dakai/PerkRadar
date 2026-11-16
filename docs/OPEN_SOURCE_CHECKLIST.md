# PerkRadar 开源状态清单

> 本文只记录**当前状态**与仍需遵守的判据，不是施工顺序或交付记录。口径：**上传 GitHub 只代表源码公开，不代表网站已公网部署。**
> 维护日期：2026-11-11（北京时间）。具体行为与部署步骤以 [README.md](../README.md) 和当前源码为准。

## 1. 发布与仓库状态

| 项 | 当前状态 |
| --- | --- |
| 公开版本 | `v0.1.0` 的 tag 与 GitHub Release 已于 2026-11-08 17:17（北京时间）发布 |
| 分支 | 默认分支为 `main`；其他分支上的源码与文档不代表已经合并到默认分支 |
| 未发版改动 | 当前源码的未发版变更见 [CHANGELOG.md](../CHANGELOG.md) 的 `[Unreleased]`；包版本不等同于已发布的 tag 或 Release |
| 部署 | 不提供公网服务，默认只监听 `127.0.0.1:38471` |

`package.json` 为 `perkradar@0.2.0`、`license: MIT`。仓库发布状态与工作区改动要分开看：`[Unreleased]` 描述当前源码，不是已发布版本的行为。

## 2. 运行配置与数据兼容

- Compose 项目名与容器名为 `perkradar`，镜像为 `perkradar:local`，容器内端口为 38471。
- 持久化目录为 `./data`，包含 `deals.db` 及 WAL/SHM 文件；数据库表名、列名和 `SOURCE_DEFS` 的 id 应保持兼容。
- 浏览器当前使用 `perkradar-personal-v1` 和 `perkradar-show-all-v1`，兼容读取旧的 `daily-deals-*` 键；不删除旧键，保留 `{ claimed, favorites }` JSON 形状。

判据：升级的停机与备份步骤见 [OPERATIONS.md](OPERATIONS.md)，不能让新旧实例同时使用同一数据库；保留收藏键、快照格式和数据库标识的兼容性。

## 3. 许可与第三方声明

当前齐全：`LICENSE`（MIT）全文、`package.json` 的 `license` 字段、README 许可段落、[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)（生产依赖逐项列名称、版本、许可证、上游地址；开发依赖单列「仅构建期，不随镜像分发」）。`node:sqlite` 是 Node 内置模块，不单独引入第三方许可。

判据：README、`package.json`、`LICENSE` 三处口径一致；`THIRD_PARTY_NOTICES.md` 与 `package-lock.json` 的生产依赖对得上。内容来自第三方站点，其使用条件不受本仓库代码许可覆盖。

## 4. 仓库清洁与忽略规则

`.gitignore` 排除 `/data/`、`*.db*`、`.env*`、`.next/`、`*.tar.gz`、`/deployment-backups/`、`/reports/`、`/snapshots/`、`*.bak`、日志、快照产物，以及本地工具元数据目录。`.dockerignore` 排除 `deployment-backups/`、`*.tar.gz`、`docs/`、根目录 `*.md`、`scripts/`、`AGENTS.md`、`tests/`、`snapshots/` 等；镜像只带构建必需项（`src/`、`public/`、`package*.json`、`next.config.mjs`、`tsconfig.json`、`postcss.config.mjs`、`eslint.config.mjs`、`components.json`），并以 `node`（uid 1000）非 root 运行。

`tsconfig.json` 与 `eslint.config.mjs` 都排除 `deployment-backups/`：那里有旧的 `next.config.ts`，会被 `include: **/*.ts` 扫到。部署包应保持为 tar，不展开到项目树里。

判据：`git ls-files` 不含数据库与 WAL/SHM、`*.tar.gz`、`deployment-backups/`、`reports/`、`*.bak`、快照产物；`COPY . .` 后的镜像里没有 tar 包与备份目录；全新克隆里没有 `./data`。凭证扫描由 [.github/workflows/secret-scan.yml](../.github/workflows/secret-scan.yml) 在 push、PR 与每日定时执行（gitleaks 全历史扫描），不依赖人工记忆。

## 5. 对外说明与文档

README 首屏明确：定位是「多来源优惠线索聚合」，不是逐条认证的领取平台；条目只代表 feed 里有这条，不代表活动仍有效、条件已核实或账户里真有额度。并写明 6 个来源及其形态、标题信号分类会误判、综合源仍可能收录闲聊 / 求购 / 抽奖 / 推广、除 Epic 的当前免费促销外 `expires_at` 为空、调度恢复只补一轮而不重放全部错过的轮次、`ok: true` 只证明能读库、默认 loopback、上传 GitHub ≠ 已部署。

界面文案：顶部为品牌和「立即刷新」，开启访问认证时增加「退出」；搜索、排序、来源、分类、收藏、运行状态与逐源结果在左侧状态区和提示区；「信息列表」标题行右侧是「查看全部线索」与「只看新增」两个开关，并显示可见条数与「已隐藏 N 条「其他」线索」；卡片只保留标题、收藏文字按钮、摘要框、原文信息、标签、「打开原文」与「标记已领」。浅色底、`RGB(20,148,130)` 小面积强调，未实现深色模式，系统字体、不加载外部字体或 CDN；正式页与本地 dev 预览 `/demo` 共用 `src/components/deal-board.css`，`/demo` 是 7 条示例的设计预览（1 条「其他」默认隐藏，「只看新增」仍为 3 条），生产镜像不含 `/demo`，提供正式首页、登录页和数据 / 认证 API。页面持续可见地说明条目来自公开订阅源、只是线索、未核实有效性 / 条件 / 能否领取。客户端 `src/lib/board-view.ts` 校验接口响应与 SSR 快照；本地状态写入失败、轮询失败、空库、筛选为空，以及刷新 429 / 断网 / 畸形响应各有区分提示。

正式页首次访问默认显示全部分类；关闭「查看全部线索」后，仅在「全部」且无搜索词时隐藏「其他」。显式选「其他」分类、「我的收藏」或搜索时不隐藏，重置恢复显示全部。展示偏好使用 `perkradar-show-all-v1`，个人状态使用 `perkradar-personal-v1`，兼容读取旧 `daily-deals-*` 键；不删除旧键，不改变 `{ claimed, favorites }` 形状。后续操作只写新键，旧前端不会自动看到迁移后的新增状态；浏览器存储失败时不保证刷新后保留。隐藏只作用于展示，不改收录规则或数据库。

界面验收的判据写在 [CONTRIBUTING.md](../CONTRIBUTING.md)「改动流程」与 [DEVELOPMENT.md](DEVELOPMENT.md)「视觉验收」：命令检查用 `npm test` / `npm run lint` / `tsc --noEmit` / `npm run build`，视觉检查覆盖 1440 / 1280 / 390 宽度、控制台报错、失败请求与横向溢出，交互覆盖首次默认显示全部、关闭开关后隐藏「其他」、搜索例外、只看新增组合、显式选分类、重置与刷新后状态保留。单次验收记录属本地产物，不写进公开文档。

维护入口齐全且互相引用一致：[README.md](../README.md)、[DEVELOPMENT.md](DEVELOPMENT.md)、[OPERATIONS.md](OPERATIONS.md)、[DATA_QUALITY.md](DATA_QUALITY.md)、[SOURCES.md](SOURCES.md)、[CONTRIBUTING.md](../CONTRIBUTING.md)、[SECURITY.md](../SECURITY.md)、[CHANGELOG.md](../CHANGELOG.md)、问题模板与 [AGENTS.md](../AGENTS.md)。

判据：对外文档里没有本机运行数字、本机绝对路径、某次会话的施工记录或「已上线」表述；错报 / 失效 / 来源失效 / 新来源申请都有可直接使用的提交路径。

## 6. 持续集成与依赖审计

- `.github/workflows/ci.yml`：推送 `main`、Pull Request 或手动触发；Node `22.13.0` / `24` 矩阵运行 `npm ci`、离线测试、Lint、类型检查、生产构建与官方 registry 的生产依赖审计。仅推送其他分支不会自动触发这套 CI。
- `.github/workflows/live-sources.yml`：`workflow_dispatch` + `schedule`（cron 用 UTC，`23 4 * * *` 即北京时间 12:23），单独运行、写临时 `DATA_DIR`、设 `DISABLE_SCHEDULER=1`，不进入 PR 必过项。
- 三个 workflow 都声明 `permissions: contents: read`。
- `.github/workflows/secret-scan.yml`：`checkout` 带 `fetch-depth: 0`，安装固定版本并校验 sha256 的 gitleaks CLI，扫描 push / PR / 每日定时的全部可达提交；发现凭据即让检查失败。不用 action 封装，避免它依赖 push 事件的 before/after SHA 在强推后失效。
- `package.json` 声明 `engines.node >=22.13`。Next 锁定为 15.5.29，ESLint 为 9；具体依赖解析以 `package-lock.json` 为准。

依赖审计结果以本次命令输出为准，不固化某一次的告警数量。CI 已显式指定官方 registry；本机 npm 镜像若不支持 audit 端点，本地复查应加 `--registry=https://registry.npmjs.org`。测试项数以 `npm test` 输出为准，不写进文档。

判据：锁文件变更后必须重跑审计，不沿用任何一次历史结果；断网或上游 500 时 PR 检查靠固定样本仍全绿；实时源检查失败不阻塞合并；CI 日志能区分「测试失败」与「上游不可达」。

## 7. 数据质量与来源合规

6 个固定来源，URL 写死在 `src/lib/source-defs.ts`，调用方不能替换；LINUX DO 走现有 Jina 地址，V2EX 用复数 `promotions.xml`。每源有一份允许域名（含子域），条目链接不在本源域名内会被丢弃并记 `offsite_link_dropped`。收录语义是「线索聚合、非优惠清单」：综合源按 7 天窗口收录，闲聊、求购、抽奖、推广会进入列表，分类误判是已知行为。反例测试覆盖闲聊、求购、抽奖、过期、未来促销、长期免费本体、限时礼包与空结果，并允许结果为空、不拿普通帖子补数量。

分类里的「其他」只表示标题没命中优惠关键词，是线索聚合下的兜底标签，**不是优惠判定，也不代表已排除优惠**：与羊毛优惠无关的闲聊帖同样会归到这里。正式页保留「查看全部线索」开关，关闭后按 §5 的规则隐藏「其他」，见 [§5 界面文案](#5-对外说明与文档)、[DATA_QUALITY.md](DATA_QUALITY.md) 与 [README.md](../README.md)；隐藏只改展示，收录规则、分类规则与数据库都不变。是否在入库时收紧关键词、从源头少收这类闲聊帖，是**尚未实施的后续选项**：它会改变 7 天窗口下的收录语义与在架条数，需同步改 `src/lib/classify.ts`、对应测试与 [SOURCES.md](SOURCES.md) 的收录说明；当前收录规则保持不变。

[SOURCES.md](SOURCES.md) 记录各源使用条件核查结论与核查日期（**未完成逐站书面核查**），不把「公开可访问」等同于可任意再分发；单独标注 LINUX DO 经第三方代理、Epic 使用静态后端端点两处风险，并提供移除与纠错渠道。新增来源必须按 [CONTRIBUTING.md](../CONTRIBUTING.md) 提供证据清单。

判据：`src/lib/source-defs.ts` 与各文档逐项一致；仓库与测试夹具内不存第三方正文全文；每源有「使用条件核查结论 + 核查日期」。

## 8. 可观测性

`freshness` / `anomalies` 已在 `/api/health` 与页面实现：最近一轮结束超过 2.5 小时为 stale、超过 4 小时为 severe，并提示上一轮全失败、某源成功但 0 条、某源解析条数骤降。**但程序不会主动发送邮件或聊天通知**，提示只出现在 API 与页面上。

结构化日志统一前缀 `[deals] {"event":...,"at":ISO,...}`，成功走 stdout、失败走 stderr，不含标题正文、Cookie、请求头或个人状态；`source_round.reason` 把失败归到 `timeout` / `http_status` / `response_too_large` / `malformed_response` / `unknown`。事件与字段清单见 [DEVELOPMENT.md](DEVELOPMENT.md)「结构化日志」，用 `docker compose logs` 查看。

判据：日志能回答「哪一轮、哪个源、耗时多少、为什么失败」；每轮验收清单见 [DATA_QUALITY.md](DATA_QUALITY.md)。

## 9. 默认安全与部署边界

- 端口绑定只有 `127.0.0.1:${HOST_PORT:-38471}:38471`，不改 `0.0.0.0`。容器非 root，`./data` 须对 uid 1000 可写，不用 `chmod 777` 绕过。
- 设置至少 32 字符的 `PERKRADAR_ACCESS_TOKEN` 后，首页和数据 / 刷新 API 要求 Bearer 令牌或签名会话；未配置仅适用于可信本机。保留同源校验、60 秒刷新冷却、每 10 分钟 8 次的进程内尝试限额；默认共享限额，仅在可信转发头开启时按 IP 区分。登录另有每分钟 10 次的进程共享限额。
- 客户端 IP 默认忽略 `x-forwarded-for` / `x-real-ip`（一律归 `local`），只有 `TRUST_PROXY_HEADERS=1` 时才信任转发头；只在确有可信反向代理时开启。数据成功响应、认证响应及数据库读取失败响应禁止缓存；各接口的具体边界见 README。

判据：公网使用 TLS 反向代理，并开启应用访问认证、保持 Secure cookie；不要直接暴露应用端口，也不要把 Jina key 当作本应用的访问令牌。详见 [SECURITY.md](../SECURITY.md)。

## 10. 已知限制（仍然存在）

- 不提供公网服务；**上传 GitHub ≠ 已部署**。
- 单机单实例常驻进程，使用 SQLite 租约防止重复调度；休眠、关机、容器停止都会暂停抓取，恢复时只补一轮，不重放全部错过的轮次。
- 除 Epic 的当前免费促销外没有真实截止时间；「近 7 天」是留存规则，不是活动截止日。
- 新鲜度与异常只在 API 与页面提示，不主动发送通知。
- 公开快照在本机 Compose 默认关闭；外部推送渠道不属于本仓库，不与本机库同步。
- 收藏与已领只在这台浏览器；关键词分类会误判，线索聚合而非逐条认证。
- 规范化 URL 仍不统一 `www.` 前缀、http/https 与路径大小写，这是已知边界。

## 11. 全局纪律（承接 [AGENTS.md](../AGENTS.md)）

- 不把没抓到的写成抓到，不把测试夹具写进 `./data`，不把闲聊、新闻、抽奖或条件不明的标题说成已核实可领，不把在架条数当成官方确认。
- 不自动注册付费服务、不擅自更换抓取源、不直连 `linux.do`、不绕过站点挑战；来源 URL 以 `src/lib/source-defs.ts` 为准。
- 不删除 `./data`，不清理浏览器里的 `daily-deals-personal-v1`。
- 只操作本项目：不对其他目录 `docker compose down`，不 `docker system prune`，不动其他容器、端口与卷。
- 每次改代码都实跑测试、lint、build；动到页面要在 1440 / 1280 / 390 宽度下看真实数据。**没跑过的检查不写成已通过**；生产镜像是否重建，以本机 `docker compose` 结果为准。
- 本机运行数字属瞬态，不写进公开文档或 Release notes。
