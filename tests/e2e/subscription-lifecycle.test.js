// @ts-check
/**
 * 端到端：创建订阅 → 配置提醒 → 模拟到期调度 → 通知日志 → 续订 → 删除清理
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.ts';
import { checkExpiringSubscriptions } from '../../src/services/scheduler.ts';
import * as subRepo from '../../src/data/subscriptions.repo.ts';
import * as remindersRepo from '../../src/data/reminders.repo.ts';
import { query as queryNotifyLogs } from '../../src/data/notification-logs.repo.ts';

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
      TIMEZONE: 'UTC',
      NOTIFICATION_HOURS: [],
      ENABLED_NOTIFIERS: ['webhook'],
      WEBHOOK_URL: 'https://example.com/hook',
      WEBHOOK_METHOD: 'POST'
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

beforeEach(async () => {
  await clearKv();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      /** @type {any} */ ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => 'ok'
      }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('订阅生命周期 e2e', () => {
  it('同一毫秒创建多条订阅并续期时不会覆盖记录', async () => {
    const cookie = await loginCookie();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T08:00:00Z'));
    const create = (name) => app.request('/api/subscriptions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name, expiryDate: '2026-06-08', periodValue: 1, periodUnit: 'month', amount: 10 })
    }, env);
    const first = (await (await create('第一条')).json()).subscription;
    const second = (await (await create('第二条')).json()).subscription;
    expect(first.id).not.toBe(second.id);
    expect((await subRepo.listAll(env)).map((sub) => sub.name).sort()).toEqual(['第一条', '第二条']);
    const renewed = await app.request(`/api/subscriptions/${first.id}/renew`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}'
    }, env);
    const payments = (await renewed.json()).subscription.paymentHistory;
    expect(payments).toHaveLength(2);
    expect(payments[0].id).not.toBe(payments[1].id);
  });

  it('新建时明确清空提醒规则，调度不会重新套用默认规则', async () => {
    const cookie = await loginCookie();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T08:00:00Z'));
    const response = await app.request('/api/subscriptions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: '无需提醒', expiryDate: '2026-06-08', autoRenew: false,
        periodValue: 1, periodUnit: 'month', reminderRules: [] })
    }, env);
    expect(response.status).toBe(201);
    const id = (await response.json()).subscription.id;
    expect(await remindersRepo.getStoredRules(env, id)).toEqual([]);
    const listResponse = await app.request('/api/subscriptions', { headers: { Cookie: cookie } }, env);
    const listed = await listResponse.json();
    expect(listed.find((sub) => sub.id === id).reminderRules).toEqual([]);
    const result = await checkExpiringSubscriptions(env);
    expect(result.matchedCount).toBe(0);
    expect(result.sentCount).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('创建→规则→到期前触发→日志→续订→删除清理', async () => {
    const cookie = await loginCookie();

    // 1) 创建：到期日设为 7 天后（UTC）
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T08:00:00Z'));

    const createRes = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Lifecycle',
          expiryDate: '2026-06-08',
          periodValue: 1,
          periodUnit: 'month',
          isActive: true,
          amount: 10,
          currency: 'CNY',
          reminderRules: [
            { type: 'before_expiry', value: 7, unit: 'days', isEnabled: true },
            { type: 'on_expiry', value: 0, unit: 'days', isEnabled: true }
          ]
        })
      },
      env
    );
    const created = await createRes.json();
    expect(created.success).toBe(true);
    const id = created.subscription.id;

    // 2) 确认规则
    const rulesRes = await app.request(
      '/api/subscriptions/' + id + '/reminders',
      { headers: { Cookie: cookie } },
      env
    );
    const rulesBody = await rulesRes.json();
    expect(rulesBody.rules.some((r) => r.value === 7)).toBe(true);

    // 3) 调度：剩余 7 天应触发 before_expiry=7
    const sched = await checkExpiringSubscriptions(env);
    expect(sched).toBeTruthy();
    expect(sched.matchedCount).toBeGreaterThanOrEqual(1);
    expect(sched.sentCount).toBe(1);
    expect(sched.status).toBe('ok');

    // 4) 通知日志（若渠道成功）
    const logs = await queryNotifyLogs(env, { subId: id, limit: 20 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ subId: id, channel: 'webhook', status: 'success' });

    // 手动测试应展示与正式调度相同的订阅正文，而不是另一套旧模板。
    const manual = await app.request(`/api/subscriptions/${id}/test-notify`,
      { method: 'POST', headers: { Cookie: cookie } }, env);
    expect((await manual.json()).success).toBe(true);
    const calls = vi.mocked(fetch).mock.calls;
    const scheduledBody = JSON.parse(String(calls[0][1].body));
    const manualBody = JSON.parse(String(calls[1][1].body));
    expect(manualBody.content).toBe(scheduledBody.content);
    expect(manualBody.content).toContain('到期状态: 7 天后到期');
    expect(manualBody.content).not.toContain('类型:');

    // 5) 续订
    const renewRes = await app.request(
      '/api/subscriptions/' + id + '/renew',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ amount: 10, periodMultiplier: 1 })
      },
      env
    );
    const renewBody = await renewRes.json();
    expect(renewBody.success).toBe(true);
    const afterRenew = await subRepo.getById(env, id);
    expect(new Date(afterRenew.expiryDate).getTime()).toBeGreaterThan(
      new Date(created.subscription.expiryDate).getTime()
    );

    // 6) 删除并清理规则
    const del = await app.request(
      '/api/subscriptions/' + id,
      { method: 'DELETE', headers: { Cookie: cookie } },
      env
    );
    expect((await del.json()).success).toBe(true);
    expect(await subRepo.getById(env, id)).toBeNull();
    expect(await remindersRepo.listForSubscription(env, id)).toEqual([]);

  });
});
