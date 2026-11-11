import { describe, expect, it } from 'vitest';
import { formatNotificationContent } from '../../../src/services/notify/reminder.ts';

describe('subscription reminder content', () => {
  it('puts status, date and amount first without decorative emoji or redundant fields', () => {
    const text = formatNotificationContent([{ name: '云服务', expiryDate: '2026-12-11T00:00:00Z', daysRemaining: 3,
      amount: 20, currency: 'CNY', autoRenew: true, customType: '服务', category: '工具', notes: '确认套餐' }],
    { TIMEZONE: 'UTC', SHOW_LUNAR: false });
    expect(text).toMatch(/^云服务\n到期状态: 3 天后到期\n到期日期:/);
    expect(text.indexOf('到期日期')).toBeLessThan(text.indexOf('金额'));
    expect(text).toContain('不代付款');
    expect(text).toContain('确认套餐');
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(text).not.toContain('类型:');
    expect(text).not.toContain('分类:');
  });
});
