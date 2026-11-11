/** Predict the next hourly scheduler check matching a rule and the configured window.
 * This is a rule preview, not a delivery guarantee: channel state and deduplication
 * are evaluated only when the scheduler runs.
 */
import { getDaysBetween, getTimezoneDateParts, getTimestampForTimezoneParts, MS_PER_HOUR } from '../../core/time.js';
import type { ReminderRule } from '../../data/reminders.repo.js';
import { shouldFire } from './reminder-engine.js';

export function nextMatchingCheck(
  rule: ReminderRule,
  expiryIso: string,
  timezone: string,
  hours: string[],
  now: Date = new Date()
): string | null {
  const expiry = new Date(expiryIso).getTime();
  const nowMs = now.getTime();
  if (!rule.isEnabled || !Number.isFinite(expiry) || !Number.isFinite(nowMs)) return null;

  const allowed = hours.map((h) => String(h).trim().toUpperCase()).filter(Boolean)
    .map((h) => /^\d+$/.test(h) ? h.padStart(2, '0') : h);
  const anyHour = allowed.length === 0 || allowed.includes('*') || allowed.includes('ALL');
  const nextHour = Math.floor(nowMs / MS_PER_HOUR) * MS_PER_HOUR + MS_PER_HOUR;
  let anchor: number;
  if (rule.type === 'before_expiry' && rule.unit === 'hours') {
    anchor = expiry - rule.value * MS_PER_HOUR;
  } else {
    const parts = getTimezoneDateParts(expiry, timezone);
    const offsetDays = rule.type === 'before_expiry' ? -rule.value : rule.type === 'after_expiry' ? 1 : 0;
    const target = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays));
    anchor = getTimestampForTimezoneParts({ year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate() }, timezone);
  }
  if (!Number.isFinite(anchor)) return null;
  // Scan around the target local day in UTC hours. This also handles DST transitions
  // and time zones with non-integral UTC offsets without inventing nonexistent times.
  const start = Math.max(nextHour, Math.floor((anchor - 36 * MS_PER_HOUR) / MS_PER_HOUR) * MS_PER_HOUR);
  const end = rule.type === 'after_expiry' ? Math.max(start, anchor) + 72 * MS_PER_HOUR : anchor + 48 * MS_PER_HOUR;
  for (let t = start; t <= end; t += MS_PER_HOUR) {
    const localHour = String(getTimezoneDateParts(t, timezone).hour).padStart(2, '0');
    if (!anyHour && !allowed.includes(localHour)) continue;
    if (shouldFire(rule, { daysDiff: getDaysBetween(t, expiry, timezone), hoursDiff: (expiry - t) / MS_PER_HOUR, nowIso: new Date(t).toISOString() }).fire) {
      return new Date(t).toISOString();
    }
  }
  return null;
}
