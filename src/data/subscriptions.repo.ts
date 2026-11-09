/**
 * 订阅仓库
 *
 * ── 设计动机 ────────────────────────────────────────────────
 * 早期实现把所有订阅塞在一个 KV key（'subscriptions'）里，每次读写整数组，
 * 并发编辑会丢数据，且数量大时性能下降。
 *
 * 改为：
 *   sub_index = JSON 数组 [id1, id2, ...]    ← 用于快速枚举
 *   sub:{id}  = JSON 对象                     ← 单订阅完整数据
 *
 * 单订阅 CRUD 不再触碰整数组，仅写 sub:{id}（修改）或 sub_index+sub:{id}（新增/删除）。
 *
 * ── 并发安全说明 ────────────────────────────────────────────
 * KV 不支持事务，sub_index 的"读-改-写"在并发下仍可能丢更新。
 * 真实使用场景（单用户、操作稀疏）下风险可接受。
 * 数据本体在 sub:{id}，即使索引漏更新也可以通过 KV.list 修复。
 *
 */

import type { AppEnv } from '../platform/storage/storage-port.js';

/** 一条支付记录（存于 Subscription.paymentHistory 中） */
export interface PaymentRecord {
  id: string;
  /** ISO 时间串 */
  date: string;
  amount: number | null;
  currency: string;
  /** 'initial' | 'manual' | 'auto' 等来源标记 */
  type: string;
  note?: string;
  /** 本次支付覆盖周期的起止（ISO 时间串） */
  periodStart: string;
  periodEnd: string;
  [key: string]: unknown;
}

/** 一条订阅的完整存储形状（sub:{id} 的 JSON 对象） */
export interface Subscription {
  id: string;
  name: string;
  /** 'cycle' | 'reset' */
  subscriptionMode: string;
  customType: string;
  category: string;
  /** ISO 时间串或 null */
  startDate: string | null;
  /** ISO 时间串 */
  expiryDate: string;
  periodValue: number;
  periodUnit: 'day' | 'month' | 'year';
  endOfMonth: boolean;
  /** legacy 单点提醒字段（与 reminder_rules 同步，兼容旧 UI / 通知正文） */
  reminderUnit: 'day' | 'hour';
  reminderValue: number;
  reminderDays?: number;
  reminderHours?: number;
  notes: string;
  amount: number | null;
  currency: string;
  /** ISO 时间串 */
  lastPaymentDate: string;
  paymentHistory: PaymentRecord[];
  isActive: boolean;
  autoRenew: boolean;
  useLunar: boolean;
  /** ISO 时间串 */
  createdAt: string;
  /** ISO 时间串 */
  updatedAt?: string;
  [key: string]: unknown;
}

const KEY_INDEX = 'sub_index';
const KEY_PREFIX = 'sub:';

/**
 * 读取订阅 ID 列表（索引）。
 *
 */
export async function listIds(env: AppEnv): Promise<string[]> {
  const raw = await env.SUBSCRIPTIONS_KV.get(KEY_INDEX);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 写回订阅 ID 列表（索引）。
 *
 */
async function writeIds(env: AppEnv, ids: string[]): Promise<void> {
  // 去重保序
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of ids) {
    if (typeof id === 'string' && !seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }
  await env.SUBSCRIPTIONS_KV.put(KEY_INDEX, JSON.stringify(deduped));
}

/**
 * 根据 ID 读取单条订阅。
 *
 */
export async function getById(env: AppEnv, id: string): Promise<Subscription | null> {
  if (!id) return null;
  const raw = await env.SUBSCRIPTIONS_KV.get(KEY_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Subscription;
  } catch (err) {
    console.error('[sub-repo] 反序列化失败:', id, err);
    return null;
  }
}

/**
 * 一次性读取所有订阅（按索引顺序）。
 *
 * 实现：先读索引，再 Promise.all 并发拿单个订阅；缺失的项被过滤。
 * 对 N 数十量级仍亚秒级。N 上千时建议分批或改用分页接口。
 *
 */
export async function listAll(env: AppEnv): Promise<Subscription[]> {
  const ids = await listIds(env);
  if (ids.length === 0) return [];
  const items = await Promise.all(ids.map((id) => getById(env, id)));
  return items.filter((it): it is Subscription => it != null);
}

/**
 * 保存（创建或更新）一条订阅。
 *
 * - 若 ID 不在索引中：写 sub:{id} 并 append 到索引
 * - 若 ID 已存在：仅写 sub:{id}（不动索引，避免不必要的 RPC）
 *
 */
export async function save(env: AppEnv, subscription: Subscription): Promise<Subscription> {
  if (!subscription || typeof subscription.id !== 'string' || subscription.id === '') {
    throw new Error('订阅缺少有效 id');
  }
  await env.SUBSCRIPTIONS_KV.put(
    KEY_PREFIX + subscription.id,
    JSON.stringify(subscription)
  );

  const ids = await listIds(env);
  if (!ids.includes(subscription.id)) {
    ids.push(subscription.id);
    await writeIds(env, ids);
  }
  return subscription;
}

/**
 * 批量保存订阅（用于自动续订一次更新多条等场景）。
 *
 * 顺序保留；并发写入单条，最后统一写一次索引。
 *
 */
export async function saveMany(env: AppEnv, subs: Subscription[]): Promise<void> {
  if (!Array.isArray(subs) || subs.length === 0) return;
  await Promise.all(
    subs.map((s) => env.SUBSCRIPTIONS_KV.put(KEY_PREFIX + s.id, JSON.stringify(s)))
  );
  const idsExisting = await listIds(env);
  const set = new Set(idsExisting);
  for (const s of subs) {
    if (typeof s.id === 'string') set.add(s.id);
  }
  if (set.size !== idsExisting.length) {
    await writeIds(env, Array.from(set));
  }
}

/**
 * 删除一条订阅（同时从索引中移除）。
 *
 */
export async function deleteById(env: AppEnv, id: string): Promise<boolean> {
  if (!id) return false;
  const before = await env.SUBSCRIPTIONS_KV.get(KEY_PREFIX + id);
  if (!before) {
    // 索引里可能仍有残留，顺手清掉
    const ids = await listIds(env);
    if (ids.includes(id)) {
      await writeIds(env, ids.filter((x) => x !== id));
    }
    return false;
  }
  await env.SUBSCRIPTIONS_KV.delete(KEY_PREFIX + id);
  const ids = await listIds(env);
  if (ids.includes(id)) {
    await writeIds(env, ids.filter((x) => x !== id));
  }
  return true;
}

/**
 * 整个仓库覆盖（用于迁移、导入等场景）。
 *
 * 流程：先清旧的 sub:{id}（按当前索引），再写新数据。
 *
 */
export async function replaceAll(env: AppEnv, subs: Subscription[]): Promise<void> {
  const oldIds = await listIds(env);
  await Promise.all(
    oldIds.map((id) => env.SUBSCRIPTIONS_KV.delete(KEY_PREFIX + id))
  );
  if (Array.isArray(subs) && subs.length > 0) {
    await Promise.all(
      subs.map((s) =>
        env.SUBSCRIPTIONS_KV.put(KEY_PREFIX + s.id, JSON.stringify(s))
      )
    );
    await writeIds(env, subs.map((s) => s.id));
  } else {
    await writeIds(env, []);
  }
}
