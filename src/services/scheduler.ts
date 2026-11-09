/**
 * 定时任务调度器
 *
 * ── 修复的核心问题（#91 / #52 / #166 根因）─────────────────
 * 旧调度器把"当前 UTC 时刻的小时"当作"用户本地小时"来对比 NOTIFICATION_HOURS，
 * 配合"通知时段语义不一致"的文档表述，造成大量"不响 / 错时响"。
 *
 * 修复：
 * 1. 统一时区基准：通过 getNowInTimezone(config.TIMEZONE) 取用户 TZ 下的 hourString
 *    与 NOTIFICATION_HOURS（按用户 TZ 解释）比对，语义清晰。
 * 2. 多提醒规则：从 reminders.repo 加载每个订阅的规则数组，逐条调
 *    reminder-engine.shouldFire 判断（不再单点 reminderUnit/reminderValue）。
 * 3. 去重粒度细化：dedup key 改为 (subId × ruleId × ymdh-local)，避免一条订阅
 *    多规则相互打架。
 * 4. 结构化日志：每次执行写一条 sched_log；每条通知发送（成功/失败）写 notify_log。
 *
 * 数据流：
 *   Cron tick →
 *     ensureMigrations →
 *     load config + subs + rules →
 *     check window →
 *     for each (sub, rule):
 *       - daysDiff/hoursDiff 用 getDaysBetween（按用户 TZ）算
 *       - 自动续订（针对 sub 整体，仅算一次）
 *       - shouldFire? → dedupe → dispatch.send → notify_log
 *     → sched_log
 *
 */

import { getConfig } from '../data/config.js';
import type { AppConfig } from '../data/config.js';
import { getAllSubscriptions } from '../data/subscriptions.js';
import * as subRepo from '../data/subscriptions.repo.js';
import * as remindersRepo from '../data/reminders.repo.js';
import * as schedulerLogsRepo from '../data/scheduler-logs.repo.js';
import type { ReminderRule } from '../data/reminders.repo.js';
import type { SchedulerLogEntry } from '../data/scheduler-logs.repo.js';
import {
  MS_PER_HOUR,
  getNowInTimezone,
  getDaysBetween,
  getTimezoneDateParts,
  getTimezoneMidnightTimestamp,
  addCalendarPeriodInTimezone,
  getTimestampForTimezoneParts
} from '../core/time.js';
import { formatNotificationContent, formatMatchedReminderRule } from './notify/reminder.js';
import { dispatch } from './notify/dispatch.js';
import { shouldFire } from './notify/reminder-engine.js';
import { lunarCalendar, lunarBiz } from '../core/lunar.js';
import type { LunarDate, LunarDateInput } from '../core/lunar.js';
import type { AppEnv } from '../platform/storage/storage-port.js';

const DEDUPE_TTL_SEC = 60 * 60 * 48; // 48h
const LAST_FIRE_TTL_SEC = 60 * 60 * 24 * 60; // 60 天

/** 一次调度里命中的 (订阅, 规则) 候选；sub 为数据层订阅对象（形状待 data 层 Subscription 类型收紧） */
interface Candidate {
  sub: any;
  rule: ReminderRule;
  daysDiff: number;
  hoursDiff: number;
}

/**
 * 日级规则（before_expiry/days、on_expiry）按本地日期去重；小时级与 after_expiry 按本地小时。
 */
function buildDedupeBucket(rule: ReminderRule, nowParts: { year: number; month: number; day: number; hourString: string }): string {
  const ymd = `${nowParts.year}${String(nowParts.month).padStart(2, '0')}${String(nowParts.day).padStart(2, '0')}`;
  const isDayRule =
    rule.type === 'on_expiry' ||
    (rule.type === 'before_expiry' && rule.unit !== 'hours');
  return isDayRule ? ymd : `${ymd}${nowParts.hourString}`;
}

async function readLastFireAt(env: AppEnv, subId: string, ruleId: string) {
  return env.SUBSCRIPTIONS_KV.get(`notify_lastfire:${subId}:${ruleId}`);
}

async function writeLastFireAt(env: AppEnv, subId: string, ruleId: string, iso: string): Promise<void> {
  await env.SUBSCRIPTIONS_KV.put(`notify_lastfire:${subId}:${ruleId}`, iso, {
    expirationTtl: LAST_FIRE_TTL_SEC
  });
}

/**
 * 按最紧迫订阅生成通知标题，让收件箱/推送列表里就能判断轻重。
 * 入参已按 daysRemaining 升序排列（最紧迫在前）。三种紧迫度：
 * 已过期 N 天 / 今天到期 / N 天后到期；多项时附「另有 N 项」计数，
 * 其余项全部在未来时用「即将到期」收尾。
 */
export function buildNotificationTitle(subs: Array<{ name: string; daysRemaining: number }>): string {
  if (!Array.isArray(subs) || subs.length === 0) return '订阅到期/续费提醒';
  const first = subs[0];
  const days = Number(first.daysRemaining);
  let headline;
  if (days < 0) headline = `${first.name} 已过期 ${Math.abs(days)} 天`;
  else if (days === 0) headline = `${first.name} 今天到期`;
  else headline = `${first.name} ${days} 天后到期`;
  if (subs.length === 1) return headline;
  const rest = subs.slice(1);
  return rest.every((s) => Number(s.daysRemaining) > 0)
    ? `${headline} · 另有 ${rest.length} 项即将到期`
    : `${headline} · 另有 ${rest.length} 项`;
}

/**
 * 入口：被 Cron 触发的 scheduled() 调用。
 */
export async function checkExpiringSubscriptions(env: AppEnv): Promise<SchedulerLogEntry | null> {
  const startedAtIso = new Date().toISOString();
  try {
    const config: AppConfig = await getConfig(env);
    const timezone = config.TIMEZONE || 'UTC';
    const now = getNowInTimezone(timezone);

    const normalizedHours = Array.isArray(config.NOTIFICATION_HOURS)
      ? config.NOTIFICATION_HOURS
          .map((h) => String(h).trim())
          .filter((h) => h.length > 0)
          .map((h) => {
            const up = h.toUpperCase();
            if (up === '*' || up === 'ALL') return '*';
            // 仅对纯数字做两位补齐；'*' 之类通配符保持原样
            return /^\d+$/.test(h) ? h.padStart(2, '0') : up;
          })
      : [];
    const inWindow =
      normalizedHours.length === 0 ||
      normalizedHours.includes('*') ||
      normalizedHours.includes('ALL') ||
      normalizedHours.includes(now.hourString);

    const subscriptions = await getAllSubscriptions(env);
    let activeCount = 0;
    let matchedCount = 0;
    let dedupedCount = 0;
    let sentCount = 0;
    let autoRenewedCount = 0;

    // 不在通知时段：不发送但仍跑自动续订（业务上希望续订总能发生）
    const candidates: Candidate[] = [];

    const updatedSubsToSave: any[] = [];

    for (const subscription of subscriptions) {
      if (!subscription.isActive) continue;
      activeCount++;

      // 计算到期天数（按用户 TZ）
      let expiryDate = new Date(subscription.expiryDate);
      let daysDiff = getDaysBetween(now.utc, expiryDate, timezone);
      let hoursDiff = (expiryDate.getTime() - now.utc.getTime()) / MS_PER_HOUR;

      // 自动续订：已过期 + autoRenew=true → 推进到期日并写支付记录
      if (subscription.autoRenew && daysDiff < 0) {
        const renewed = autoRenew(subscription, now.utc, timezone, config);
        if (renewed) {
          updatedSubsToSave.push(renewed.next);
          autoRenewedCount++;
          // 续订后重算 diff
          expiryDate = new Date(renewed.next.expiryDate);
          daysDiff = getDaysBetween(now.utc, expiryDate, timezone);
          hoursDiff = (expiryDate.getTime() - now.utc.getTime()) / MS_PER_HOUR;
          // 用续订后的对象作后续判断
          subscription.expiryDate = renewed.next.expiryDate;
          subscription.startDate = renewed.next.startDate;
          subscription.lastPaymentDate = renewed.next.lastPaymentDate;
          subscription.paymentHistory = renewed.next.paymentHistory;
        }
      }

      // 加载规则；老订阅没有规则时，用稳定 id 的 legacy 规则（避免每 tick 新 UUID 打穿 dedupe）
      let rules = await remindersRepo.listForSubscription(env, subscription.id);
      if (rules.length === 0) {
        const legacy = remindersRepo.legacyFieldToRule(subscription);
        legacy.id = `legacy:${subscription.id}`;
        rules = [legacy];
      }

      for (const rule of rules) {
        const lastFireAtIso =
          rule.type === 'after_expiry'
            ? (await readLastFireAt(env, subscription.id, rule.id)) || undefined
            : undefined;
        const decision = shouldFire(rule, {
          daysDiff,
          hoursDiff,
          nowIso: now.utc.toISOString(),
          lastFireAtIso
        });
        if (!decision.fire) continue;
        matchedCount++;
        candidates.push({ sub: subscription, rule, daysDiff, hoursDiff });
      }
    }

    // 持久化自动续订结果
    if (updatedSubsToSave.length > 0) {
      await subRepo.saveMany(env, updatedSubsToSave);
      console.log(`[定时任务] 已自动续订 ${updatedSubsToSave.length} 个订阅`);
    }

    // 不在通知时段 → 写日志后返回
    if (!inWindow) {
      const entry = await schedulerLogsRepo.writeLog(env, {
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        timezone,
        currentHour: now.hourString,
        configuredHours: normalizedHours,
        inWindow: false,
        checkedCount: activeCount,
        matchedCount,
        dedupedCount: 0,
        sentCount: 0,
        autoRenewedCount,
        status: 'skipped',
        reason: `当前${timezone} ${now.hourString}点不在允许发送的小时 [${normalizedHours.join(',') || '未限制=每小时'}] 内（正常跳过，不会发通知）`
      });
      return entry;
    }

    // 在时段：先查重（不预占），发送成功后再写 dedupe / lastFire
    const ready: Array<Candidate & { dedupeKey: string }> = [];
    const nowParts = {
      year: now.parts.year,
      month: now.parts.month,
      day: now.parts.day,
      hourString: now.hourString
    };
    for (const c of candidates) {
      const bucket = buildDedupeBucket(c.rule, nowParts);
      const dedupeKey = `notify_dedupe:${c.sub.id}:${c.rule.id}:${bucket}`;
      const exists = await env.SUBSCRIPTIONS_KV.get(dedupeKey);
      if (exists) {
        dedupedCount++;
        continue;
      }
      ready.push({ ...c, dedupeKey });
    }

    if (ready.length === 0) {
      const entry = await schedulerLogsRepo.writeLog(env, {
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        timezone,
        currentHour: now.hourString,
        configuredHours: normalizedHours,
        inWindow: true,
        checkedCount: activeCount,
        matchedCount,
        dedupedCount,
        sentCount: 0,
        autoRenewedCount,
        status: matchedCount > 0 ? 'skipped' : 'ok',
        reason:
          matchedCount > 0
            ? `命中 ${matchedCount} 条规则但全部在去重窗口内（跳过 ${dedupedCount}）`
            : '本次未命中任何提醒规则'
      });
      return entry;
    }

    // 排序：按剩余天数升序，更紧迫的在前
    ready.sort((a, b) => a.daysDiff - b.daysDiff);

    // 一次性聚合所有订阅成一条通知（与既有渠道契约一致）
    // notify_log 按 (subId, ruleId, channel) 维度落，仍可细粒度查询
    const enrichedSubs = ready.map((c) => ({
      ...c.sub,
      daysRemaining: c.daysDiff,
      hoursRemaining: Math.round(c.hoursDiff),
      matchedReminderRule: c.rule
    }));
    const content = formatNotificationContent(enrichedSubs, config);
    const title = buildNotificationTitle(enrichedSubs);

    // 给 dispatch 提供主 subId+ruleId（聚合通知用第一条做归属）
    const primary = ready[0];
    const dispatchResult = await dispatch(
      { title, content },
      config,
      {
        env,
        subId: primary.sub.id,
        ruleId: primary.rule.id,
        logPrefix: '[定时任务]',
        metadata: {
          tags: enrichedSubs.map((s) => s.name),
          daysRemaining: primary.daysDiff,
          ruleType: primary.rule.type,
          ruleValue: primary.rule.value,
          // 结构化订阅原件：富渲染渠道（如邮件）直接用结构排版，
          // 不必再从纯文本正文反解析。只放渲染所需字段，
          // 不带 paymentHistory 等无关数据。
          subscriptions: enrichedSubs.map((s) => ({
            name: s.name,
            daysRemaining: s.daysRemaining,
            hoursRemaining: s.hoursRemaining,
            expiryDate: s.expiryDate,
            amount: s.amount ?? null,
            currency: s.currency || 'CNY',
            category: s.category || '',
            customType: s.customType || '',
            periodValue: s.periodValue ?? null,
            periodUnit: s.periodUnit || '',
            autoRenew: !!s.autoRenew,
            useLunar: !!s.useLunar,
            notes: s.notes || '',
            reminderText: s.matchedReminderRule
              ? formatMatchedReminderRule(s.matchedReminderRule)
              : ''
          }))
        }
      }
    );
    sentCount = dispatchResult.successCount;

    // 仅在至少一渠道成功时写入去重与 lastFire，失败可在后续 tick 重试
    if (dispatchResult.successCount > 0) {
      const firedAt = now.utc.toISOString();
      await Promise.all(
        ready.map(async (c) => {
          await env.SUBSCRIPTIONS_KV.put(c.dedupeKey, '1', { expirationTtl: DEDUPE_TTL_SEC });
          if (c.rule.type === 'after_expiry') {
            await writeLastFireAt(env, c.sub.id, c.rule.id, firedAt);
          }
        })
      );
    }

    const entry = await schedulerLogsRepo.writeLog(env, {
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      timezone,
      currentHour: now.hourString,
      configuredHours: normalizedHours,
      inWindow: true,
      checkedCount: activeCount,
      matchedCount,
      dedupedCount,
      sentCount,
      autoRenewedCount,
      status: dispatchResult.failedCount > 0 && sentCount === 0 ? 'error' : 'ok',
      reason:
        dispatchResult.attempted > 0
          ? `发送到 ${dispatchResult.attempted} 个渠道，成功 ${dispatchResult.successCount} / 失败 ${dispatchResult.failedCount}`
          : '未启用任何通知渠道',
      extra: {
        candidates: ready.map((c) => ({
          subId: c.sub.id,
          subName: c.sub.name,
          ruleId: c.rule.id,
          ruleType: c.rule.type,
          ruleValue: c.rule.value,
          daysDiff: c.daysDiff
        })),
        channelResults: dispatchResult.channelResults
      }
    });
    return entry;
  } catch (error: any) {
    // 边界：调度异常形态不限，落日志时统一字符串化
    console.error('[定时任务] 执行失败:', error);
    return schedulerLogsRepo.writeLog(env, {
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      timezone: 'UTC',
      currentHour: '00',
      configuredHours: [],
      inWindow: false,
      checkedCount: 0,
      matchedCount: 0,
      dedupedCount: 0,
      sentCount: 0,
      autoRenewedCount: 0,
      status: 'error',
      reason: '执行异常: ' + (error && error.message ? error.message : String(error)),
      extra: { stack: error && error.stack }
    });
  }
}

/**
 * 自动续订：把已过期的订阅按周期推进，生成 auto 类型支付记录。
 *
 * 按"cycle / reset 模式 + 公历 / 农历分支。
 *
 * sub / 返回的 next 为数据层订阅对象（形状待 data 层 Subscription 类型收紧，先沿原 JSDoc 用 any）。
 */
function autoRenew(sub: any, now: Date, timezone: string, config: AppConfig): { next: any } | null {
  const mode = sub.subscriptionMode || 'cycle';
  const tz = timezone || 'UTC';
  let expiryDate = new Date(sub.expiryDate);
  let periodsAdded = 0;
  const nowMidnight = getTimezoneMidnightTimestamp(now, tz);

  function atTimezoneMidnight(y: number, m: number, d: number): Date {
    const ts = getTimestampForTimezoneParts(
      { year: y, month: m, day: d, hour: 0, minute: 0, second: 0 },
      tz
    );
    return new Date(ts);
  }

  if (sub.useLunar) {
    let parts = getTimezoneDateParts(expiryDate, tz);
    let lunar: LunarDate | LunarDateInput | null = lunarCalendar.solar2lunar(parts.year, parts.month, parts.day);
    while (getTimezoneMidnightTimestamp(expiryDate, tz) <= nowMidnight) {
      if (!lunar) break;
      lunar = lunarBiz.addLunarPeriod(lunar, sub.periodValue, sub.periodUnit);
      // 断言仅过类型层：lunar 为 null 时与原 JS 一样把 null 传下去（行为不变）
      const solar = lunarBiz.lunar2solar(lunar as LunarDateInput);
      if (!solar) break;
      expiryDate = atTimezoneMidnight(solar.year, solar.month, solar.day);
      periodsAdded++;
      if (periodsAdded > 60) break;
    }
  } else {
    while (getTimezoneMidnightTimestamp(expiryDate, tz) <= nowMidnight) {
      if (mode === 'reset') {
        // 重置：从「现在」所在本地日重新起算一个周期
        const p = getTimezoneDateParts(now, tz);
        expiryDate = atTimezoneMidnight(p.year, p.month, p.day);
      }
      expiryDate = addCalendarPeriodInTimezone(
        expiryDate,
        sub.periodValue || 1,
        sub.periodUnit || 'month',
        tz,
        { endOfMonth: !!sub.endOfMonth }
      );
      periodsAdded++;
      if (periodsAdded > 120) break;
    }
  }

  if (periodsAdded === 0) return null;

  const newStartDate = mode === 'reset' ? new Date(now) : new Date(sub.expiryDate);
  const newExpiryDate = expiryDate;

  const paymentRecord = {
    id: Date.now().toString(),
    date: now.toISOString(),
    amount: sub.amount || 0,
    type: 'auto',
    note: `自动续订 (${mode === 'reset' ? '重置模式' : '接续模式'}${
      periodsAdded > 1 ? ', 补齐' + periodsAdded + '周期' : ''
    })`,
    periodStart: newStartDate.toISOString(),
    periodEnd: newExpiryDate.toISOString()
  };

  const paymentHistoryLimit = Number(config.PAYMENT_HISTORY_LIMIT) || 100;
  const ph = [...(sub.paymentHistory || []), paymentRecord];
  const trimmed = ph.length > paymentHistoryLimit ? ph.slice(-paymentHistoryLimit) : ph;

  return {
    next: {
      ...sub,
      startDate: newStartDate.toISOString(),
      expiryDate: newExpiryDate.toISOString(),
      lastPaymentDate: now.toISOString(),
      paymentHistory: trimmed
    }
  };
}
