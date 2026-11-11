import { formatTimeInTimezone, getTimezoneDateParts } from '../../core/time.js';
import { lunarCalendar } from '../../core/lunar.js';
import { formatAmount } from '../../core/currency-format.js';
import type { AppConfig } from '../../data/config.js';

/** 归一化后的提醒设置（由订阅上的散字段解析而来） */
export interface ReminderSetting {
  unit: 'hour' | 'day';
  value: number;
}

/** 订阅对象上与提醒设置相关的原始字段（可能来自表单/KV，类型不齐） */
export interface ReminderSettingInput {
  reminderDays?: number | string;
  reminderUnit?: string;
  reminderValue?: number | string | null;
  reminderHours?: number | string | null;
}

/** formatMatchedReminderRule 需要的规则字段子集（结构化子集，避免与数据层全量规则类型耦合） */
export interface MatchedReminderRule {
  type: string;
  value: number;
  unit: string;
  repeatInterval?: number | null;
}

/** 通知正文渲染所需的订阅视图（scheduler 传入的 enriched 订阅形状） */
export interface NotificationSubscription extends ReminderSettingInput {
  name: string;
  expiryDate: string;
  daysRemaining: number;
  customType?: string;
  category?: string;
  periodValue?: number | string | null;
  periodUnit?: string;
  matchedReminderRule?: MatchedReminderRule | null;
  useLunar?: boolean;
  autoRenew?: boolean;
  amount?: number | string | null;
  currency?: string;
  notes?: string;
}

/**
 * 按用户时区把到期日转成农历展示文案，避免用 Date 本地分量导致差一天。
 *
 * @returns 空串表示无法转换或不展示
 */
function formatLunarExpiryText(expiry: Date | string | number, timezone: string): string {
  const parts = getTimezoneDateParts(expiry, timezone || 'UTC');
  const lunarExpiry = lunarCalendar.solar2lunar(parts.year, parts.month, parts.day);
  return lunarExpiry ? `\n农历日期: ${lunarExpiry.fullStr}` : '';
}

function resolveReminderSetting(subscription: ReminderSettingInput | null | undefined): ReminderSetting {
  const defaultDays = subscription && subscription.reminderDays !== undefined ? Number(subscription.reminderDays) : 7;
  let unit: 'hour' | 'day' = subscription && subscription.reminderUnit === 'hour' ? 'hour' : 'day';

  let value;
  if (unit === 'hour') {
    if (subscription && subscription.reminderValue !== undefined && subscription.reminderValue !== null && !isNaN(Number(subscription.reminderValue))) {
      value = Number(subscription.reminderValue);
    } else if (subscription && subscription.reminderHours !== undefined && subscription.reminderHours !== null && !isNaN(Number(subscription.reminderHours))) {
      value = Number(subscription.reminderHours);
    } else {
      value = 0;
    }
  } else {
    if (subscription && subscription.reminderValue !== undefined && subscription.reminderValue !== null && !isNaN(Number(subscription.reminderValue))) {
      value = Number(subscription.reminderValue);
    } else if (!isNaN(defaultDays)) {
      value = Number(defaultDays);
    } else {
      value = 7;
    }
  }

  if (value < 0 || isNaN(value)) {
    value = 0;
  }

  return { unit, value };
}

function shouldTriggerReminder(reminder: ReminderSetting | null | undefined, daysDiff: number, hoursDiff: number): boolean {
  if (!reminder) {
    return false;
  }
  if (reminder.unit === 'hour') {
    if (reminder.value === 0) {
      return hoursDiff >= 0 && hoursDiff < 1;
    }
    return hoursDiff >= 0 && hoursDiff <= reminder.value;
  }
  if (reminder.value === 0) {
    return daysDiff === 0;
  }
  return daysDiff >= 0 && daysDiff <= reminder.value;
}

function formatMatchedReminderRule(rule: MatchedReminderRule): string {
  if (rule.type === 'on_expiry') return '到期当天';
  if (rule.type === 'after_expiry') {
    return `到期后每 ${rule.repeatInterval || 24} 小时`;
  }
  if (rule.value === 0) return rule.unit === 'hours' ? '到期当小时' : '到期当天';
  return `提前 ${rule.value} ${rule.unit === 'hours' ? '小时' : '天'}`;
}

function formatNotificationContent(subscriptions: NotificationSubscription[], config: AppConfig): string {
  const showLunar = config.SHOW_LUNAR === true;
  const timezone = config?.TIMEZONE || 'UTC';
  let content = '';

  for (const sub of subscriptions) {
    const expiryDateObj = new Date(sub.expiryDate);
    const formattedExpiryDate = formatTimeInTimezone(expiryDateObj, timezone, 'date');

    let lunarExpiryText = '';
    if (showLunar) {
      lunarExpiryText = formatLunarExpiryText(expiryDateObj, timezone);
    }

    let statusText = '';
    if (sub.daysRemaining === 0) {
      statusText = '今天到期';
    } else if (sub.daysRemaining < 0) {
      statusText = `已过期 ${Math.abs(sub.daysRemaining)} 天`;
    } else {
      statusText = `${sub.daysRemaining} 天后到期`;
    }
    const formattedAmount = formatAmount(sub.amount, sub.currency || 'CNY');
    const amountText = formattedAmount ? `\n金额: ${formattedAmount}/周期` : '';
    const subscriptionContent = `${sub.name}
到期状态: ${statusText}
到期日期: ${formattedExpiryDate}${lunarExpiryText}${amountText}
续期: ${sub.autoRenew ? '自动更新日期（不代付款）' : '手动更新日期'}`;

    let finalContent = sub.notes ? 
      subscriptionContent + `\n备注: ${sub.notes}` : 
      subscriptionContent;

    content += finalContent + '\n\n';
  }

  content += `时区: ${timezone}`;

  return content;
}

export { resolveReminderSetting, shouldTriggerReminder, formatNotificationContent, formatMatchedReminderRule, formatLunarExpiryText };
