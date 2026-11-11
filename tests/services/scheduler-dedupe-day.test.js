// @ts-check
/**
 * 调度器：日规则按本地日去重；发送失败不占 dedupe；after_expiry 写 lastFire
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import { checkExpiringSubscriptions } from '../../src/services/scheduler.ts';
import * as subRepo from '../../src/data/subscriptions.repo.ts';
import * as remindersRepo from '../../src/data/reminders.repo.ts';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('日级去重与成功后占位', () => {
  it('日规则：同一天不同小时第二次应被 dedupe', async () => {
    vi.useFakeTimers();
    // 到期 2026-06-08，当前 6/1 → daysDiff=7
    vi.setSystemTime(new Date('2026-06-01T08:00:00Z'));
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        TIMEZONE: 'UTC',
        NOTIFICATION_HOURS: [],
        ENABLED_NOTIFIERS: ['webhook'],
        WEBHOOK_URL: 'https://example.com/h',
        WEBHOOK_METHOD: 'POST'
      })
    );
    await subRepo.save(env, {
      id: 'day-1',
      name: 'DayRule',
      expiryDate: '2026-06-08T00:00:00.000Z',
      isActive: true,
      autoRenew: false
    });
    await remindersRepo.replaceForSubscription(env, 'day-1', [
      remindersRepo.normalizeRule({
        id: 'r7',
        type: 'before_expiry',
        value: 7,
        unit: 'days',
        isEnabled: true
      })
    ]);

    vi.stubGlobal(
      'fetch',
      async () =>
        /** @type {any} */ ({
          ok: true,
          json: async () => ({ ok: true }),
          text: async () => 'ok'
        })
    );

    const first = await checkExpiringSubscriptions(env);
    expect(first.matchedCount).toBeGreaterThanOrEqual(1);
    expect(first.sentCount).toBeGreaterThanOrEqual(1);

    // 同一天晚些时候
    vi.setSystemTime(new Date('2026-06-01T20:00:00Z'));
    const second = await checkExpiringSubscriptions(env);
    expect(second.dedupedCount).toBeGreaterThanOrEqual(1);
    expect(second.sentCount).toBe(0);
  });

  it('发送全失败时不写 dedupe，同小时可重试', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T08:00:00Z'));
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        TIMEZONE: 'UTC',
        NOTIFICATION_HOURS: [],
        ENABLED_NOTIFIERS: ['webhook'],
        WEBHOOK_URL: 'https://example.com/h',
        WEBHOOK_METHOD: 'POST'
      })
    );
    await subRepo.save(env, {
      id: 'fail-1',
      name: 'FailSend',
      expiryDate: '2026-06-08T00:00:00.000Z',
      isActive: true,
      autoRenew: false
    });
    await remindersRepo.replaceForSubscription(env, 'fail-1', [
      remindersRepo.normalizeRule({
        id: 'r7',
        type: 'before_expiry',
        value: 7,
        unit: 'days',
        isEnabled: true
      })
    ]);

    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls === 1) {
        return /** @type {any} */ ({
          ok: false,
          status: 500,
          json: async () => ({ error: 'down' }),
          text: async () => 'down'
        });
      }
      return /** @type {any} */ ({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => 'ok'
      });
    });

    const first = await checkExpiringSubscriptions(env);
    expect(first.sentCount).toBe(0);

    const second = await checkExpiringSubscriptions(env);
    expect(second.dedupedCount).toBe(0);
    expect(second.sentCount).toBeGreaterThanOrEqual(1);
  });

  it.each(['before_expiry', 'after_expiry'])('部分渠道失败后仅重试失败渠道：%s', async (type) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T08:00:00Z'));
    await env.SUBSCRIPTIONS_KV.put('config', JSON.stringify({
      JWT_SECRET: 's', TIMEZONE: 'UTC', NOTIFICATION_HOURS: [],
      ENABLED_NOTIFIERS: ['webhook', 'telegram'], WEBHOOK_URL: 'https://example.com/h',
      TG_BOT_TOKEN: 'B', TG_CHAT_ID: 'C'
    }));
    await subRepo.save(env, {
      id: 'partial', name: 'Partial', isActive: true, autoRenew: false,
      expiryDate: type === 'after_expiry' ? '2026-06-01T00:00:00Z' : '2026-06-17T00:00:00Z'
    });
    await remindersRepo.replaceForSubscription(env, 'partial', [remindersRepo.normalizeRule({
      id: 'rule', type, value: type === 'before_expiry' ? 7 : 0,
      unit: 'days', repeatInterval: 24, isEnabled: true
    })]);
    let webhookCalls = 0;
    let telegramCalls = 0;
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).includes('example.com')) {
        webhookCalls++;
        return new Response('ok', { status: 200 });
      }
      telegramCalls++;
      return new Response(JSON.stringify(telegramCalls === 1 ? { ok: false } : { ok: true }), {
        status: telegramCalls === 1 ? 500 : 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const first = await checkExpiringSubscriptions(env);
    expect(first.sentCount).toBe(1);
    expect(first.extra.channelResults).toEqual({ webhook: true, telegram: false });
    const second = await checkExpiringSubscriptions(env);
    expect(second.sentCount).toBe(1);
    expect(webhookCalls).toBe(1);
    expect(telegramCalls).toBe(2);
    const third = await checkExpiringSubscriptions(env);
    expect(third.sentCount).toBe(0);
  });

  it('缓慢渠道不会阻止其他渠道发送和保存去重状态', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T08:00:00Z'));
    await env.SUBSCRIPTIONS_KV.put('config', JSON.stringify({
      JWT_SECRET: 's', TIMEZONE: 'UTC', NOTIFICATION_HOURS: [],
      ENABLED_NOTIFIERS: ['webhook', 'telegram'], WEBHOOK_URL: 'https://example.com/h',
      TG_BOT_TOKEN: 'B', TG_CHAT_ID: 'C'
    }));
    await subRepo.save(env, { id: 'concurrent', name: 'Concurrent', isActive: true,
      expiryDate: '2026-06-17T00:00:00Z' });
    await remindersRepo.replaceForSubscription(env, 'concurrent', [remindersRepo.normalizeRule({
      id: 'rule', type: 'before_expiry', value: 7, unit: 'days', isEnabled: true
    })]);
    let releaseWebhook;
    const blockedWebhook = new Promise((resolve) => { releaseWebhook = resolve; });
    let telegramWritten;
    const written = new Promise((resolve) => { telegramWritten = resolve; });
    const kv = env.SUBSCRIPTIONS_KV;
    const wrappedEnv = { ...env, SUBSCRIPTIONS_KV: {
      get: kv.get.bind(kv), list: kv.list.bind(kv), delete: kv.delete.bind(kv),
      put: async (...args) => {
        await kv.put(...args);
        if (String(args[0]).startsWith('notify_dedupe:') && String(args[0]).endsWith(':telegram')) telegramWritten();
      }
    } };
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).includes('example.com')) return blockedWebhook;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const run = checkExpiringSubscriptions(wrappedEnv);
    await written;
    releaseWebhook(new Response('ok', { status: 200 }));
    expect((await run).sentCount).toBe(2);
  });

  it('一个渠道的去重写入失败不会阻止其他渠道记录成功', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T08:00:00Z'));
    await env.SUBSCRIPTIONS_KV.put('config', JSON.stringify({
      JWT_SECRET: 's', TIMEZONE: 'UTC', NOTIFICATION_HOURS: [],
      ENABLED_NOTIFIERS: ['webhook', 'telegram'], WEBHOOK_URL: 'https://example.com/h',
      TG_BOT_TOKEN: 'B', TG_CHAT_ID: 'C'
    }));
    await subRepo.save(env, { id: 'write-error', name: 'Write error', isActive: true,
      expiryDate: '2026-06-17T00:00:00Z' });
    await remindersRepo.replaceForSubscription(env, 'write-error', [remindersRepo.normalizeRule({
      id: 'rule', type: 'before_expiry', value: 7, unit: 'days', isEnabled: true
    })]);
    const kv = env.SUBSCRIPTIONS_KV;
    const wrappedEnv = { ...env, SUBSCRIPTIONS_KV: {
      get: kv.get.bind(kv), list: kv.list.bind(kv), delete: kv.delete.bind(kv),
      put: async (...args) => {
        if (String(args[0]).startsWith('notify_dedupe:') && String(args[0]).endsWith(':webhook')) throw new Error('storage failure');
        return kv.put(...args);
      }
    } };
    vi.stubGlobal('fetch', async (url) => String(url).includes('example.com')
      ? new Response('ok', { status: 200 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const log = await checkExpiringSubscriptions(wrappedEnv);
    expect(log.sentCount).toBe(2);
    expect(log.status).toBe('error');
    expect(log.reason).toContain('webhook');
    expect(await kv.get('notify_dedupe:write-error:rule:20260610:telegram')).toBe('1');
  });

  it('after_expiry：成功后写 lastFire，间隔内不再匹配发送', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T08:00:00Z'));
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        TIMEZONE: 'UTC',
        NOTIFICATION_HOURS: [],
        ENABLED_NOTIFIERS: ['webhook'],
        WEBHOOK_URL: 'https://example.com/h',
        WEBHOOK_METHOD: 'POST'
      })
    );
    await subRepo.save(env, {
      id: 'ae-1',
      name: 'After',
      expiryDate: '2026-06-01T00:00:00.000Z',
      isActive: true,
      autoRenew: false
    });
    await remindersRepo.replaceForSubscription(env, 'ae-1', [
      remindersRepo.normalizeRule({
        id: 'ra',
        type: 'after_expiry',
        value: 0,
        unit: 'days',
        repeatInterval: 24,
        isEnabled: true
      })
    ]);
    vi.stubGlobal(
      'fetch',
      async () =>
        /** @type {any} */ ({
          ok: true,
          json: async () => ({}),
          text: async () => 'ok'
        })
    );

    const first = await checkExpiringSubscriptions(env);
    expect(first.matchedCount).toBeGreaterThanOrEqual(1);
    expect(first.sentCount).toBeGreaterThanOrEqual(1);

    // +2 小时仍在 24h 间隔内，且不同小时桶
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    const second = await checkExpiringSubscriptions(env);
    // shouldFire 因 lastFire 拒绝 → matched 可为 0
    expect(second.sentCount).toBe(0);
  });
});
