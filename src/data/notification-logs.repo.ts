/**
 * 通知日志仓库
 *
 * 用途：每次发送通知（成功 / 失败）都记录一条；用于"通知历史"页和
 * "为什么没收到通知"自助排查。
 *
 * Key 规则：
 *   notify_log:{ymdh}:{subId}:{ruleId}:{channel}
 *     ymdh    = "YYYYMMDDHH"（UTC，方便按时间区间 list）
 *     subId   = 订阅 ID
 *     ruleId  = 触发的规则 ID（手动触发可填 'manual'，第三方 API 可填 'thirdparty'）
 *     channel = 通知渠道（telegram, bark, ...）
 *
 *   key 尾部附带 UUID，避免并发或同一毫秒写入时相互覆盖。
 *
 * 默认 TTL：30 天，过期自动清理。失败日志可单独配置更长 TTL（这里统一 30 天即可，
 * 后续如需可改 writeLog 接受 ttl 参数）。
 *
 */

import type { AppEnv } from '../platform/storage/storage-port.js';

const PREFIX = 'notify_log:';
const DEFAULT_TTL_SEC = 30 * 24 * 3600;

/** 一条通知日志（落库后的完整形状） */
export interface NotifyLogEntry {
  /** 完整 KV key */
  key: string;
  /** ISO 时间 */
  timestamp: string;
  subId: string;
  /** 触发规则；手动 / 第三方为占位字符串 */
  ruleId: string | null;
  channel: string;
  status: 'success' | 'failed';
  title?: string;
  content?: string;
  /** 失败原因 */
  error?: string;
  /** 三方原始返回，便于排查 */
  raw?: unknown;
}

/** writeLog 的入参形状 */
export interface WriteNotifyLogInput {
  subId: string;
  ruleId?: string | null;
  channel: string;
  status: 'success' | 'failed';
  title?: string;
  content?: string;
  error?: string;
  raw?: unknown;
  timestamp?: string | Date | number;
  ttlSec?: number;
}

/** query 的过滤条件 */
export interface NotifyLogQuery {
  subId?: string;
  channel?: string;
  status?: 'success' | 'failed';
  since?: string | Date | number;
  until?: string | Date | number;
  limit?: number;
}

/**
 * 把 Date 转成 'YYYYMMDDHH' UTC 字符串。
 *
 */
export function ymdhUtc(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return ymdhUtc(new Date());
  }
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}`;
}

/**
 * 写入一条通知日志。
 */
export async function writeLog(env: AppEnv, entry: WriteNotifyLogInput): Promise<NotifyLogEntry> {
  const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
  // 时间戳不是唯一 ID：同一毫秒内也可能并发写入多条记录。
  const rand = crypto.randomUUID();
  const ruleId = entry.ruleId || 'none';
  const key = `${PREFIX}${ymdhUtc(ts)}:${entry.subId}:${ruleId}:${entry.channel}:${rand}`;

  const stored: Omit<NotifyLogEntry, 'key'> = {
    timestamp: ts.toISOString(),
    subId: entry.subId,
    ruleId,
    channel: entry.channel,
    status: entry.status,
    title: entry.title,
    content: entry.content,
    error: entry.error,
    raw: entry.raw
  };

  await env.SUBSCRIPTIONS_KV.put(key, JSON.stringify(stored), {
    expirationTtl: Math.max(60, entry.ttlSec || DEFAULT_TTL_SEC)
  });

  return { key, ...stored };
}

/** 解析 key 段，仅当格式严格符合 5 段时返回可预过滤字段，防止含冒号 ID 误判。 */
function parseKeyMeta(key: string): { hour: string; subId?: string; channel?: string } {
  const rest = key.slice(PREFIX.length);
  const hour = rest.slice(0, 10);
  const parts = rest.split(':');
  if (parts.length === 5) {
    return { hour, subId: parts[1], channel: parts[3] };
  }
  return { hour };
}

/** 列出全部通知日志 Key 并按时间倒序排列。 */
async function listSortedKeys(env: AppEnv): Promise<string[]> {
  const all: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.SUBSCRIPTIONS_KV.list({
      prefix: PREFIX,
      cursor,
      limit: 1000
    });
    for (const k of res.keys) all.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  // 先按小时倒序，随后按记录时间排序；同一小时内 key 的订阅 ID 并不代表时间。
  all.sort((a, b) => b.localeCompare(a));
  return all;
}

/** 解析单条日志并校验是否满足过滤条件。 */
async function readAndMatchLog(
  env: AppEnv,
  key: string,
  filter: NotifyLogQuery,
  sinceTs: number,
  untilTs: number
): Promise<NotifyLogEntry | null> {
  const raw = await env.SUBSCRIPTIONS_KV.get(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const obj = parsed as Omit<NotifyLogEntry, 'key'>;
    if (!obj || typeof obj.timestamp !== 'string' || !Number.isFinite(Date.parse(obj.timestamp))) return null;
    if (filter.subId && obj.subId !== filter.subId) return null;
    if (filter.channel && obj.channel !== filter.channel) return null;
    if (filter.status && obj.status !== filter.status) return null;
    const tsMs = new Date(obj.timestamp).getTime();
    if (tsMs < sinceTs || tsMs > untilTs) return null;
    return { key, ...obj };
  } catch {
    return null;
  }
}

const READ_BATCH_SIZE = 32;

/**
 * 查询通知日志。
 */
export async function query(env: AppEnv, filter: NotifyLogQuery = {}): Promise<NotifyLogEntry[]> {
  const limit = Math.min(500, Math.max(1, filter.limit || 100));
  const all = await listSortedKeys(env);

  const sinceMs = filter.since ? new Date(filter.since).getTime() : Number.NaN;
  const untilMs = filter.until ? new Date(filter.until).getTime() : Number.NaN;
  const sinceTs = Number.isFinite(sinceMs) ? sinceMs : 0;
  const untilTs = Number.isFinite(untilMs) ? untilMs : Number.POSITIVE_INFINITY;
  // 为 key 的 UTC 小时前缀保留 ±1 小时安全边界，避免时间戳边界误差误跳过
  const minYmdh = Number.isFinite(sinceMs) ? ymdhUtc(sinceMs - 3600_000) : '';
  const maxYmdh = Number.isFinite(untilMs) ? ymdhUtc(untilMs + 3600_000) : '';

  const filteredKeys: string[] = [];
  for (const key of all) {
    const meta = parseKeyMeta(key);
    if (maxYmdh && meta.hour > maxYmdh) continue;
    if (minYmdh && meta.hour < minYmdh) break;
    if (filter.subId && meta.subId !== undefined && meta.subId !== filter.subId) continue;
    if (filter.channel && meta.channel !== undefined && meta.channel !== filter.channel) continue;
    filteredKeys.push(key);
  }

  // 按小时分桶后在桶内并发读取，既保持小时级早停语义又避免串行 KV.get 延迟
  const out: NotifyLogEntry[] = [];
  let idx = 0;
  while (idx < filteredKeys.length) {
    const hour = parseKeyMeta(filteredKeys[idx]).hour;
    if (out.length >= limit) break;

    const bucket: string[] = [];
    while (idx < filteredKeys.length && parseKeyMeta(filteredKeys[idx]).hour === hour) {
      bucket.push(filteredKeys[idx]);
      idx++;
    }

    for (let i = 0; i < bucket.length; i += READ_BATCH_SIZE) {
      const slice = bucket.slice(i, i + READ_BATCH_SIZE);
      const entries = await Promise.all(slice.map((k) => readAndMatchLog(env, k, filter, sinceTs, untilTs)));
      for (const e of entries) {
        if (e) out.push(e);
      }
    }
  }

  out.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return out.slice(0, limit);
}

/**
 * 一次扫描获取各渠道最新一条通知日志（用于渠道页状态卡片，避免 N 次重复全表扫描）。
 */
export async function latestByChannel(
  env: AppEnv,
  channels?: string[]
): Promise<Record<string, NotifyLogEntry>> {
  const targetSet = channels && channels.length > 0 ? new Set(channels) : null;
  const result: Record<string, NotifyLogEntry> = {};
  const all = await listSortedKeys(env);

  let idx = 0;
  while (idx < all.length) {
    if (targetSet && Object.keys(result).length >= targetSet.size) break;
    const hour = parseKeyMeta(all[idx]).hour;
    const bucket: string[] = [];
    while (idx < all.length && parseKeyMeta(all[idx]).hour === hour) {
      const key = all[idx];
      idx++;
      const meta = parseKeyMeta(key);
      if (meta.channel && targetSet && !targetSet.has(meta.channel)) continue;
      if (meta.channel && result[meta.channel]) continue;
      bucket.push(key);
    }

    for (let i = 0; i < bucket.length; i += READ_BATCH_SIZE) {
      const slice = bucket.slice(i, i + READ_BATCH_SIZE);
      const entries = await Promise.all(slice.map((k) => readAndMatchLog(env, k, {}, 0, Number.POSITIVE_INFINITY)));
      for (const e of entries) {
        if (!e) continue;
        if (targetSet && !targetSet.has(e.channel)) continue;
        const prev = result[e.channel];
        if (!prev || Date.parse(e.timestamp) > Date.parse(prev.timestamp)) {
          result[e.channel] = e;
        }
      }
    }
  }

  return result;
}

/**
 * 取某订阅最近 N 条日志（仪表盘 / 详情页用）。
 *
 */
export async function recentForSubscription(env: AppEnv, subId: string, limit: number = 20): Promise<NotifyLogEntry[]> {
  return query(env, { subId, limit });
}
