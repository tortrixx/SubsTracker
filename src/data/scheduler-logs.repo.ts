/**
 * 调度器执行日志仓库
 *
 * 用途：每次 Cron `scheduled` 触发都写一条聚合日志，包含本次执行的：
 *   - 起止时间、用户时区、是否在通知时段
 *   - 检查的订阅总数 / 命中提醒规则数 / 去重跳过数
 *   - 自动续订条数 / 通知发送统计
 *   - 错误（如有）
 *
 * 配合 notification-logs（细粒度）形成"链路日志"：
 *   sched_log:{isoUtc}                  ← 一次调度的总览
 *   notify_log:{ymdh}:{sub}:{rule}:{ch} ← 该调度发出的每条通知
 *
 * Key 规则：sched_log:{ISO_UTC}（如 sched_log:2026-05-24T17:00:00.000Z）
 *   ISO 字典序 == 时间序，便于 list 倒序读取。
 *
 * 默认 TTL：30 天。
 *
 */

import type { AppEnv } from '../platform/storage/storage-port.js';

const PREFIX = 'sched_log:';
const DEFAULT_TTL_SEC = 30 * 24 * 3600;

/** 一条调度器执行日志（落库后的完整形状） */
export interface SchedulerLogEntry {
  /** 完整 KV key */
  key: string;
  /** ISO */
  startedAt: string;
  /** ISO */
  finishedAt: string;
  /** 调度生效时区 */
  timezone: string;
  /** 用户 TZ 下的当前小时（"HH"） */
  currentHour: string;
  /** 通知时段配置（用户 TZ 小时） */
  configuredHours: string[];
  /** 是否在通知时段内 */
  inWindow: boolean;
  /** 检查订阅数 */
  checkedCount: number;
  /** 命中规则的（订阅×规则）对数 */
  matchedCount: number;
  /** 因去重跳过数 */
  dedupedCount: number;
  /** 实际发送通知数 */
  sentCount: number;
  /** 自动续订订阅数 */
  autoRenewedCount: number;
  /** 'ok' | 'skipped' | 'error' */
  status: string;
  /** 跳过原因或错误摘要 */
  reason?: string;
  /** 附加信息（可选） */
  extra?: unknown;
}

/**
 * 写入一条调度日志。
 *
 */
export async function writeLog(env: AppEnv, entry: Omit<SchedulerLogEntry, 'key'>, opts: { ttlSec?: number } = {}): Promise<SchedulerLogEntry> {
  const key = PREFIX + (entry.startedAt || new Date().toISOString());
  const stored: Omit<SchedulerLogEntry, 'key'> = {
    startedAt: entry.startedAt || new Date().toISOString(),
    finishedAt: entry.finishedAt || new Date().toISOString(),
    timezone: entry.timezone || 'UTC',
    currentHour: entry.currentHour || '00',
    configuredHours: entry.configuredHours || [],
    inWindow: !!entry.inWindow,
    checkedCount: entry.checkedCount || 0,
    matchedCount: entry.matchedCount || 0,
    dedupedCount: entry.dedupedCount || 0,
    sentCount: entry.sentCount || 0,
    autoRenewedCount: entry.autoRenewedCount || 0,
    status: entry.status || 'ok',
    reason: entry.reason,
    extra: entry.extra
  };
  await env.SUBSCRIPTIONS_KV.put(key, JSON.stringify(stored), {
    expirationTtl: Math.max(60, opts.ttlSec || DEFAULT_TTL_SEC)
  });
  return { key, ...stored };
}

/**
 * 取最近 N 条调度日志（按时间倒序）。
 *
 */
export async function getRecent(env: AppEnv, limit: number = 20): Promise<SchedulerLogEntry[]> {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 20));

  // KV.list 默认升序；想要倒序需要拉全后排序
  const allKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.SUBSCRIPTIONS_KV.list({
      prefix: PREFIX,
      cursor,
      limit: 1000
    });
    for (const k of res.keys) allKeys.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor && allKeys.length < 5000);

  allKeys.sort((a, b) => b.localeCompare(a));
  const top = allKeys.slice(0, safeLimit);
  const items = await Promise.all(
    top.map(async (key) => {
      const raw = await env.SUBSCRIPTIONS_KV.get(key);
      if (!raw) return null;
      try {
        return { key, ...(JSON.parse(raw) as Omit<SchedulerLogEntry, 'key'>) };
      } catch {
        return null;
      }
    })
  );
  return items.filter((x): x is SchedulerLogEntry => x != null);
}
