/**
 * Node 组合根（Composition Root）—— 服务器运行时入口。
 *
 * 与 Workers 入口（src/index.js）平级：两者都只是「装配 + 触发」，
 * 业务逻辑全部在 src/app.js 与 src/services 中，运行时无关。
 *
 * 本入口负责装配服务器侧的基础设施：
 * - 存储插件：按 STORAGE_DRIVER 选择 StoragePort 实现
 *   （sqlite = 服务器数据库 / memory = 临时调试），注入为
 *   env.SUBSCRIPTIONS_KV —— 与 Cloudflare KV 绑定同名同契约，
 *   因此业务代码零改动。Cloudflare 部署时 KV 本身就是另一个插件。
 * - 静态资源：public/ 目录（Workers 侧由 [assets] 绑定提供）。
 * - 定时任务：整点触发 checkExpiringSubscriptions（Workers 侧为 Cron）。
 * - /healthz：无鉴权健康探针（仅返回状态与存储类型）。
 *
 * 环境变量：
 * - PORT（默认 3200）、HOST（默认 127.0.0.1）
 * - STORAGE_DRIVER（sqlite | memory，默认 sqlite）
 * - SQLITE_PATH（默认 <项目>/data/substracker.sqlite）
 * - SCHEDULER_ENABLED（false 时不跑整点任务，默认启用）
 */

import { register } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppEnv, StoragePort } from './platform/storage/storage-port.js';

// 视图层用 .html text import（Wrangler 能力），Node 侧用钩子等价实现。
// 必须在导入 app 之前注册，因此下面全部使用动态 import。
register('./platform/node-html-loader.mjs', import.meta.url);

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const { serve } = await import('@hono/node-server');
const { serveStatic } = await import('@hono/node-server/serve-static');
const { Hono } = await import('hono');
const { default: app } = await import('./app.js');
const { ensureMigrations } = await import('./data/migrate.js');
const { checkExpiringSubscriptions } = await import('./services/scheduler.js');
const { createSqliteStorage } = await import('./platform/storage/sqlite-storage.js');
const { createMemoryStorage } = await import('./platform/storage/memory-storage.js');

// ── 存储插件装配 ─────────────────────────────────────────────
const driver = (process.env.STORAGE_DRIVER || 'sqlite').toLowerCase();
let storage: StoragePort & { close?: () => void };
if (driver === 'memory') {
  storage = createMemoryStorage();
  console.warn('[server] 使用内存存储（数据不落盘，仅调试）');
} else if (driver === 'sqlite') {
  const sqlitePath = process.env.SQLITE_PATH || join(projectRoot, 'data', 'substracker.sqlite');
  mkdirSync(dirname(sqlitePath), { recursive: true });
  storage = createSqliteStorage({ path: sqlitePath });
  console.log(`[server] 存储插件：SQLite → ${sqlitePath}`);
} else {
  console.error(`[server] 未知 STORAGE_DRIVER: ${driver}（可选 sqlite | memory）`);
  process.exit(1);
}

/** 与 Workers env 同形的运行时环境对象 */
const env: AppEnv = {
  SUBSCRIPTIONS_KV: storage,
  ENVIRONMENT: process.env.ENVIRONMENT || 'production'
};

// 启动时先跑迁移，保证数据结构就绪（请求中间件里也会兜底）
try {
  const migration = await ensureMigrations(env);
  if (migration.reason === 'locked_elsewhere') throw new Error('数据迁移正在其他实例中执行');
} catch (err) {
  console.error('[server] 启动迁移失败:', err);
  if (storage && typeof storage.close === 'function') storage.close();
  process.exit(1);
}

// ── HTTP 装配 ────────────────────────────────────────────────
const root = new Hono();
root.get('/healthz', (c) =>
  c.json({ status: 'ok', storage: driver, time: new Date().toISOString() })
);
root.use('/*', serveStatic({ root: join(projectRoot, 'public') }));
root.all('*', (c) => app.fetch(c.req.raw, env));

const port = Number(process.env.PORT || 3200);
const hostname = process.env.HOST || '127.0.0.1';
const server = serve({ fetch: root.fetch, port, hostname }, (info) => {
  console.log(`[server] SubsTracker 已启动 http://${info.address}:${info.port}（存储: ${driver}）`);
});

// ── 定时任务：对齐整点，每小时一次 ────────────────────────────
if ((process.env.SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false') {
  const runScheduler = async () => {
    try {
      const migration = await ensureMigrations(env);
      if (migration.reason === 'locked_elsewhere') throw new Error('数据迁移进行中，跳过本次定时检查');
      const entry = await checkExpiringSubscriptions(env);
      console.log('[scheduler] 整点检查完成', entry ? `status=${entry.status}` : '');
    } catch (err) {
      console.error('[scheduler] 执行失败:', err);
    }
  };
  const now = new Date();
  const msToNextHour =
    (59 - now.getMinutes()) * 60_000 + (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 5_000;
  setTimeout(() => {
    void runScheduler();
    setInterval(() => void runScheduler(), 3_600_000);
  }, msToNextHour);
  console.log(`[scheduler] 已排定整点任务（首次约 ${Math.round(msToNextHour / 1000)}s 后）`);
}

// ── 优雅退出 ─────────────────────────────────────────────────
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[server] 收到 ${signal}，正在退出`);
    server.close(() => {
      if (storage && typeof storage.close === 'function') storage.close();
      process.exit(0);
    });
    // 兜底：3 秒内未关闭则强制退出
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
