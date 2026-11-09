// @ts-check
/**
 * 动态通知标题单元测试（scheduler.buildNotificationTitle）
 *
 * 标题按最紧迫订阅生成（入参已按 daysRemaining 升序），覆盖三种紧迫度：
 * 已过期 / 今天到期 / N 天后到期，以及单项与多项的文案组合。
 */
import { describe, it, expect } from 'vitest';
import { buildNotificationTitle } from '../../src/services/scheduler.ts';

describe('buildNotificationTitle', () => {
  it('空数组 → 回退通用标题', () => {
    expect(buildNotificationTitle([])).toBe('订阅到期/续费提醒');
  });

  it('单项已过期 → 「名称 已过期 N 天」', () => {
    expect(buildNotificationTitle([{ name: 'Netflix', daysRemaining: -3 }])).toBe(
      'Netflix 已过期 3 天'
    );
  });

  it('单项今天到期 → 「名称 今天到期」', () => {
    expect(buildNotificationTitle([{ name: 'iCloud', daysRemaining: 0 }])).toBe('iCloud 今天到期');
  });

  it('单项在未来 → 「名称 N 天后到期」', () => {
    expect(buildNotificationTitle([{ name: 'Spotify', daysRemaining: 5 }])).toBe(
      'Spotify 5 天后到期'
    );
  });

  it('多项且其余都在未来 → 附「另有 N 项即将到期」', () => {
    const title = buildNotificationTitle([
      { name: 'ChatGPT Plus', daysRemaining: 0 },
      { name: 'Netflix', daysRemaining: 2 },
      { name: 'Spotify', daysRemaining: 6 }
    ]);
    expect(title).toBe('ChatGPT Plus 今天到期 · 另有 2 项即将到期');
  });

  it('多项且其余含已过期/今天到期 → 附中性的「另有 N 项」', () => {
    const title = buildNotificationTitle([
      { name: 'Netflix', daysRemaining: -3 },
      { name: 'iCloud', daysRemaining: 0 }
    ]);
    expect(title).toBe('Netflix 已过期 3 天 · 另有 1 项');
  });

  it('多项且第一项在未来、其余更远 → 仍走「即将到期」', () => {
    const title = buildNotificationTitle([
      { name: 'Spotify', daysRemaining: 2 },
      { name: 'Netflix', daysRemaining: 9 }
    ]);
    expect(title).toBe('Spotify 2 天后到期 · 另有 1 项即将到期');
  });
});
