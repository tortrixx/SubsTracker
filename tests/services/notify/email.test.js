// @ts-check
/**
 * 邮件渠道测试：结构化载荷渲染 / 文本回退 / APP_URL 回跳 / 测试示例邮件
 *
 * 覆盖：
 * - buildHtml 优先用 metadata.subscriptions 结构化渲染（正文文本无关）
 * - metadata 缺失或关键字段非法 → 回退 parseContent 文本解析（第三方调用路径）
 * - 配置 APP_URL 时渲染「打开订阅管理」按钮，未配置时不渲染
 * - emailChannel.test() 发送内置示例订阅（过期/今天/即将到期）的真实版式
 * - scheduler → email 端到端：主题为动态标题，结构化载荷完整送达
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';

import { emailChannel, buildHtml } from '../../../src/services/notify/email.ts';
import { checkExpiringSubscriptions } from '../../../src/services/scheduler.ts';
import * as subRepo from '../../../src/data/subscriptions.repo.ts';
import * as remindersRepo from '../../../src/data/reminders.repo.ts';

const EMAIL_CONFIG = {
  RESEND_API_KEY: 'k',
  EMAIL_FROM: 'a@b.com',
  EMAIL_TO: 'c@d.com',
  TIMEZONE: 'UTC'
};

/** reminder.js 格式的纯文本正文（第三方 /api/notify 与旧路径的输入形态） */
const TEXT_CONTENT = `📅 **文本订阅**
类型: 视频会员 (周期: 1 月)
分类: 影音
日历类型: 公历
到期日期: 2026-05-31
自动续期: 是
提醒策略: 提前 3 天
到期状态: 将在 3 天后到期

发送时间: 2026-05-24 08:00:00
当前时区: UTC (UTC+0)`;

const STRUCTURED_SUB = {
  name: '结构化订阅',
  daysRemaining: 0,
  hoursRemaining: 5,
  expiryDate: '2026-05-31T00:00:00.000Z',
  amount: 93,
  currency: 'CNY',
  category: '影音',
  customType: '视频会员',
  periodValue: 1,
  periodUnit: 'month',
  autoRenew: true,
  useLunar: false,
  notes: '',
  reminderText: '提前 3 天'
};

/** mock fetch 并捕获请求体 */
function captureFetch(responseBody = { id: 'mail-1' }) {
  const calls = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  return { spy, calls };
}

beforeEach(async () => {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('buildHtml 结构化渲染', () => {
  it('metadata.subscriptions 存在 → 按结构渲染，忽略正文文本', () => {
    const html = buildHtml('标题', '这段文本不包含任何订阅结构', 'UTC', {
      metadata: { subscriptions: [STRUCTURED_SUB] }
    });
    expect(html).toContain('结构化订阅');
    expect(html).toContain('今天到期');
    expect(html).toContain('¥93.00/周期');
    expect(html).toContain('2026/05/31'); // 与文本路径相同的 zh-CN 日期格式
    expect(html).not.toContain('提醒策略');
    expect(html.indexOf('到期日期')).toBeLessThan(html.indexOf('金额'));
    expect(html).not.toContain('📅');
    expect(html).not.toContain('这段文本不包含');
  });

  it('无 metadata → 回退文本解析', () => {
    const html = buildHtml('标题', TEXT_CONTENT, 'UTC');
    expect(html).toContain('文本订阅');
    expect(html).toContain('将在 3 天后到期');
  });

  it('metadata 关键字段非法 → 整体回退文本解析', () => {
    const html = buildHtml('标题', TEXT_CONTENT, 'UTC', {
      metadata: { subscriptions: [{ name: '缺天数' }] }
    });
    expect(html).toContain('文本订阅');
    expect(html).not.toContain('缺天数');
  });

  it('已过期结构化订阅 → 红色状态文案「已过期 N 天」', () => {
    const html = buildHtml('标题', '', 'UTC', {
      metadata: { subscriptions: [{ ...STRUCTURED_SUB, daysRemaining: -4 }] }
    });
    expect(html).toContain('已过期 4 天');
  });
});

describe('buildHtml APP_URL 回跳按钮', () => {
  it('配置 APP_URL → 渲染「打开订阅管理」按钮', () => {
    const html = buildHtml('标题', TEXT_CONTENT, 'UTC', { appUrl: 'https://app.example.com/subs' });
    expect(html).toContain('打开订阅管理');
    expect(html).toContain('href="https://app.example.com/subs"');
  });

  it('未配置 APP_URL → 不渲染按钮', () => {
    const html = buildHtml('标题', TEXT_CONTENT, 'UTC');
    expect(html).not.toContain('打开订阅管理');
  });
});

describe('emailChannel.test() 示例邮件', () => {
  it('发送三条示例订阅（过期/今天/即将到期），标题注明示例', async () => {
    const { calls } = captureFetch();
    const r = await emailChannel.test({ ...EMAIL_CONFIG });
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(body.subject).toContain('测试通知');
    expect(body.subject).toContain('示例');
    expect(body.html).toContain('示例 · Netflix');
    expect(body.html).toContain('已过期 2 天');
    expect(body.html).toContain('示例 · iCloud');
    expect(body.html).toContain('今天到期');
    expect(body.html).toContain('示例 · Spotify');
    expect(body.html).toContain('3 天后到期');
    expect(body.text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe('scheduler → email 端到端', () => {
  it('主题为动态标题，Resend 收到结构化渲染的 HTML', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00.000Z')); // 北京 5/24 08:00

    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        JWT_SECRET: 's',
        TIMEZONE: 'Asia/Shanghai',
        NOTIFICATION_HOURS: [],
        ENABLED_NOTIFIERS: ['email'],
        RESEND_API_KEY: 'k',
        EMAIL_FROM: 'a@b.com',
        EMAIL_TO: 'c@d.com'
      })
    );
    await subRepo.save(env, {
      id: 's-nf',
      name: 'Netflix',
      isActive: true,
      autoRenew: false,
      expiryDate: '2026-05-27T03:00:00.000Z', // 北京 5/27 → 距 3 天
      currency: 'CNY',
      amount: 93,
      periodValue: 1,
      periodUnit: 'month'
    });
    await remindersRepo.replaceForSubscription(env, 's-nf', [
      remindersRepo.normalizeRule({ type: 'before_expiry', value: 3, unit: 'days' })
    ]);

    const { calls } = captureFetch();
    const log = await checkExpiringSubscriptions(env);
    expect(log.sentCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].body.subject).toBe('Netflix 3 天后到期');
    expect(calls[0].body.html).toContain('Netflix');
    expect(calls[0].body.html).toContain('3 天后到期');
  });
});
