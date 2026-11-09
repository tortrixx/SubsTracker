// @ts-check
/**
 * 全局默认提醒规则（DEFAULT_REMINDER_RULES）
 * 覆盖：保存/读回、空数组与未配置的区别、未配置回退内置预设、
 * 非法规则 400 且已存不变、字段缺失不修改、新建订阅套用配置默认
 */
import { describe, it, expect, beforeEach } from 'vitest';
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

function postConfig(cookie, body) {
  return app.request(
    '/api/config',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body)
    },
    env
  );
}

async function getConfigApi(cookie) {
  const res = await app.request('/api/config', { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  return res.json();
}

async function createSubscription(cookie) {
  const res = await app.request('/api/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      name: 'Netflix', expiryDate: '2027-06-01', periodValue: 1, periodUnit: 'month', amount: 10
    })
  }, env);
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.subscription.id;
}

async function getRules(cookie, subId) {
  const res = await app.request(`/api/subscriptions/${subId}/reminders`, {
    headers: { Cookie: cookie }
  }, env);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.rules;
}

/** 只取语义字段比对（id / createdAt 在套用时重新生成，不参与比对） */
function semantic(rules) {
  return rules.map((r) => ({
    type: r.type,
    value: r.value,
    unit: r.unit,
    repeatInterval: r.repeatInterval ?? null,
    repeatUntil: r.repeatUntil,
    isEnabled: r.isEnabled
  }));
}

const CUSTOM_RULES = [
  { id: 'tpl-1', type: 'before_expiry', value: 5, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'tpl-2', type: 'before_expiry', value: 12, unit: 'hours', repeatInterval: null, repeatUntil: 'acknowledged', isEnabled: true, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'tpl-3', type: 'after_expiry', value: 0, unit: 'days', repeatInterval: 24, repeatUntil: 'never', isEnabled: false, createdAt: '2026-01-01T00:00:00.000Z' }
];

const PRESET_SEMANTIC = [
  { type: 'before_expiry', value: 7, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true },
  { type: 'before_expiry', value: 3, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true },
  { type: 'before_expiry', value: 1, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true },
  { type: 'on_expiry', value: 0, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true }
];

beforeEach(clearKv);

describe('DEFAULT_REMINDER_RULES 全局默认提醒规则', () => {
  it('保存自定义规则后读回一致，新建订阅套用该组规则', async () => {
    const cookie = await loginCookie();
    const postRes = await postConfig(cookie, { DEFAULT_REMINDER_RULES: CUSTOM_RULES });
    expect(postRes.status).toBe(200);
    expect((await postRes.json()).success).toBe(true);

    const cfg = await getConfigApi(cookie);
    expect(cfg.DEFAULT_REMINDER_RULES).toEqual(CUSTOM_RULES);
    expect((await getConfig(env)).DEFAULT_REMINDER_RULES).toEqual(CUSTOM_RULES);

    const subId = await createSubscription(cookie);
    const rules = await getRules(cookie, subId);
    expect(rules).toHaveLength(CUSTOM_RULES.length);
    expect(semantic(rules)).toEqual(semantic(CUSTOM_RULES));
  });

  it('保存空数组表示新订阅不带任何规则（与未配置区分）', async () => {
    const cookie = await loginCookie();
    const postRes = await postConfig(cookie, { DEFAULT_REMINDER_RULES: [] });
    expect(postRes.status).toBe(200);

    const cfg = await getConfigApi(cookie);
    expect(cfg.DEFAULT_REMINDER_RULES).toEqual([]);
    expect(cfg.DEFAULT_REMINDER_RULES).not.toBeNull();

    const subId = await createSubscription(cookie);
    const rules = await getRules(cookie, subId);
    expect(rules).toEqual([]);
  });

  it('从未配置时 GET 返回 null，新建订阅套用内置预设 7/3/1/当天', async () => {
    const cookie = await loginCookie();
    const cfg = await getConfigApi(cookie);
    expect('DEFAULT_REMINDER_RULES' in cfg).toBe(true);
    expect(cfg.DEFAULT_REMINDER_RULES).toBeNull();

    const subId = await createSubscription(cookie);
    const rules = await getRules(cookie, subId);
    expect(semantic(rules)).toEqual(PRESET_SEMANTIC);
  });

  it('POST 非法规则返回 400 且已存值不变', async () => {
    const cookie = await loginCookie();
    await postConfig(cookie, { DEFAULT_REMINDER_RULES: CUSTOM_RULES });

    const badPayloads = [
      [{ type: 'weekly', value: 3, unit: 'days' }],
      [{ type: 'before_expiry', value: -1, unit: 'days' }],
      [{ type: 'before_expiry', value: 3, unit: 'weeks' }],
      [{ type: 'after_expiry', value: 0, unit: 'days', repeatInterval: 0 }],
      'not-an-array',
      [null]
    ];
    for (const bad of badPayloads) {
      const res = await postConfig(cookie, { DEFAULT_REMINDER_RULES: bad });
      expect(res.status).toBe(400);
      expect((await res.json()).success).toBe(false);
    }

    const cfg = await getConfigApi(cookie);
    expect(cfg.DEFAULT_REMINDER_RULES).toEqual(CUSTOM_RULES);
  });

  it('POST 不带该字段时不修改已存的默认规则', async () => {
    const cookie = await loginCookie();
    await postConfig(cookie, { DEFAULT_REMINDER_RULES: CUSTOM_RULES });

    const res = await postConfig(cookie, { TIMEZONE: 'UTC' });
    expect(res.status).toBe(200);

    const cfg = await getConfigApi(cookie);
    expect(cfg.TIMEZONE).toBe('UTC');
    expect(cfg.DEFAULT_REMINDER_RULES).toEqual(CUSTOM_RULES);
  });
});
