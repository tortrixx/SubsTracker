# SubsTracker

> English: [README.md](README.md)

**一个围绕「定时触发」设计的平台——订阅提醒只是它的第一个插件。**

SubsTracker 管理一切周期性截止时间（今天是你的订阅），每小时求值一次提醒规则，并通过 11 个通知渠道发送。它遵循「万物皆插件」的设计：订阅到期是第一个触发源，定时邮件、任务提醒在[路线图](#路线图)里。

同一套 TypeScript 代码、两种运行时：既可以部署到 **Cloudflare Workers + KV**，也可以部署到**自己的 Node 服务器 + SQLite**。存储是可插拔的端口，不是写死的依赖。

## 功能

- **订阅管理**——名称、金额、币种、计费周期（天 / 月 / 年，另支持农历周期）、试用标记、分类、付款记录和带预览及撤销的续期。
- **提醒规则引擎**——每个订阅可配多条规则：到期前 N 天/小时、到期当天或到期后按间隔重复。内置预设：提前 7 / 3 / 1 天 + 当天。
- **全局默认规则可编辑**——新订阅继承的默认规则是正式配置项（`DEFAULT_REMINDER_RULES`），在设置页可改；清空成空集是明确选择，会被如实保存与生效。
- **11 个通知渠道**——邮件、Telegram、企业微信、Bark、NotifyX、Server 酱、PushPlus、ntfy、Gotify、WPush、通用 Webhook。每个渠道有独立配置抽屉、启停开关，发送测试走真实管线。
- **发送时段**——可限制只在选定的小时内发送（按配置时区）；为空表示不限制。
- **日志与健康**——每次发送与每次调度都落日志、可筛选；每页顶部有健康状态（上次整点检查结果）。
- **农历与财务**——农历周期订阅（1900–2100）、多币种金额与月度支出汇总。
- **双运行时、存储可插拔**——Cloudflare KV / SQLite（`node:sqlite`）/ 内存三种实现，统一走 `StoragePort` 接口，带契约校验脚本。

## 快速开始

### 路线 A — Cloudflare Workers

前提：Node.js、Cloudflare 账号、Wrangler（用 `npx` 即可）。

```bash
npm install
npm run deploy:safe   # 先建 KV 命名空间（scripts/setup-kv.cjs），再部署
# 若 KV 已建好：
npm run deploy
```

`wrangler.toml` 的入口是 `src/index.ts`，Wrangler 直接编译 TypeScript，无需预构建。调度由每小时一次的 Cron Trigger 驱动。
配置脚本会保留已有 `SUBSCRIPTIONS_KV` ID 和其他 KV 绑定；遇到重复或无法识别的配置会停止，需先检查。

### 路线 B — 自托管 Node 服务器

前提：**Node.js 24**（SQLite 适配器用内置 `node:sqlite`）。

```bash
npm install
npm run build         # tsc → dist/（视图与 HTML loader 一并复制）
npm start             # 可通过环境变量设置 PORT / HOST / SQLITE_PATH
```

生产环境可直接用仓库自带的 systemd 单元 [`deploy/substracker.service`](deploy/substracker.service)（加固配置、`Restart=always`、读 `substracker.env`）。Node 组合根的调度对齐整点，并提供 `/healthz` 健康检查。

### 路线 C — Docker Compose

执行 `docker compose up -d --build`，访问 `http://127.0.0.1:3200`。SQLite 保存在 `substracker-data` 卷；默认仅本机访问，远程访问请配置反向代理和 HTTPS。`docker compose down -v` 会删除该数据卷。

### 首次登录

用默认账号 **`admin` / `password`** 登录，立刻到**设置 → 账号安全**改密码。所有渠道凭据之后在**渠道**页里配——仓库里不存放任何密钥。

## 配置

运行时配置存在应用自己的存储里、在**设置**页编辑（Node 运行时另有少量进程级变量 `PORT`、`HOST`、`STORAGE_DRIVER`、`SQLITE_PATH`，放在 `substracker.env`）。关键项：

| 配置项 | 说明 |
| --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 管理员账号；首次登录后务必改密码。 |
| `TIMEZONE` | 全部日期、倒计时与发送时段都按此时区解释（如 `Asia/Shanghai`）。只在设置页改，是全站唯一口径。 |
| `APP_URL` | 本部署的公网地址。配置后，通知邮件会带「打开订阅管理」按钮。 |
| `NOTIFICATION_HOURS` | 允许发送的小时，如 `["08","09","22"]`。**为空 = 不限制**（每个整点都可以发送）。在渠道页编辑。 |
| `DEFAULT_REMINDER_RULES` | 新建订阅未自带规则时套用的规则模板。`null`（从未配置）回退内置预设（提前 7/3/1 天 + 当天）；空数组表示新订阅明确**不带**任何规则。 |
| `THIRD_PARTY_API_TOKEN` | 第三方触发接口（`/api/thirdparty/notify`）的令牌。 |
| 各渠道凭据 | 在渠道页逐个配置，如邮件的 `RESEND_API_KEY` + `EMAIL_FROM`/`EMAIL_TO`、Telegram 的 `TG_BOT_TOKEN` + `TG_CHAT_ID`、`BARK_DEVICE_KEY`、`SERVERCHAN_SENDKEY`、`PUSHPLUS_TOKEN`、`NTFY_TOPIC`、Gotify 的 `GOTIFY_SERVER_URL` + 应用令牌、企业微信 `WECHATBOT_WEBHOOK`、Webhook 的 `WEBHOOK_URL`。只存于你的部署存储，绝不进仓库。 |

`DEFAULT_REMINDER_RULES` 提交非法规则会整单拒绝（HTTP 400），已存值不变。

## 提醒是怎么工作的

1. **整点触发**——每小时跑一次调度（Workers 是 Cron Trigger，Node 是对齐整点的定时器）。
2. **规则求值**——按配置时区，把每个活跃订阅的规则对其（下一次）到期日求值。
3. **时段过滤**——`NOTIFICATION_HOURS` 非空且当前小时不在其中时，本次跳过发送。
4. **分发**——到期的提醒经所有已启用渠道发出，通知标题以最紧急的订阅打头。
5. **失败重试**——各渠道独立去重；失败渠道仅在之后规则仍命中且处于发送时段时重试。每天只允许一个发送时段时可能没有补发机会；多个调度器并发使用 KV 无法保证绝对不重复。
6. **落日志**——发送与调度记录进活动页，按来源标注（调度规则 / `manual-test` / 渠道 `test` / `thirdparty`）。

升级或跨运行时迁移前请导出备份。JSON 包含订阅、支付记录、规则及配置（可选密钥），不包含通知日志、调度日志和去重状态；迁移后当前窗口内的提醒可能再次发送。

## 架构

端口与适配器：业务逻辑只依赖抽象，两个入口都是薄组合根。

- `src/index.ts`——Cloudflare Workers 组合根（KV 绑定本身即存储实现，零适配代码）。
- `src/server.ts`——Node 组合根（`@hono/node-server`、静态视图、整点调度、优雅退出）。
- `src/platform/storage/storage-port.ts`——`StoragePort` 接口（KV 常用子集：`get/put/delete/list` + TTL）；同目录有 `sqlite-storage.ts`、`memory-storage.ts` 两个适配器。用 `npm run check:storage` 校验任何适配器。
- `src/views/`——五页（概览、订阅、渠道、活动、设置）加共享层 `theme-resources.html`（设计系统与 `window.ST` 运行时）。

细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发

```bash
npm run dev            # wrangler dev（Workers 运行时）
npm run build          # 类型检查并构建 → dist/（Node 运行时）
npm test               # vitest 测试套件
npm run lint           # tsc --noEmit（strict）
npm run check:storage  # 对 dist/ 跑存储适配器契约校验
npm run check:server   # Node HTTP 与静态资源冒烟测试
npm run check:setup    # KV 配置保留测试
npm run check:ui       # 异步界面状态测试
```

全仓 TypeScript `strict`——不用 `@ts-ignore`、不留隐式 `any`；改动以全量测试绿为准。

## 路线图

SubsTracker 正按小步、可独立发布的节奏，从订阅通知演进为上述定时触发平台：

1. **渠道注册表化**——11 个渠道补 manifest 并建注册表，分发改走注册表。（计划中）
2. **内核拆分**——调度拆为触发内核 `runTick` + 订阅插件的求值器。（计划中）
3. **管线升格**——执行器升为（事件，绑定）模型，渠道适配器包装成动作插件。（计划中）
4. **设置 schema 化**——渠道抽屉改由配置 schema 生成。（计划中；现有抽屉是其手写原型）
5. **定时邮件插件**——第一个声明式触发源：草稿、定时发送、`send-mail` 动作。（计划中）
6. **任务提醒插件**——第二个声明式触发源，复用偏移/规则编辑器。（计划中）
7. **活动日志通用化**——按来源插件筛选。（可选，最后做）

已落地的地基：双运行时单代码库、存储可插拔、结构化通知载荷、全局默认规则可编辑。

## 致谢

Fork 自 [wangwangit/SubsTracker](https://github.com/wangwangit/SubsTracker)。v3 界面的设计语言借鉴了 Meta 的 Astryx 设计系统与 Craft 的玻璃质感。

## 许可证

[MIT](LICENSE)
