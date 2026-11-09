/**
 * 提醒规则仓库
 *
 * 数据结构：reminder_rules:{subId} = JSON 数组，每条规则形如：
 * {
 *   id: string,                                 // UUID
 *   type: 'before_expiry' | 'on_expiry' | 'after_expiry',
 *   value: number,                              // 数值（如 7）
 *   unit: 'days' | 'hours',
 *   repeatInterval: number | null,              // 单位：小时；仅 after_expiry 用
 *   repeatUntil: 'renewed' | 'acknowledged' | 'never',
 *   isEnabled: boolean,
 *   createdAt: string                           // ISO
 * }
 *
 * 智能预设（新订阅默认 4 条）：到期前 7/3/1 天 + 到期当天。
 *
 */

const KEY_PREFIX = 'reminder_rules:';

import type { AppEnv } from '../platform/storage/storage-port.js';

/** 一条提醒规则（存于 reminder_rules:{subId} 的 JSON 数组中） */
export interface ReminderRule {
  id: string;
  type: 'before_expiry' | 'on_expiry' | 'after_expiry';
  value: number;
  unit: 'days' | 'hours';
  /** 单位：小时；仅 after_expiry 用 */
  repeatInterval?: number | null;
  repeatUntil?: 'renewed' | 'acknowledged' | 'never';
  isEnabled: boolean;
  /** ISO 时间串 */
  createdAt: string;
}

/**
 * 生成新 rule 的默认 id（UUID）。
 *
 */
export function makeRuleId(): string {
  return crypto.randomUUID();
}

/**
 * 智能预设：4 条 — 到期前 7/3/1 天 + 当天。
 *
 */
export function defaultPresetRules(): ReminderRule[] {
  const now = new Date().toISOString();
  return [
    { id: makeRuleId(), type: 'before_expiry', value: 7, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true, createdAt: now },
    { id: makeRuleId(), type: 'before_expiry', value: 3, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true, createdAt: now },
    { id: makeRuleId(), type: 'before_expiry', value: 1, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true, createdAt: now },
    { id: makeRuleId(), type: 'on_expiry', value: 0, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true, createdAt: now }
  ];
}

const RULE_TYPES: readonly string[] = ['before_expiry', 'on_expiry', 'after_expiry'];
const RULE_UNITS: readonly string[] = ['days', 'hours'];
const RULE_REPEAT_UNTILS: readonly string[] = ['renewed', 'acknowledged', 'never'];

/**
 * 严格校验一条规则（字段域与 normalizeRule 完全一致，但非法即报错、不做回退修正）。
 * 供「全局默认提醒规则」等配置入口使用：任一条非法则整组拒绝。
 * 合法时返回 null，非法时返回错误信息。
 */
export function validateReminderRule(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return '规则必须是对象';
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.type !== 'string' || !RULE_TYPES.includes(r.type)) {
    return `规则 type 非法（须为 ${RULE_TYPES.join(' / ')}）`;
  }
  if (r.unit !== undefined && (typeof r.unit !== 'string' || !RULE_UNITS.includes(r.unit))) {
    return `规则 unit 非法（须为 ${RULE_UNITS.join(' / ')}）`;
  }
  if (typeof r.value !== 'number' || !Number.isFinite(r.value) || r.value < 0) {
    return '规则 value 必须是 ≥ 0 的有限数';
  }
  if (r.repeatInterval !== undefined && r.repeatInterval !== null) {
    if (typeof r.repeatInterval !== 'number' || !Number.isFinite(r.repeatInterval) || r.repeatInterval <= 0) {
      return '规则 repeatInterval 必须是 null 或 > 0 的有限数（小时）';
    }
  }
  if (r.repeatUntil !== undefined && (typeof r.repeatUntil !== 'string' || !RULE_REPEAT_UNTILS.includes(r.repeatUntil))) {
    return `规则 repeatUntil 非法（须为 ${RULE_REPEAT_UNTILS.join(' / ')}）`;
  }
  if (r.isEnabled !== undefined && typeof r.isEnabled !== 'boolean') {
    return '规则 isEnabled 必须是布尔值';
  }
  if (r.id !== undefined && (typeof r.id !== 'string' || r.id === '')) {
    return '规则 id 必须是非空字符串';
  }
  if (r.createdAt !== undefined && typeof r.createdAt !== 'string') {
    return '规则 createdAt 必须是字符串';
  }
  return null;
}

/**
 * 严格校验一组规则：全部合法时返回归一化后的规则数组，任一条非法返回错误信息。
 */
export function validateReminderRules(raw: unknown): { ok: true; rules: ReminderRule[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, message: '规则列表必须是数组' };
  }
  for (let i = 0; i < raw.length; i++) {
    const err = validateReminderRule(raw[i]);
    if (err) return { ok: false, message: `第 ${i + 1} 条${err}` };
  }
  return { ok: true, rules: raw.map(normalizeRule) };
}

/**
 * 解析「新建订阅未提供规则时」应套用的默认规则：
 * - 配置 DEFAULT_REMINDER_RULES 为数组（含空数组）→ 以其为模板逐条复制，
 *   id / createdAt 重新生成（与 defaultPresetRules 一致，避免跨订阅 id 重复）；
 * - 未配置（null / 非数组）→ 回退内置智能预设，行为与历史一致。
 */
export function resolveDefaultRules(config: { DEFAULT_REMINDER_RULES?: ReminderRule[] | null } | null | undefined): ReminderRule[] {
  const configured = config?.DEFAULT_REMINDER_RULES;
  if (Array.isArray(configured)) {
    return configured.map((rule) => {
      const { id: _id, createdAt: _createdAt, ...rest } = rule || ({} as ReminderRule);
      return normalizeRule(rest);
    });
  }
  return defaultPresetRules();
}

/**
 * 把旧的 reminderUnit/reminderValue 单点提醒转换为 1 条等价规则。
 *
 */
export function legacyFieldToRule(sub: { reminderUnit?: string; reminderValue?: number; reminderDays?: number; reminderHours?: number }): ReminderRule {
  const unitRaw = String(sub.reminderUnit || 'day').toLowerCase();
  const unit = unitRaw === 'hour' || unitRaw === 'hours' ? 'hours' : 'days';
  const fallback = unit === 'hours' ? sub.reminderHours : sub.reminderDays;
  const value = Number(
    sub.reminderValue !== undefined && sub.reminderValue !== null ? sub.reminderValue : fallback
  );
  // value 为非数字时回退 7；value=0 视为"到期当天"，保留
  const safeValue = Number.isFinite(value) && value >= 0 ? value : 7;
  return {
    id: makeRuleId(),
    type: safeValue === 0 ? 'on_expiry' : 'before_expiry',
    value: safeValue,
    unit,
    repeatInterval: null,
    repeatUntil: 'renewed',
    isEnabled: true,
    createdAt: new Date().toISOString()
  };
}

/**
 * 校验并归一化一条规则（修正非法字段，回退默认值）。
 *
 */
export function normalizeRule(raw: unknown): ReminderRule {
  const r = (raw || {}) as Record<string, unknown>;
  const type: ReminderRule['type'] = (['before_expiry', 'on_expiry', 'after_expiry'] as string[]).includes(r.type as string)
    ? (r.type as ReminderRule['type'])
    : 'before_expiry';
  const unit: ReminderRule['unit'] = r.unit === 'hours' ? 'hours' : 'days';
  const value = Number.isFinite(r.value) && (r.value as number) >= 0 ? Math.floor(r.value as number) : 0;
  const repeatInterval =
    type === 'after_expiry' && Number.isFinite(r.repeatInterval) && (r.repeatInterval as number) > 0
      ? Math.floor(r.repeatInterval as number)
      : null;
  const repeatUntil: ReminderRule['repeatUntil'] = (['renewed', 'acknowledged', 'never'] as string[]).includes(r.repeatUntil as string)
    ? (r.repeatUntil as ReminderRule['repeatUntil'])
    : 'renewed';
  return {
    id: typeof r.id === 'string' && r.id !== '' ? r.id : makeRuleId(),
    type,
    value,
    unit,
    repeatInterval,
    repeatUntil,
    isEnabled: r.isEnabled !== false,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString()
  };
}

/**
 * 读取一个订阅的所有提醒规则。
 *
 */
export async function listForSubscription(env: AppEnv, subId: string): Promise<ReminderRule[]> {
  const raw = await env.SUBSCRIPTIONS_KV.get(KEY_PREFIX + subId);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRule);
  } catch {
    return [];
  }
}

/**
 * 整体替换某订阅的提醒规则（CRUD 都基于此）。
 *
 */
export async function replaceForSubscription(env: AppEnv, subId: string, rules: ReminderRule[]): Promise<void> {
  const safe = Array.isArray(rules) ? rules.map(normalizeRule) : [];
  await env.SUBSCRIPTIONS_KV.put(KEY_PREFIX + subId, JSON.stringify(safe));
}

/**
 * 添加单条规则。
 *
 */
export async function addRule(env: AppEnv, subId: string, rule: Partial<ReminderRule>): Promise<ReminderRule> {
  const list = await listForSubscription(env, subId);
  const normalized = normalizeRule({ ...rule, id: rule.id || makeRuleId() });
  list.push(normalized);
  await replaceForSubscription(env, subId, list);
  return normalized;
}

/**
 * 更新单条规则。
 *
 */
export async function updateRule(env: AppEnv, subId: string, ruleId: string, patch: Partial<ReminderRule>): Promise<ReminderRule | null> {
  const list = await listForSubscription(env, subId);
  const idx = list.findIndex((r) => r.id === ruleId);
  if (idx === -1) return null;
  list[idx] = normalizeRule({ ...list[idx], ...patch, id: ruleId });
  await replaceForSubscription(env, subId, list);
  return list[idx];
}

/**
 * 删除单条规则。
 *
 */
export async function deleteRule(env: AppEnv, subId: string, ruleId: string): Promise<boolean> {
  const list = await listForSubscription(env, subId);
  const next = list.filter((r) => r.id !== ruleId);
  if (next.length === list.length) return false;
  await replaceForSubscription(env, subId, next);
  return true;
}

/**
 * 删除某订阅的所有规则（订阅被删除时联动清理）。
 *
 */
export async function clearForSubscription(env: AppEnv, subId: string): Promise<void> {
  await env.SUBSCRIPTIONS_KV.delete(KEY_PREFIX + subId);
}

/**
 * 从多规则推导列表展示用的 legacy 单点字段（兼容旧 UI / 通知正文）。
 * 优先取已启用的 before_expiry 中 value 最大的一条；否则 on_expiry；否则首条启用规则。
 *
 */
export function deriveLegacyFromRules(rules: ReminderRule[]): { unit: 'day' | 'hour'; value: number } {
  const list = Array.isArray(rules) ? rules.filter((r) => r && r.isEnabled !== false) : [];
  if (list.length === 0) return { unit: 'day', value: 7 };

  const befores = list.filter((r) => r.type === 'before_expiry');
  if (befores.length > 0) {
    const sorted = [...befores].sort((a, b) => Number(b.value) - Number(a.value));
    const top = sorted[0];
    const unit = top.unit === 'hours' ? 'hour' : 'day';
    return { unit, value: Number.isFinite(top.value) ? top.value : 7 };
  }

  const on = list.find((r) => r.type === 'on_expiry');
  if (on) return { unit: 'day', value: 0 };

  const first = list[0];
  const unit = first.unit === 'hours' ? 'hour' : 'day';
  return { unit, value: Number.isFinite(first.value) ? first.value : 7 };
}

/**
 * 生成列表「提醒」列摘要文案（多规则）。
 *
 */
export function formatRulesSummary(rules: ReminderRule[]): string {
  const list = Array.isArray(rules) ? rules.filter((r) => r && r.isEnabled !== false) : [];
  if (list.length === 0) return '未设置提醒';

  const parts: string[] = [];
  const beforeDays = list
    .filter((r) => r.type === 'before_expiry' && r.unit !== 'hours')
    .map((r) => r.value)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => b - a);
  const beforeHours = list
    .filter((r) => r.type === 'before_expiry' && r.unit === 'hours')
    .map((r) => r.value)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => b - a);

  if (beforeDays.length > 0) {
    parts.push(`提前 ${beforeDays.join('/')} 天`);
  }
  if (beforeHours.length > 0) {
    parts.push(`提前 ${beforeHours.join('/')} 小时`);
  }
  if (list.some((r) => r.type === 'on_expiry' || (r.type === 'before_expiry' && r.value === 0))) {
    parts.push('到期当天');
  }
  const after = list.find((r) => r.type === 'after_expiry');
  if (after) {
    const interval = after.repeatInterval && after.repeatInterval > 0 ? after.repeatInterval : 24;
    parts.push(`到期后每 ${interval} 小时`);
  }

  return parts.length > 0 ? parts.join(' · ') : '未设置提醒';
}
