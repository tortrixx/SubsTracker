/**
 * 配置与数据备份 / 恢复
 *
 * GET  /api/backup?includeSecrets=0|1
 * POST /api/restore  body: { backup, mode: 'merge'|'replace', includeSecrets?: boolean }
 *
 * 设计约束：
 * - 默认导出不含密钥/密码，避免备份文件泄露
 * - JWT_SECRET 永不导出、导入时也不覆盖（避免会话被意外作废；换环境请重新登录）
 * - 订阅 + reminder_rules 一并导出，保证多规则提醒可无损迁移
 */
import { getConfig, setConfig, type AppConfig } from '../../data/config.js';
import * as subRepo from '../../data/subscriptions.repo.js';
import * as remindersRepo from '../../data/reminders.repo.js';
import { getCategories } from '../../data/categories.js';
import { putKVJson } from '../../data/kv.js';
import { SECRET_FIELDS } from './config.js';
import { VERSION } from './extras.js';
import type { AppEnv } from '../../platform/storage/storage-port.js';
import type { ReminderRule } from '../../data/reminders.repo.js';
import type { Subscription } from '../../data/subscriptions.repo.js';

const BACKUP_FORMAT = 'substracker-backup';
const BACKUP_VERSION = 1;

/** 永不导出/覆盖的字段 */
const NEVER_EXPORT_FIELDS: string[] = ['JWT_SECRET', 'ADMIN_PASSWORD'];

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function buildExportConfig(config: AppConfig, includeSecrets: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  delete out.JWT_SECRET;

  if (!includeSecrets) {
    delete out.ADMIN_PASSWORD;
    for (const key of SECRET_FIELDS) {
      if (key in out) out[key] = '';
    }
  } else {
    // 即使含密钥，也不导出 JWT_SECRET
    delete out.JWT_SECRET;
  }

  return out;
}

/**
 * GET /api/backup
 */
export async function handleExportBackup(request: Request, env: AppEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    const includeSecrets =
      url.searchParams.get('includeSecrets') === '1' ||
      url.searchParams.get('includeSecrets') === 'true';

    const config = await getConfig(env);
    const categories = await getCategories(env);
    const subscriptions = await subRepo.listAll(env);

    const reminderRules: Record<string, ReminderRule[]> = {};
    for (const sub of subscriptions) {
      if (!sub || !sub.id) continue;
      let rules = await remindersRepo.getStoredRules(env, sub.id);
      if (rules === null) {
        rules = [remindersRepo.legacyFieldToRule(sub)];
      }
      reminderRules[sub.id] = rules;
    }

    // 导出体不附带运行时附加字段
    const cleanSubs = subscriptions.map((sub) => {
      const { reminderRules: _rr, reminderRulesSummary: _rs, ...rest } = sub || {};
      return rest;
    });

    const backup = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      appVersion: VERSION,
      exportedAt: new Date().toISOString(),
      includeSecrets,
      config: buildExportConfig(config, includeSecrets),
      categories,
      subscriptions: cleanSubs,
      reminderRules
    };

    return new Response(JSON.stringify(backup, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="substracker-backup-${new Date()
          .toISOString()
          .slice(0, 10)}.json"`
      }
    });
  } catch (error) {
    console.error('[backup] 导出失败:', error);
    return json(
      { success: false, message: '导出失败: ' + (error instanceof Error ? error.message : String(error)) },
      500
    );
  }
}

/** 校验通过后的备份体形状（subscriptions 元素已逐条校验 id/name/expiryDate） */
interface BackupData {
  format?: unknown;
  version?: unknown;
  subscriptions: Array<Record<string, unknown>>;
  reminderRules?: Record<string, unknown>;
  categories?: unknown;
  config?: unknown;
  [key: string]: unknown;
}

type BackupValidation = { ok: true; backup: BackupData } | { ok: false; message: string };

/**
 * 校验单条订阅，返回错误信息（合法时返回 null）
 */
function validateSubscriptionEntry(sub: unknown, index: number): string | null {
  if (!sub || typeof sub !== 'object') {
    return `subscriptions[${index}] 不是对象`;
  }
  const entry = sub as { id?: unknown; name?: unknown; expiryDate?: unknown };
  if (typeof entry.id !== 'string' || !entry.id.trim()) {
    return `subscriptions[${index}] 缺少有效 id`;
  }
  if (typeof entry.name !== 'string' || !entry.name.trim()) {
    return `subscriptions[${index}] 缺少 name`;
  }
  if (!entry.expiryDate || Number.isNaN(new Date(entry.expiryDate as string).getTime())) {
    return `subscriptions[${index}] 缺少有效 expiryDate`;
  }
  return null;
}

/**
 * 校验备份结构
 */
function validateBackup(raw: unknown): BackupValidation {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, message: '备份内容不是有效 JSON 对象' };
  }
  const data = raw as { format?: unknown; version?: unknown; subscriptions?: unknown; reminderRules?: unknown };
  if (data.format && data.format !== BACKUP_FORMAT) {
    return { ok: false, message: `不支持的备份格式: ${data.format}` };
  }
  if (data.version != null && Number(data.version) > BACKUP_VERSION) {
    return { ok: false, message: `备份版本过高 (${data.version})，请升级应用后再导入` };
  }
  if (!Array.isArray(data.subscriptions)) {
    return { ok: false, message: '备份缺少 subscriptions 数组' };
  }
  for (let i = 0; i < data.subscriptions.length; i++) {
    const err = validateSubscriptionEntry(data.subscriptions[i], i);
    if (err) return { ok: false, message: err };
  }
  if (data.reminderRules != null && typeof data.reminderRules !== 'object') {
    return { ok: false, message: 'reminderRules 必须是对象' };
  }
  return { ok: true, backup: raw as BackupData };
}

/**
 * 合并配置：默认不覆盖密钥空值；includeSecrets 时才写入非空密钥
 */
function mergeConfig(current: AppConfig, incoming: unknown, includeSecrets: boolean): Record<string, unknown> {
  if (!incoming || typeof incoming !== 'object') return current;

  const next: Record<string, unknown> = { ...current };

  for (const [key, value] of Object.entries(incoming)) {
    if (NEVER_EXPORT_FIELDS.includes(key) || key === 'JWT_SECRET') continue;

    if (SECRET_FIELDS.includes(key) || key === 'ADMIN_PASSWORD') {
      if (!includeSecrets) continue;
      if (typeof value === 'string' && value.trim() !== '') {
        next[key] = value;
      }
      continue;
    }

    if (value !== undefined) {
      next[key] = value;
    }
  }

  // 始终保留现有 JWT
  next.JWT_SECRET = current.JWT_SECRET;
  return next;
}

/**
 * POST /api/restore
 */
export async function handleImportBackup(request: Request, env: AppEnv): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '请求体不是合法 JSON' }, 400);
    }

    // 兼容：body 直接是备份，或 { backup, mode, includeSecrets }
    const bodyObj = body as { backup?: unknown; mode?: unknown; includeSecrets?: unknown } | null;
    const rawBackup = bodyObj && bodyObj.backup ? bodyObj.backup : body;
    const mode = bodyObj && bodyObj.mode === 'replace' ? 'replace' : bodyObj && bodyObj.mode === 'missing' ? 'missing' : 'merge';
    const includeSecrets = !!(bodyObj && bodyObj.includeSecrets);

    const validated = validateBackup(rawBackup);
    if (!validated.ok) {
      return json({ success: false, message: validated.message }, 400);
    }
    const backup = validated.backup;

    // 先写订阅/规则，再写配置：避免配置已改但数据半残
    const incomingSubs = backup.subscriptions.filter(
      (s): s is Record<string, unknown> & { id: string } => !!s && typeof s.id === 'string' && !!s.id
    );
    if (mode === 'replace' && incomingSubs.length === 0) {
      return json(
        { success: false, message: '覆盖模式拒绝空订阅列表（请确认备份完整或改用合并模式）' },
        400
      );
    }
    if (mode === 'missing') {
      for (const sub of incomingSubs) {
        if (await subRepo.exists(env, sub.id)) {
          return json({ success: false, message: `订阅 ${sub.id} 已存在，无法撤销删除` }, 409);
        }
        if (!Array.isArray((backup.reminderRules as Record<string, unknown> | undefined)?.[sub.id])) {
          return json({ success: false, message: '撤销删除需要完整的提醒规则快照' }, 400);
        }
      }
    }

    const rulesMap: Record<string, unknown> =
      backup.reminderRules && typeof backup.reminderRules === 'object' ? backup.reminderRules : {};

    let importedSubs = 0;
    let importedRules = 0;

    if (mode === 'replace') {
      const existing = await subRepo.listAll(env);
      for (const sub of existing) {
        if (sub && sub.id) {
          await remindersRepo.clearForSubscription(env, sub.id);
        }
      }
      // 备份体只保证 id/name/expiryDate 已校验，写入边界处按 Subscription 断言
      await subRepo.replaceAll(env, incomingSubs as unknown as Subscription[]);
      importedSubs = incomingSubs.length;
    } else if (mode === 'missing') {
      // 先写规则再暴露订阅；失败时保留孤儿规则比让空规则回退旧值更安全。
      for (const sub of incomingSubs) {
        const rules = (rulesMap[sub.id] as unknown[]).map((r) => remindersRepo.normalizeRule(r));
        await remindersRepo.replaceForSubscription(env, sub.id, rules);
        importedRules += rules.length;
        await subRepo.save(env, sub as unknown as Subscription);
        importedSubs++;
      }
    } else {
      for (const sub of incomingSubs) {
        await subRepo.save(env, sub as unknown as Subscription);
        importedSubs++;
      }
    }

    for (const sub of incomingSubs) {
      const mappedRules = rulesMap[sub.id];
      let rules: unknown[] | null = Array.isArray(mappedRules) ? mappedRules : null;
      if (!rules && Array.isArray(sub.reminderRules)) rules = sub.reminderRules as unknown[];
      if (rules !== null) {
        const normalized = rules.map((r: unknown) => remindersRepo.normalizeRule(r));
        if (mode !== 'missing') {
          await remindersRepo.replaceForSubscription(env, sub.id, normalized);
          importedRules += normalized.length;
        }
        try {
          const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
          await syncLegacyReminderFields(env, sub.id, normalized);
        } catch {
          /* ignore */
        }
      }
    }

    // 分类
    if (Array.isArray(backup.categories)) {
      const cats = backup.categories
        .filter((c: unknown) => typeof c === 'string' && !!c.trim())
        .map((c: unknown) => (c as string).trim());
      if (mode === 'replace') {
        await putKVJson(env, 'categories', [...new Set(cats)].sort());
      } else {
        const existing = await getCategories(env);
        const set = new Set([...existing, ...cats]);
        await putKVJson(env, 'categories', [...set].sort());
      }
    }

    // 配置放最后
    const currentConfig = await getConfig(env);
    if (backup.config && typeof backup.config === 'object') {
      const merged = mergeConfig(currentConfig, backup.config, includeSecrets);
      await setConfig(env, merged);
    }

    return json({
      success: true,
      message: `恢复完成（模式: ${mode === 'replace' ? '覆盖' : '合并'}）`,
      stats: {
        subscriptions: importedSubs,
        reminderRules: importedRules,
        categories: Array.isArray(backup.categories) ? backup.categories.length : 0,
        configRestored: !!backup.config,
        secretsApplied: includeSecrets
      }
    });
  } catch (error) {
    console.error('[backup] 导入失败:', error);
    return json(
      { success: false, message: '导入失败: ' + (error instanceof Error ? error.message : String(error)) },
      500
    );
  }
}
