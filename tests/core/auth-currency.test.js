// @ts-check
/**
 * auth + currency 边界
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import { generateJWT, verifyJWT, timingSafeEqual } from '../../src/core/auth.ts';
import { convertToCNY, getDynamicRates, calculateMonthlyExpense, getUpcomingRenewals } from '../../src/core/currency.ts';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('convertToCNY', () => {
  const rates = { CNY: 1, USD: 7, EUR: 8 };

  it('CNY 原样', () => {
    expect(convertToCNY(10, 'CNY', rates)).toBe(10);
  });

  it('USD 用 rate 换算 amount/rate', () => {
    expect(convertToCNY(14, 'USD', rates)).toBe(2);
  });

  it('未知币种不抛错，返回原金额', () => {
    expect(convertToCNY(5, 'XYZ', rates)).toBe(5);
  });

  it('非正金额返回 0', () => {
    expect(convertToCNY(0, 'USD', rates)).toBe(0);
    expect(convertToCNY(-1, 'USD', rates)).toBe(0);
  });
});

describe('getDynamicRates', () => {
  it('API 失败时返回 FALLBACK', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }));
    const rates = await getDynamicRates(env);
    expect(rates.CNY).toBe(1);
    expect(rates.USD).toBeTruthy();
  });

  it('API 成功时合并并缓存', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ rates: { USD: 7.1, EUR: 8.2 } })
    }));
    const rates = await getDynamicRates(env);
    expect(rates.USD).toBe(7.1);
    // 第二次应走缓存，不再 fetch
    let called = 0;
    vi.stubGlobal('fetch', async () => {
      called++;
      return { ok: true, json: async () => ({ rates: { USD: 1 } }) };
    });
    const rates2 = await getDynamicRates(env);
    expect(called).toBe(0);
    expect(rates2.USD).toBe(7.1);
  });
});

describe('JWT 边界', () => {
  it('空 token/secret → null', async () => {
    expect(await verifyJWT('', 's')).toBeNull();
    expect(await verifyJWT('a.b.c', '')).toBeNull();
  });

  it('格式错误 → null', async () => {
    expect(await verifyJWT('not-a-jwt', 's')).toBeNull();
  });

  it('支持中文用户名与 timingSafeEqual', async () => {
    const token = await generateJWT('管理员_测试', 'sec');
    const payload = await verifyJWT(token, 'sec');
    expect(payload).toBeTruthy();
    expect(payload.username).toBe('管理员_测试');
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });
});

describe('多币种统计与过期汇率缓存兜底', () => {
  it('按支付记录自身 currency 折算而非强制沿用订阅币种', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const subs = [{
      name: 'Cloud',
      currency: 'USD',
      isActive: true,
      expiryDate: '2026-06-20T00:00:00Z',
      paymentHistory: [
        { amount: 70, currency: 'CNY', date: '2026-06-05T00:00:00Z' },
        { amount: 10, currency: 'USD', date: '2026-06-10T00:00:00Z' }
      ]
    }];
    // rate: USD=0.142857 -> 10 USD = 70 CNY (using USD=0.2 for easy exact math -> 10/0.2 = 50 CNY)
    const monthly = calculateMonthlyExpense(subs, 'UTC', { CNY: 1, USD: 0.2 });
    expect(monthly.amount).toBe(120);
  });

  it('API 失败时优先回退过期缓存而非硬编码 FALLBACK', async () => {
    await env.SUBSCRIPTIONS_KV.put('SYSTEM_EXCHANGE_RATES', JSON.stringify({
      ts: Date.now() - 48 * 3600 * 1000,
      rates: { CNY: 1, USD: 0.145 }
    }));
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }));
    const rates = await getDynamicRates(env);
    expect(rates.USD).toBe(0.145);
  });

  it('getUpcomingRenewals 按时区日历日 0..7 天口径对齐', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T01:00:00Z')); // UTC+8 为 09:00
    const subs = [
      { name: 'Today', isActive: true, expiryDate: '2026-06-15T00:00:00Z', amount: 10, currency: 'CNY' },
      { name: 'Day7', isActive: true, expiryDate: '2026-06-22T00:00:00Z', amount: 20, currency: 'CNY' },
      { name: 'Day8', isActive: true, expiryDate: '2026-06-23T00:00:00Z', amount: 30, currency: 'CNY' }
    ];
    const upcoming = getUpcomingRenewals(subs, 'Asia/Shanghai');
    expect(upcoming.map((u) => u.name)).toEqual(['Today', 'Day7']);
  });
});
