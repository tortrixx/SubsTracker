import { describe, expect, it } from 'vitest';
import { nextMatchingCheck } from '../../../src/services/notify/next-check.ts';

const rule = (overrides = {}) => ({ id: 'r', type: 'before_expiry', value: 7, unit: 'days', isEnabled: true, createdAt: '', ...overrides });

describe('next matching scheduler check', () => {
  it('uses the local date and allowed hour instead of the expiry timestamp', () => {
    expect(nextMatchingCheck(rule(), '2026-12-10T16:00:00Z', 'Asia/Shanghai', ['08'], new Date('2026-11-11T04:00:00Z')))
      .toBe('2026-12-04T00:00:00.000Z');
  });
  it('finds a later allowed check on the same day and does not return past checks', () => {
    expect(nextMatchingCheck(rule({ value: 0 }), '2026-12-10T16:00:00Z', 'Asia/Shanghai', ['08', '20'], new Date('2026-12-11T01:00:00Z')))
      .toBe('2026-12-11T12:00:00.000Z');
  });
  it('returns no match for an hourly rule outside the send window', () => {
    expect(nextMatchingCheck(rule({ unit: 'hours', value: 1 }), '2026-12-11T00:00:00Z', 'UTC', ['08'], new Date('2026-12-10T00:00:00Z'))).toBeNull();
  });
  it('handles non-integral timezone offsets and after-expiry day semantics', () => {
    expect(nextMatchingCheck(rule({ type: 'after_expiry', value: 0 }), '2026-06-01T18:15:00Z', 'Asia/Kathmandu', ['08'], new Date('2026-06-01T00:00:00Z')))
      .toBe('2026-06-03T03:00:00.000Z');
  });
  it('skips disabled rules', () => {
    expect(nextMatchingCheck(rule({ isEnabled: false }), '2026-12-10T16:00:00Z', 'UTC', [], new Date('2026-11-11T00:00:00Z'))).toBeNull();
  });
});
