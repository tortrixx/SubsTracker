/**
 * 提醒规则 / 通知日志 / 调度日志 路由
 *
 * 接口表（路径前缀 /api）：
 *   GET    /subscriptions/:id/reminders           列出某订阅的提醒规则
 *   POST   /subscriptions/:id/reminders           新增一条规则
 *   PUT    /subscriptions/:id/reminders/:ruleId   更新一条规则
 *   DELETE /subscriptions/:id/reminders/:ruleId   删除一条规则
 *
 *   GET    /notification-logs?subId=&channel=&status=&since=&limit=
 *                                                 查询通知日志
 *   GET    /scheduler-logs?limit=N                查询调度执行日志
 *
 * 鉴权：与既有客户端约定一致——需要登录（cookie token），由 router.js 在 routes 之前
 * 统一校验。本文件被 router.js 调用，不再单独校验。
 *
 */

import * as remindersRepo from '../../data/reminders.repo.js';
import * as notifyLogsRepo from '../../data/notification-logs.repo.js';
import * as schedLogsRepo from '../../data/scheduler-logs.repo.js';
import { getCategories, addCategory } from '../../data/categories.js';
import { nextMatchingCheck } from '../../services/notify/next-check.js';
import { formatTimezoneDisplay, isValidTimezone, parseDateInputInTimezone } from '../../core/time.js';
import { ALL_CHANNELS } from '../../services/notify/dispatch.js';
import { checkExpiringSubscriptions } from '../../services/scheduler.js';
import { getConfig, type AppConfig } from '../../data/config.js';
import type { AppEnv } from '../../platform/storage/storage-port.js';
import type { ReminderRule } from '../../data/reminders.repo.js';
import type { NotifyLogQuery } from '../../data/notification-logs.repo.js';

export const VERSION: string = '3.0.0';

/** 标准 JSON 响应 */
function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * 规则变更后同步订阅上的 legacy 提醒字段，保证列表展示一致。
 */
async function syncLegacyAfterRulesChange(env: AppEnv, subId: string, rules?: ReminderRule[]): Promise<void> {
  try {
    const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
    const list = rules || (await remindersRepo.listForSubscription(env, subId));
    await syncLegacyReminderFields(env, subId, list);
  } catch (err) {
    console.error('[reminders] 同步 legacy 字段失败:', err);
  }
}

/**
 * 处理提醒规则 / 通知日志 / 调度日志相关的 新 API。
 * 返回 null 表示路径不匹配，由调用方继续转给下一组路由。
 *
 * path 为已剥离 /api 前缀的路径
 */
export async function handleExtraRoutes(
  request: Request,
  env: AppEnv,
  path: string,
  preloadedConfig?: AppConfig
): Promise<Response | null> {
  const method = request.method;

  // /subscriptions/:id/reminders[/:ruleId]
  const remMatch = path.match(/^\/subscriptions\/([^/]+)\/reminders(?:\/([^/]+))?\/?$/);
  if (remMatch) {
    const [, subId, ruleId] = remMatch;
    return handleReminderRoute(request, env, method, subId, ruleId);
  }

  // 批量计算全部活跃订阅的下次规则命中时间（消除概览页 N+1 请求瀑布流）
  if (path === '/subscriptions/next-reminders' && method === 'GET') {
    const subRepo = await import('../../data/subscriptions.repo.js');
    const subs = await subRepo.listAll(env);
    const config = preloadedConfig || await getConfig(env);
    const tz = config.TIMEZONE || 'UTC';
    const hours = Array.isArray(config.NOTIFICATION_HOURS) ? config.NOTIFICATION_HOURS : [];
    const now = new Date();
    const activeSubs = subs.filter((s) => s.isActive);

    const perSub = await Promise.all(
      activeSubs.map(async (sub) => {
        const rules = await remindersRepo.listForSubscription(env, sub.id);
        const times = rules
          .filter((r) => !(sub.autoRenew && r.type === 'after_expiry'))
          .map((r) => ({
            subId: sub.id,
            subName: sub.name,
            ruleId: r.id,
            type: r.type,
            value: r.value,
            unit: r.unit,
            nextFireTime: nextMatchingCheck(r, sub.expiryDate, tz, hours, now)
          }))
          .filter((t) => t.nextFireTime !== null)
          .sort((a, b) => new Date(a.nextFireTime as string).getTime() - new Date(b.nextFireTime as string).getTime());
        return times[0] || null;
      })
    );

    const items = perSub
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => new Date(a.nextFireTime as string).getTime() - new Date(b.nextFireTime as string).getTime());
    return json({ success: true, nextReminder: items[0] || null, items });
  }

  // /reminders/preview（只读预测：不写存储、不发通知，共享 validateReminderRules + nextMatchingCheck）
  if (path === '/reminders/preview' && method === 'POST') {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ success: false, message: '请求体不是合法 JSON' }, 400);
    }
    const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const config = preloadedConfig || await getConfig(env);
    const tzReq = typeof body.timezone === 'string' ? body.timezone.trim() : '';
    const timezone = tzReq && isValidTimezone(tzReq) ? tzReq : (config.TIMEZONE || 'UTC');
    const hours = Array.isArray(body.notificationHours)
      ? body.notificationHours.map((h) => String(h))
      : (Array.isArray(config.NOTIFICATION_HOURS) ? config.NOTIFICATION_HOURS : []);
    const enabledNotifiers = Array.isArray(config.ENABLED_NOTIFIERS) ? config.ENABLED_NOTIFIERS : [];

    if (body.rules === undefined) {
      return json({ success: false, message: '缺少 rules 参数' }, 400);
    }
    const validation = remindersRepo.validateReminderRules(body.rules);
    if (!validation.ok) {
      return json({ success: false, message: validation.message }, 400);
    }

    const expiryRaw = typeof body.expiryDate === 'string' ? body.expiryDate.trim() : '';
    if (!expiryRaw) {
      return json({ success: false, message: '请先选择到期日期' }, 400);
    }
    const expiryDate = parseDateInputInTimezone(expiryRaw, timezone);
    if (Number.isNaN(expiryDate.getTime())) {
      return json({ success: false, message: '到期日期无效' }, 400);
    }

    const isActive = body.isActive !== false;
    const autoRenew = body.autoRenew === true;
    const expiryIso = expiryDate.toISOString();
    const now = new Date();

    const perRule = validation.rules.map((r, index) => {
      let nextFireTime: string | null = null;
      let skippedReason: string | null = null;
      if (!isActive) {
        skippedReason = 'sub_inactive';
      } else if (!r.isEnabled) {
        skippedReason = 'rule_disabled';
      } else if (autoRenew && r.type === 'after_expiry') {
        skippedReason = 'auto_renew';
      } else {
        const previewRule: ReminderRule = {
          id: `preview-${index}`,
          type: r.type,
          unit: r.unit,
          value: r.value,
          repeatInterval: r.repeatInterval,
          repeatUntil: r.repeatUntil,
          isEnabled: r.isEnabled,
          createdAt: ''
        };
        nextFireTime = nextMatchingCheck(previewRule, expiryIso, timezone, hours, now);
        if (!nextFireTime) skippedReason = 'already_passed';
      }
      return {
        index,
        type: r.type,
        value: r.value,
        unit: r.unit,
        repeatInterval: r.repeatInterval,
        repeatUntil: r.repeatUntil,
        isEnabled: r.isEnabled,
        nextFireTime,
        skippedReason
      };
    });

    const upcoming = perRule
      .filter((item) => item.nextFireTime !== null)
      .sort((a, b) => new Date(a.nextFireTime as string).getTime() - new Date(b.nextFireTime as string).getTime());

    return json({
      success: true,
      timezone,
      timezoneDisplay: formatTimezoneDisplay(timezone),
      notificationHours: hours,
      enabledNotifiers,
      enabledNotifierCount: enabledNotifiers.length,
      nextFireTime: upcoming[0] ? upcoming[0].nextFireTime : null,
      perRule
    });
  }

  // /subscriptions/:id/next-reminder
  const nrMatch = path.match(/^\/subscriptions\/([^/]+)\/next-reminder\/?$/);
  if (nrMatch && method === 'GET') {
    const [, subId] = nrMatch;
    const { getSubscription } = await import('../../data/subscriptions.js');
    const sub = await getSubscription(subId, env);
    if (!sub) return json({ success: false, message: '订阅不存在' }, 404);
    const rules = await remindersRepo.listForSubscription(env, subId);
    const config = preloadedConfig || await getConfig(env);
    const now = new Date();
    const times = rules
      .filter((r) => sub.isActive && !(sub.autoRenew && r.type === 'after_expiry'))
      .map((r) => ({ ruleId: r.id, type: r.type, value: r.value, unit: r.unit, nextFireTime: nextMatchingCheck(r, sub.expiryDate, config.TIMEZONE || 'UTC', Array.isArray(config.NOTIFICATION_HOURS) ? config.NOTIFICATION_HOURS : [], now) }))
      .filter((t) => t.nextFireTime !== null)
      // filter 已剔除 null，剩余值必为时间串（类型断言仅过类型层）
      .sort((a, b) => new Date(a.nextFireTime as string).getTime() - new Date(b.nextFireTime as string).getTime());
    return json({ success: true, nextReminder: times[0] || null, allUpcoming: times });
  }

  // /notification-logs/latest-by-channel（一次聚合读取所有渠道最新记录）
  if (path === '/notification-logs/latest-by-channel' && method === 'GET') {
    const latest = await notifyLogsRepo.latestByChannel(env, Object.keys(ALL_CHANNELS));
    return json({ success: true, latest });
  }

  // /notification-logs
  if (path === '/notification-logs' && method === 'GET') {
    return handleNotifyLogsList(request, env);
  }

  // /scheduler-logs
  if (path === '/scheduler-logs' && method === 'GET') {
    return handleSchedLogsList(request, env);
  }

  // /scheduler/run（手动触发一次调度检查，内部自带防重复去重保护）
  if (path === '/scheduler/run' && method === 'POST') {
    const log = await checkExpiringSubscriptions(env);
    if (!log) {
      return json({ success: false, message: '调度执行失败，请查看运行日志' }, 500);
    }
    return json({ success: log.status !== 'error', log });
  }

  // /version
  if (path === '/version' && method === 'GET') {
    return json({ success: true, version: VERSION });
  }

  // /categories
  if (path === '/categories') {
    if (method === 'GET') {
      return json({ success: true, categories: await getCategories(env) });
    }
    if (method === 'POST') {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ success: false, message: '请求体不是合法 JSON' }, 400); }
      const name = body && (body as { name?: unknown }).name;
      if (!name || !(name as string).trim()) return json({ success: false, message: '分类名不能为空' }, 400);
      await addCategory(env, name as string);
      return json({ success: true });
    }
  }

  return null;
}

async function handleReminderRoute(
  request: Request,
  env: AppEnv,
  method: string,
  subId: string,
  ruleId?: string
): Promise<Response> {
  // GET /subscriptions/:id/reminders
  if (method === 'GET' && !ruleId) {
    const list = await remindersRepo.listForSubscription(env, subId);
    return json({ success: true, rules: list });
  }

  // POST /subscriptions/:id/reminders
  if (method === 'POST' && !ruleId) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '请求体不是合法 JSON' }, 400);
    }
    if (body && (body as { preset?: unknown }).preset === true) {
      // 一次性应用智能预设（覆盖现有规则）
      const presets = remindersRepo.defaultPresetRules();
      await remindersRepo.replaceForSubscription(env, subId, presets);
      await syncLegacyAfterRulesChange(env, subId);
      return json({ success: true, rules: presets });
    }
    const rule = await remindersRepo.addRule(env, subId, (body || {}) as Partial<ReminderRule>);
    await syncLegacyAfterRulesChange(env, subId);
    return json({ success: true, rule });
  }

  // PUT /subscriptions/:id/reminders（不带 ruleId）→ 整体替换规则列表
  if (method === 'PUT' && !ruleId) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '请求体不是合法 JSON' }, 400);
    }
    const bodyRules = (body as { rules?: unknown } | null)?.rules;
    // replaceForSubscription 内部会逐条 normalizeRule，这里只做形状收窄
    const rules: ReminderRule[] = Array.isArray(bodyRules) ? (bodyRules as ReminderRule[]) : [];
    await remindersRepo.replaceForSubscription(env, subId, rules);
    const saved = await remindersRepo.listForSubscription(env, subId);
    await syncLegacyAfterRulesChange(env, subId, saved);
    return json({ success: true, rules: saved });
  }

  // PUT /subscriptions/:id/reminders/:ruleId
  if (method === 'PUT' && ruleId) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '请求体不是合法 JSON' }, 400);
    }
    const updated = await remindersRepo.updateRule(env, subId, ruleId, (body || {}) as Partial<ReminderRule>);
    if (!updated) return json({ success: false, message: '规则不存在' }, 404);
    await syncLegacyAfterRulesChange(env, subId);
    return json({ success: true, rule: updated });
  }

  // DELETE /subscriptions/:id/reminders/:ruleId
  if (method === 'DELETE' && ruleId) {
    const ok = await remindersRepo.deleteRule(env, subId, ruleId);
    if (!ok) return json({ success: false, message: '规则不存在' }, 404);
    await syncLegacyAfterRulesChange(env, subId);
    return json({ success: true });
  }

  return json({ success: false, message: 'Method Not Allowed' }, 405);
}

/**
 * GET /api/notification-logs?subId=&channel=&status=&since=&limit=
 */
async function handleNotifyLogsList(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const filter: NotifyLogQuery = {
    subId: url.searchParams.get('subId') || undefined,
    channel: url.searchParams.get('channel') || undefined,
    status: (url.searchParams.get('status') || undefined) as 'success' | 'failed' | undefined,
    since: url.searchParams.get('since') || undefined,
    until: url.searchParams.get('until') || undefined,
    limit: Number(url.searchParams.get('limit') || 100)
  };
  const logs = await notifyLogsRepo.query(env, filter);
  return json({ success: true, logs });
}

/**
 * GET /api/scheduler-logs?limit=N
 */
async function handleSchedLogsList(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') || 20);
  const logs = await schedLogsRepo.getRecent(env, limit);
  return json({ success: true, logs });
}
