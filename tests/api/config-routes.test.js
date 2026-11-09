// @ts-check
/**
 * 配置读写与敏感字段脱敏
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.ts';
import { getConfig } from '../../src/data/config.ts';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

async function loginCookie() {
  await env.SUBSCRIPTIONS_KV.put(
    'config',
    JSON.stringify({
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'password',
      JWT_SECRET: 'secret-jwt',
      TG_BOT_TOKEN: 'bot-secret',
      TG_CHAT_ID: '111',
      WPUSH_APIKEY: 'wpush-secret',
      WPUSH_CHANNEL: 'feishu',
      WPUSH_TOPIC_CODE: 'topic-1',
      TIMEZONE: 'Asia/Shanghai'
    })
  );
  const res = await app.request(
    '/api/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' })
    },
    env
  );
  return res.headers.get('Set-Cookie')?.split(';')[0] || '';
}

beforeEach(clearKv);
afterEach(() => vi.restoreAllMocks());

describe('GET /api/config', () => {
  it('未登录 401', async () => {
    const res = await app.request('/api/config', {}, env);
    expect(res.status).toBe(401);
  });

  it('敏感字段脱敏 + CONFIGURED 标记', async () => {
    const cookie = await loginCookie();
    const res = await app.request('/api/config', { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const cfg = await res.json();
    expect(cfg.TG_BOT_TOKEN).toBe('');
    expect(cfg.TG_BOT_TOKEN_CONFIGURED).toBe(true);
    expect(cfg.JWT_SECRET).toBeUndefined();
    expect(cfg.ADMIN_PASSWORD).toBeUndefined();
    expect(cfg.TG_CHAT_ID).toBe('111');
    expect(cfg.WPUSH_APIKEY).toBe('');
    expect(cfg.WPUSH_APIKEY_CONFIGURED).toBe(true);
  });
});

describe('POST /api/config', () => {
  it('空字符串不误清空已有 Token', async () => {
    const cookie = await loginCookie();
    const res = await app.request(
      '/api/config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          TG_BOT_TOKEN: '',
          TG_CHAT_ID: '222',
          TIMEZONE: 'UTC',
          ENABLED_NOTIFIERS: ['telegram']
        })
      },
      env
    );
    expect(res.status).toBe(200);
    const stored = await getConfig(env);
    expect(stored.TG_BOT_TOKEN).toBe('bot-secret');
    expect(stored.TG_CHAT_ID).toBe('222');
    expect(stored.TIMEZONE).toBe('UTC');
  });

  it('APP_URL 可保存（带 trim），未设置时默认为空', async () => {
    const cookie = await loginCookie();
    expect((await getConfig(env)).APP_URL).toBe('');
    const res = await app.request(
      '/api/config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ APP_URL: '  https://app.example.com/subs  ' })
      },
      env
    );
    expect(res.status).toBe(200);
    expect((await getConfig(env)).APP_URL).toBe('https://app.example.com/subs');
  });

  it('CLEAR_SECRET_FIELDS 可显式清空', async () => {
    const cookie = await loginCookie();
    await app.request(
      '/api/config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          CLEAR_SECRET_FIELDS: ['TG_BOT_TOKEN'],
          TG_CHAT_ID: '111'
        })
      },
      env
    );
    const stored = await getConfig(env);
    expect(stored.TG_BOT_TOKEN).toBe('');
  });
});

describe('POST /api/test-notification (email)', () => {
  it('发送示例订阅版式邮件，主题注明示例', async () => {
    const cookie = await loginCookie();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'mail-1' }), { status: 200 })
    );
    const response = await app.request('/api/test-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        type: 'email',
        RESEND_API_KEY: 'rk',
        EMAIL_FROM: 'a@b.com',
        EMAIL_TO: 'c@d.com'
      })
    }, env);
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.resend.com/emails');
    const sentBody = JSON.parse(String(init.body));
    expect(sentBody.subject).toContain('示例');
    expect(sentBody.html).toContain('示例 · Netflix');
    expect(sentBody.html).toContain('示例 · Spotify');
  });
});

describe('POST /api/test-notification (WPUSH)', () => {
  it('未保存的空渠道和 Topic 覆盖已保存值', async () => {
    const cookie = await loginCookie();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0 }), { status: 200 })
    );
    const response = await app.request('/api/test-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'wpush', WPUSH_CHANNEL: '', WPUSH_TOPIC_CODE: '' })
    }, env);
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(sentBody.apikey).toBe('wpush-secret');
    expect(sentBody).not.toHaveProperty('channel');
    expect(sentBody).not.toHaveProperty('topic_code');
  });
});
