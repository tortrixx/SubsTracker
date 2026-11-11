# 架构说明：双运行时与存储插件

SubsTracker 按「端口与适配器」（Ports & Adapters）组织：业务逻辑只依赖
抽象端口，具体基础设施在两个组合根（Composition Root）里装配，
切换运行时不需要改任何业务代码。

## 组合根

| 入口 | 运行时 | 静态资源 | 定时任务 | 存储装配 |
| --- | --- | --- | --- | --- |
| `src/index.ts` | Cloudflare Workers | `[assets]` 绑定托管 `public/` | Cron Triggers（整点） | `SUBSCRIPTIONS_KV` 绑定 |
| `src/server.ts` | Node ≥ 22 | `@hono/node-server` serveStatic | 整点对齐 setInterval | StoragePort 适配器（见下） |

两个入口之下是同一套 `src/app.ts`（Hono 应用）与全部业务模块。

## 存储端口 StoragePort

接口定义在 `src/platform/storage/storage-port.ts`，与 Cloudflare KV 的
常用子集（get/put/delete/list + expirationTtl）完全对齐，于是：

- **Cloudflare 插件**：KV 绑定本身即是实现，零适配代码；
- **服务器插件**：`src/platform/storage/sqlite-storage.ts`
  （Node 内置 `node:sqlite`，WAL 模式，TTL 惰性过期，list 游标分页）；
- **调试插件**：`src/platform/storage/memory-storage.ts`（进程内存）。

适配器一致性由契约脚本保证：`npm run check:storage`
（同一组断言跑全部适配器）。业务层通过 `env.SUBSCRIPTIONS_KV`
拿到端口实例，不感知底层实现——把 `STORAGE_DRIVER` 换掉即可换存储。

## 视图层解耦

`src/views/pages.ts` 使用 `.html` 文本导入（Wrangler 能力）。Node 侧由
`src/platform/node-html-loader.mjs`（模块定制钩子）提供等价能力，
同一份视图代码在两个运行时原样运行。

## 语言与构建

全仓 **TypeScript**（`tsconfig.json`，strict 全开），`npm run lint` 即
`tsc --noEmit`。同一套源码两个运行时：

- **Cloudflare Workers**：Wrangler 直接编译 TS 源码
  （入口 `src/index.ts`），无需预构建，`npm run deploy` 上线。
- **Node 服务器**：`npm run build` 用 tsc 产出 `dist/`（外加
  `scripts/copy-assets.mjs` 复制 .html 视图与 html-loader 到 dist），
  `npm start` 运行 `dist/server.js`。发布给服务器的是构建产物，
  服务器不需要装 TypeScript。

存储契约脚本 `npm run check:storage` 直接对 dist 产物跑断言，
验证的就是实际交付的那一份代码。

## 默认提醒规则解析（resolveDefaultRules）

新建订阅未自带规则时套用的默认规则，由 `src/data/reminders.repo.ts` 的
`resolveDefaultRules(config)` 单点解析（消费方只有订阅创建处理器
`src/api/handlers/subscriptions.ts`）：

- config 的 `DEFAULT_REMINDER_RULES` 为数组（含空数组）→ 以其为模板
  逐条复制，`id` / `createdAt` 重新生成（避免跨订阅规则 ID 重复）；
- 为 `null`（从未配置）→ 回退内置预设（到期前 7/3/1 天 + 当天）；
- 空数组是明确语义：新订阅不带任何规则，不回退预设。

配置写入有严格校验：`validateReminderRules`（与 `normalizeRule` 同一
字段域）是唯一校验来源，任一条非法 → 整个 POST 400 且不落库。
手动续订不套默认规则；对已有订阅显式「应用智能预设」
（`extras.ts` 的 `{preset:true}`）是独立动作，语义不随配置变化。
备份恢复与第三方导入不套默认（按还原语义保留原始数据），但该字段
随备份的 config 全量导出/合并自然携带。

## 通知日志与 ruleId 约定

发送记录（`src/data/notification-logs.repo.ts`）以 `ruleId` 区分来源，
活动页筛选与渠道卡「最近结果」都按此字段辨识，四个取值是契约：

| ruleId | 来源 |
| --- | --- |
| 真实规则 ID | 调度器按规则发送 |
| `manual-test` | 订阅页手动发送测试 |
| `test` | 渠道页发送测试（`test-notification.ts` 统一落日志，subId 固定 `channel-test`） |
| `thirdparty` | 第三方 API 触发 |

调度按订阅、规则和渠道分别记录去重与 lastFire。失败渠道仅在后续
检查仍命中规则且处于发送窗口时重试；KV 不提供原子去重，多实例并发
不能保证严格一次发送。

## 配置存储与保存语义

全量配置存于存储端口内的单个 config 记录，默认值由
`src/data/config.ts` 的 `DEFAULT_CONFIG` 定义。`POST /api/config`
按字段显式重建后落库（未知字段丢弃）——新增配置项必须同时改
`DEFAULT_CONFIG` 与 `src/api/handlers/config.ts` 的处理，两处缺一，
保存即丢失。渠道凭据同属 config，只经 `buildSafeConfig` 脱敏下发。

## 服务器部署

见 `deploy/substracker.service` 与 `deploy/substracker.env.example`：
代码放 `/data/substracker/app`，数据库与配置放 `/data/substracker/`
（代码与状态分离），systemd 托管，`/healthz` 提供健康探针。
