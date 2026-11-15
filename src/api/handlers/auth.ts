import { generateJWT, verifyJWT, timingSafeEqual, type JwtPayload } from '../../core/auth.js';
import { getConfig, type AppConfig } from '../../data/config.js';
import { getCookieValue } from '../utils.js';
import type { AppEnv } from '../../platform/storage/storage-port.js';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 300; // 5 分钟

/** 规范化客户端 IP：优先 Cloudflare 真实 IP，其次 XFF 首跳并限制长度防止存储键膨胀。 */
function extractClientIp(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp && cfIp.trim()) return cfIp.trim().slice(0, 64);
  const xff = request.headers.get('X-Forwarded-For');
  if (xff && xff.trim()) {
    const first = xff.split(',')[0].trim();
    if (first) return first.slice(0, 64);
  }
  return 'unknown';
}

async function checkRateLimit(env: AppEnv, ip: string): Promise<boolean> {
  const key = `login_attempts:${ip}`;
  const raw = await env.SUBSCRIPTIONS_KV.get(key);
  const attempts = raw ? parseInt(raw, 10) : 0;
  return attempts >= MAX_LOGIN_ATTEMPTS;
}

async function recordFailedAttempt(env: AppEnv, ip: string): Promise<number> {
  const key = `login_attempts:${ip}`;
  const raw = await env.SUBSCRIPTIONS_KV.get(key);
  const attempts = (raw ? parseInt(raw, 10) : 0) + 1;
  await env.SUBSCRIPTIONS_KV.put(key, String(attempts), { expirationTtl: LOCKOUT_SECONDS });
  return attempts;
}

async function clearAttempts(env: AppEnv, ip: string): Promise<void> {
  await env.SUBSCRIPTIONS_KV.delete(`login_attempts:${ip}`);
}

/** 登录请求体（JSON 边界：字段按待校验的原始值接收，比对由本函数完成）。 */
interface LoginBody {
  username?: unknown;
  password?: unknown;
}

async function handleLogin(request: Request, env: AppEnv): Promise<Response> {
  const ip = extractClientIp(request);

  if (await checkRateLimit(env, ip)) {
    return new Response(
      JSON.stringify({ success: false, message: '登录尝试过多，请 5 分钟后再试' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body: LoginBody;
  try {
    const raw: unknown = await request.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return new Response(
        JSON.stringify({ success: false, message: '请求格式错误' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    body = raw as LoginBody;
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, message: '请求格式错误' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const config = await getConfig(env);

  const userOk = timingSafeEqual(username, config.ADMIN_USERNAME || '');
  const passOk = timingSafeEqual(password, config.ADMIN_PASSWORD || '');

  if (userOk && passOk) {
    await clearAttempts(env, ip);
    // getConfig 保证 JWT_SECRET 必存在（缺失时生成并持久化）
    const token = await generateJWT(username, config.JWT_SECRET as string);

    return new Response(
      JSON.stringify({ success: true }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'token=' + token + '; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=86400'
        }
      }
    );
  }

  const attempts = await recordFailedAttempt(env, ip);
  const remaining = MAX_LOGIN_ATTEMPTS - attempts;
  const message = remaining > 0
    ? `用户名或密码错误（还可尝试 ${remaining} 次）`
    : '登录尝试过多，请 5 分钟后再试';

  return new Response(
    JSON.stringify({ success: false, message }),
    { status: remaining > 0 ? 200 : 429, headers: { 'Content-Type': 'application/json' } }
  );
}

function handleLogout(): Response {
  return new Response('', {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': 'token=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0'
    }
  });
}

async function getUserFromRequest(
  request: Request,
  env: AppEnv,
  preloadedConfig?: AppConfig
): Promise<{ user: JwtPayload | null; config: AppConfig }> {
  const token = getCookieValue(request.headers.get('Cookie'), 'token');
  const config = preloadedConfig || await getConfig(env);
  const user = token ? await verifyJWT(token, config.JWT_SECRET as string) : null;
  return { user, config };
}

export { handleLogin, handleLogout, getUserFromRequest };
