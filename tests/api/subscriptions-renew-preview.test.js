// @ts-check
/**
 * 续订预览接口（验收 A17）
 *
 * POST /api/subscriptions/:id/renew/preview 与真实 renew 共用同一计算
 * （computeManualRenewal），预览返回的新到期日必须与 renew 落库后逐字相同。
 * 四例：①已过期 cycle ②reset ③endOfMonth ④农历。
 * 时区固定 Asia/Shanghai；日期串断言均为当地零点对应的 UTC ISO。
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.ts';
import * as subRepo from '../../src/data/subscriptions.repo.ts';

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

/** @param {Record<string, unknown>} [overrides] */
function baseSub(overrides = {}) {
  return {
    id: 'sub-preview-base',
    name: 'Preview Case',
    subscriptionMode: 'cycle',
    customType: '其他',
    category: '',
    startDate: '2025-12-31T16:00:00.000Z',
    expiryDate: '2026-01-31T16:00:00.000Z',
    periodValue: 1,
    periodUnit: 'month',
    endOfMonth: false,
    reminderUnit: 'day',
    reminderValue: 3,
    notes: '',
    amount: 10,
    currency: 'CNY',
    lastPaymentDate: '2025-12-31T16:00:00.000Z',
    paymentHistory: [],
    isActive: true,
    autoRenew: false,
    useLunar: false,
    createdAt: '2025-12-31T16:00:00.000Z',
    ...overrides
  };
}

/**
 * @param {string} cookie
 * @param {string} id
 * @param {string} suffix '' 或 '/preview'
 * @param {Record<string, unknown>} body
 */
async function callRenew(cookie, id, suffix, body) {
  const res = await app.request(
    `/api/subscriptions/${id}/renew${suffix}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body)
    },
    env
  );
  return { status: res.status, body: await res.json() };
}

/**
 * 核心断言：preview 只读且与随后真实 renew 的落库结果逐字一致。
 * @param {string} cookie
 * @param {any} sub
 * @param {Record<string, unknown>} renewBody
 * @param {{ newStartDate?: string, newExpiryDate?: string }} [expected]
 */
async function expectPreviewMatchesRenew(cookie, sub, renewBody, expected = {}) {
  await subRepo.save(env, sub);
  const before = await subRepo.getById(env, sub.id);

  const previewRes = await callRenew(cookie, sub.id, '/preview', renewBody);
  expect(previewRes.status).toBe(200);
  expect(previewRes.body.success).toBe(true);
  const preview = previewRes.body.preview;
  expect(preview).toBeTruthy();

  // 预览只读：存储未被改动
  const afterPreview = await subRepo.getById(env, sub.id);
  expect(afterPreview?.expiryDate).toBe(before?.expiryDate);
  expect(afterPreview?.paymentHistory).toHaveLength(before?.paymentHistory.length ?? 0);

  if (expected.newStartDate) expect(preview.newStartDate).toBe(expected.newStartDate);
  if (expected.newExpiryDate) expect(preview.newExpiryDate).toBe(expected.newExpiryDate);
  expect(preview.paymentRecord.periodStart).toBe(preview.newStartDate);
  expect(preview.paymentRecord.periodEnd).toBe(preview.newExpiryDate);

  const renewRes = await callRenew(cookie, sub.id, '', renewBody);
  expect(renewRes.status).toBe(200);
  expect(renewRes.body.success).toBe(true);

  const stored = await subRepo.getById(env, sub.id);
  expect(stored?.expiryDate).toBe(preview.newExpiryDate);
  expect(stored?.startDate).toBe(preview.newStartDate);
  const history = stored?.paymentHistory ?? [];
  const lastPayment = history[history.length - 1];
  expect(lastPayment.periodStart).toBe(preview.newStartDate);
  expect(lastPayment.periodEnd).toBe(preview.newExpiryDate);
  expect(lastPayment.date).toBe(preview.paymentRecord.date);
  expect(lastPayment.amount).toBe(preview.paymentRecord.amount);
  return preview;
}

beforeEach(clearKv);

describe('POST /api/subscriptions/:id/renew/preview（A17）', () => {
  it('① 已过期 cycle：从支付日接续，preview 与落库逐字一致', async () => {
    const cookie = await loginCookie();
    // 到期 2026-04-01（当地），支付日 2026-05-10（当地）已过期 → 以支付日为新开始
    const sub = baseSub({ id: 'sub-expired-cycle', expiryDate: '2026-03-31T16:00:00.000Z' });
    await expectPreviewMatchesRenew(
      cookie,
      sub,
      { paymentDate: '2026-05-10', amount: 10 },
      {
        newStartDate: '2026-05-09T16:00:00.000Z',
        newExpiryDate: '2026-06-09T16:00:00.000Z'
      }
    );
  });

  it('② reset：忽略现到期日，从支付日重算', async () => {
    const cookie = await loginCookie();
    // 到期 2026-08-01（当地）尚在未来，reset 仍以支付日 2026-05-10 为新开始
    const sub = baseSub({
      id: 'sub-reset',
      subscriptionMode: 'reset',
      expiryDate: '2026-07-31T16:00:00.000Z'
    });
    await expectPreviewMatchesRenew(
      cookie,
      sub,
      { paymentDate: '2026-05-10', amount: 10 },
      {
        newStartDate: '2026-05-09T16:00:00.000Z',
        newExpiryDate: '2026-06-09T16:00:00.000Z'
      }
    );
  });

  it('③ endOfMonth：1月31日接续 +1月 → 2月28日（月末对齐）', async () => {
    const cookie = await loginCookie();
    // 到期 2026-01-31（当地），支付日 2026-01-15 未到期 → 从到期日接续
    const sub = baseSub({
      id: 'sub-eom',
      endOfMonth: true,
      expiryDate: '2026-01-30T16:00:00.000Z'
    });
    await expectPreviewMatchesRenew(
      cookie,
      sub,
      { paymentDate: '2026-01-15', amount: 10 },
      {
        newStartDate: '2026-01-30T16:00:00.000Z',
        newExpiryDate: '2026-02-27T16:00:00.000Z'
      }
    );
  });

  it('④ 农历：正月初一接续 +1 农历月，preview 与落库逐字一致', async () => {
    const cookie = await loginCookie();
    // 到期 2026-02-17（当地）= 农历丙午年正月初一；支付日 2026-02-01 未到期 → 从到期日接续
    const sub = baseSub({
      id: 'sub-lunar',
      useLunar: true,
      expiryDate: '2026-02-16T16:00:00.000Z'
    });
    const preview = await expectPreviewMatchesRenew(
      cookie,
      sub,
      { paymentDate: '2026-02-01', amount: 10 },
      { newStartDate: '2026-02-16T16:00:00.000Z' }
    );
    // 农历一个月 ≈ 29~30 天：新到期日应比原到期日晚 27~32 天
    const advancedDays =
      (new Date(preview.newExpiryDate).getTime() - new Date(sub.expiryDate).getTime()) / 86400000;
    expect(advancedDays).toBeGreaterThanOrEqual(27);
    expect(advancedDays).toBeLessThanOrEqual(32);
  });

  it('订阅不存在时 preview 返回 400 且不落库', async () => {
    const cookie = await loginCookie();
    const res = await callRenew(cookie, 'sub-not-exist', '/preview', { paymentDate: '2026-05-10' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(await subRepo.getById(env, 'sub-not-exist')).toBeNull();
  });
});
