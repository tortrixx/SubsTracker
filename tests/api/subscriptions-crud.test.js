// @ts-check
/**
 * 订阅 CRUD 生命周期
 * 覆盖：创建/读取/更新/删除、缺字段、删除清理 reminder_rules、toggle、续订
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.ts';
import * as subRepo from '../../src/data/subscriptions.repo.ts';
import * as remindersRepo from '../../src/data/reminders.repo.ts';

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
      JWT_SECRET: 'k',
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

describe('保存过期订阅时的自动续订设置', () => {
  const expiredDate = '2026-04-01';
  const expiredIso = '2026-03-31T16:00:00.000Z';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it.each([false, true])('新建时关闭自动续订应保留过去的到期日（农历=%s）', async (useLunar) => {
    const cookie = await loginCookie();
    const res = await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Expired', expiryDate: expiredDate, periodValue: 1,
        periodUnit: 'month', autoRenew: false, useLunar, amount: 10
      })
    }, env);
    expect(res.status).toBe(201);
    const { subscription } = await res.json();
    const saved = await subRepo.getById(env, subscription.id);
    expect(saved.autoRenew).toBe(false);
    expect(saved.expiryDate).toBe(expiredIso);
    expect(saved.paymentHistory[0].periodEnd).toBe(expiredIso);
  });

  it.each([
    { useLunar: false, autoRenew: false },
    { useLunar: true, autoRenew: false },
    { useLunar: false, autoRenew: undefined },
    { useLunar: true, autoRenew: undefined }
  ])('编辑时关闭或沿用已关闭的自动续订应保留到期日（%j）', async ({ useLunar, autoRenew }) => {
    const cookie = await loginCookie();
    await subRepo.save(env, {
      id: 'expired', name: 'Expired', expiryDate: expiredIso,
      autoRenew: autoRenew !== undefined, isActive: true, useLunar, paymentHistory: []
    });
    const res = await app.request('/api/subscriptions/expired', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Edited', expiryDate: expiredDate, periodValue: 1,
        periodUnit: 'month', autoRenew, useLunar
      })
    }, env);
    expect(res.status).toBe(200);
    const saved = await subRepo.getById(env, 'expired');
    expect(saved.autoRenew).toBe(false);
    expect(saved.expiryDate).toBe(expiredIso);
    expect(saved.paymentHistory).toEqual([]);
  });

  it.each([false, true])('开启自动续订时新建和编辑仍推进过期日期（农历=%s）', async (useLunar) => {
    const cookie = await loginCookie();
    const fields = {
      name: 'Renewing', expiryDate: expiredDate, periodValue: 1,
      periodUnit: 'month', autoRenew: true, useLunar
    };
    const create = await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(fields)
    }, env);
    expect(create.status).toBe(201);
    const { subscription } = await create.json();
    expect(new Date(subscription.expiryDate).getTime()).toBeGreaterThan(Date.now());
    const update = await app.request('/api/subscriptions/' + subscription.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(fields)
    }, env);
    expect(update.status).toBe(200);
    const saved = await subRepo.getById(env, subscription.id);
    expect(saved.autoRenew).toBe(true);
    expect(new Date(saved.expiryDate).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('订阅 CRUD', () => {
  it('创建订阅成功并写入默认提醒规则', async () => {
    const cookie = await loginCookie();
    const res = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Netflix',
          expiryDate: '2026-08-01',
          periodValue: 1,
          periodUnit: 'month',
          isActive: true
        })
      },
      env
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.subscription.id).toBeTruthy();
    const rules = await remindersRepo.listForSubscription(env, body.subscription.id);
    expect(rules.length).toBeGreaterThanOrEqual(1);
  });

  it('缺 name/expiryDate → 失败', async () => {
    const cookie = await loginCookie();
    const res = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: '' })
      },
      env
    );
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('列表返回 reminderRules 摘要字段', async () => {
    const cookie = await loginCookie();
    await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'A',
          expiryDate: '2026-09-01',
          reminderRules: [
            { type: 'before_expiry', value: 30, unit: 'days', isEnabled: true }
          ]
        })
      },
      env
    );
    const listRes = await app.request('/api/subscriptions', { headers: { Cookie: cookie } }, env);
    const list = await listRes.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list[0].reminderRules).toBeTruthy();
    expect(list[0].reminderRulesSummary).toMatch(/30|提前/);
  });

  it('更新订阅名称', async () => {
    const cookie = await loginCookie();
    const create = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Old', expiryDate: '2026-10-01' })
      },
      env
    );
    const { subscription } = await create.json();
    const res = await app.request(
      '/api/subscriptions/' + subscription.id,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'New',
          expiryDate: '2026-10-01',
          periodValue: 1,
          periodUnit: 'month'
        })
      },
      env
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    const got = await subRepo.getById(env, subscription.id);
    expect(got.name).toBe('New');
  });

  it('删除订阅同时清理 reminder_rules', async () => {
    const cookie = await loginCookie();
    const create = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Del', expiryDate: '2026-11-01' })
      },
      env
    );
    const { subscription } = await create.json();
    const id = subscription.id;
    expect((await remindersRepo.listForSubscription(env, id)).length).toBeGreaterThan(0);

    const del = await app.request(
      '/api/subscriptions/' + id,
      { method: 'DELETE', headers: { Cookie: cookie } },
      env
    );
    expect((await del.json()).success).toBe(true);
    expect(await subRepo.getById(env, id)).toBeNull();
    expect(await remindersRepo.listForSubscription(env, id)).toEqual([]);
  });

  it('toggle-status 停用/启用', async () => {
    const cookie = await loginCookie();
    const create = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'T', expiryDate: '2026-12-01' })
      },
      env
    );
    const { subscription } = await create.json();
    const off = await app.request(
      '/api/subscriptions/' + subscription.id + '/toggle-status',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ isActive: false })
      },
      env
    );
    expect((await off.json()).success).toBe(true);
    expect((await subRepo.getById(env, subscription.id)).isActive).toBe(false);
  });
});
