/**
 * Hono 应用装配
 *
 * 设计目标：
 * - 用 Hono 实现路由分发与中间件管线
 * - 引入中间件：迁移检查 / 日志 / 认证 / 错误处理
 * - 路由路径、方法、响应结构与既有客户端严格兼容
 *   现有前端代码无需改动即可继续工作
 *
 * 落地策略：
 * - 现阶段（Task 7）：Hono 充当"外壳路由器"，把请求转发给现有 handler
 *   后续 Task 可逐个把 handler 改成 Hono 原生写法，但当前优先保证不破坏。
 *
 */

import { Hono } from 'hono';

import { handleApiRequest } from './api/router.js';
import { handleAdminRequest, handleLoginPage } from './api/admin.js';
import { handleDebug } from './api/debug.js';
import { getUserFromRequest } from './api/handlers/auth.js';
import { ensureMigrations } from './data/migrate.js';
import type { AppEnv } from './platform/storage/storage-port.js';

const app = new Hono<{ Bindings: AppEnv }>();

// ─────────────────────────────────────────────────────────────
// 全局中间件：迁移检查（首次访问透明触发）
// ─────────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  try {
    await ensureMigrations(c.env);
  } catch (err) {
    console.error('[app] 迁移失败，回退继续处理请求:', err);
  }
  await next();
});

// ─────────────────────────────────────────────────────────────
// 全局中间件：安全响应头（两个运行时共用）
// 不加 Content-Security-Policy：页面依赖 CDN 样式与大量内联脚本，
// 现阶段强推 CSP 会误伤功能，留待前端资源自托管后再启用。
// ─────────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
});

// ─────────────────────────────────────────────────────────────
// 全局错误兜底
// ─────────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('[app] 未捕获异常:', err && err.stack ? err.stack : err);
  // 统一的错误格式
  return c.json(
    {
      success: false,
      message: err && err.message ? err.message : '服务异常',
      code: 'internal_error'
    },
    500
  );
});

// ─────────────────────────────────────────────────────────────
// 路由：根路径
// 已登录跳 /admin；未登录返回登录页
// ─────────────────────────────────────────────────────────────
app.get('/', async (c) => {
  const { user } = await getUserFromRequest(c.req.raw, c.env);
  if (user) return c.redirect('/admin');
  return handleLoginPage();
});

// ─────────────────────────────────────────────────────────────
// 路由：/debug（必须登录）
// ─────────────────────────────────────────────────────────────
app.all('/debug', async (c) => {
  const { user } = await getUserFromRequest(c.req.raw, c.env);
  if (!user) {
    return new Response('未授权访问', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
  return handleDebug(c.req.raw, c.env);
});

// ─────────────────────────────────────────────────────────────
// 路由：/api/*（认证由 handler 内部处理，与既有客户端约定一致）
// ─────────────────────────────────────────────────────────────
app.all('/api/*', async (c) => {
  return handleApiRequest(c.req.raw, c.env);
});

// ─────────────────────────────────────────────────────────────
// 路由：/admin/*
// ─────────────────────────────────────────────────────────────
app.all('/admin/*', async (c) => {
  return handleAdminRequest(c.req.raw, c.env);
});

app.get('/admin', async (c) => {
  return handleAdminRequest(c.req.raw, c.env);
});

// ─────────────────────────────────────────────────────────────
// 兜底：其他路径返回登录页（（兜底行为））
// ─────────────────────────────────────────────────────────────
app.all('*', async () => {
  return handleLoginPage();
});

export default app;
