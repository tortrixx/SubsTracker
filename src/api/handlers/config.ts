import { getConfig, setConfig, type AppConfig } from '../../data/config.js';
import { validateReminderRules, type ReminderRule } from '../../data/reminders.repo.js';
import { generateRandomSecret, sanitizeNotificationHours } from '../utils.js';
import type { AppEnv } from '../../platform/storage/storage-port.js';

// 这些字段可能包含 token/密钥，绝不下发到浏览器
const SECRET_FIELDS: string[] = [
  'TG_BOT_TOKEN',
  'NOTIFYX_API_KEY',
  'WEBHOOK_URL',
  'WEBHOOK_HEADERS',
  'WECHATBOT_WEBHOOK',
  'RESEND_API_KEY',
  'BARK_DEVICE_KEY',
  'THIRD_PARTY_API_TOKEN',
  'GOTIFY_APP_TOKEN',
  'SERVERCHAN_SENDKEY',
  'PUSHPLUS_TOKEN',
  'NTFY_TOKEN',
  'WPUSH_APIKEY'
];

function isConfiguredSecret(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildSafeConfig(config: AppConfig): Record<string, unknown> {
  const { JWT_SECRET, ADMIN_PASSWORD, ...safeConfig } = config;
  const response: Record<string, unknown> = { ...safeConfig };
  const safeView = safeConfig as Record<string, unknown>;

  // 对每个敏感字段：返回空字符串 + 一个 *_CONFIGURED 标记
  SECRET_FIELDS.forEach((key) => {
    response[`${key}_CONFIGURED`] = isConfiguredSecret(safeView[key]);
    response[key] = '';
  });

  return response;
}

function normalizeClearSecretFields(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => item.trim());
  }
  if (typeof value === 'string') {
    return value.split(/[,，\s]+/).map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function mergeSecretField(
  existingConfig: AppConfig,
  newConfig: Record<string, unknown>,
  key: string,
  clearSecretFields: string[] = []
): string {
  // 显式清空优先级最高
  if (clearSecretFields.includes(key)) return '';

  const incoming = newConfig?.[key];
  if (typeof incoming !== 'string') {
    return ((existingConfig as Record<string, unknown>)?.[key] || '') as string;
  }

  const trimmed = incoming.trim();

  // 兼容旧前端：曾用 "********" 作为占位符，表示不修改
  if (trimmed === '********') {
    return ((existingConfig as Record<string, unknown>)?.[key] || '') as string;
  }

  // 安全默认：空字符串不再代表清空（避免前端未回显导致误清空）
  if (!trimmed) {
    return ((existingConfig as Record<string, unknown>)?.[key] || '') as string;
  }

  return trimmed;
}

async function handleGetConfig(env: AppEnv): Promise<Response> {
  const config = await getConfig(env);
  return new Response(
    JSON.stringify(buildSafeConfig(config)),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleUpdateConfig(request: Request, env: AppEnv): Promise<Response> {
  try {
    const config = await getConfig(env);
    const newConfig = (await request.json()) as Record<string, unknown>;
    const clearSecretFields = normalizeClearSecretFields(newConfig?.CLEAR_SECRET_FIELDS);

    // 全局默认提醒规则：字段缺失 = 不修改；null = 清除配置（回退内置预设）；
    // 数组（含空数组）= 新的默认模板，任一条非法则整请求 400 且不落库
    let defaultReminderRules: ReminderRule[] | null = config.DEFAULT_REMINDER_RULES ?? null;
    if ('DEFAULT_REMINDER_RULES' in newConfig) {
      const rawRules = newConfig.DEFAULT_REMINDER_RULES;
      if (rawRules === null) {
        defaultReminderRules = null;
      } else {
        const checked = validateReminderRules(rawRules);
        if (!checked.ok) {
          return new Response(
            JSON.stringify({ success: false, message: 'DEFAULT_REMINDER_RULES 非法: ' + checked.message }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        defaultReminderRules = checked.rules;
      }
    }

    const updatedConfig = {
      ...config,
      ADMIN_USERNAME: newConfig.ADMIN_USERNAME || config.ADMIN_USERNAME,
      THEME_MODE: newConfig.THEME_MODE || 'system',

      TG_BOT_TOKEN: mergeSecretField(config, newConfig, 'TG_BOT_TOKEN', clearSecretFields),
      TG_CHAT_ID: newConfig.TG_CHAT_ID || '',
      TG_TOPIC_ID: (newConfig.TG_TOPIC_ID != null ? String(newConfig.TG_TOPIC_ID) : '').trim(),

      NOTIFYX_API_KEY: mergeSecretField(config, newConfig, 'NOTIFYX_API_KEY', clearSecretFields),

      WEBHOOK_URL: mergeSecretField(config, newConfig, 'WEBHOOK_URL', clearSecretFields),
      WEBHOOK_METHOD: newConfig.WEBHOOK_METHOD || 'POST',
      WEBHOOK_HEADERS: mergeSecretField(config, newConfig, 'WEBHOOK_HEADERS', clearSecretFields),
      WEBHOOK_TEMPLATE: newConfig.WEBHOOK_TEMPLATE || '',

      SHOW_LUNAR: newConfig.SHOW_LUNAR === true,

      WECHATBOT_WEBHOOK: mergeSecretField(config, newConfig, 'WECHATBOT_WEBHOOK', clearSecretFields),
      WECHATBOT_MSG_TYPE: newConfig.WECHATBOT_MSG_TYPE || 'text',
      WECHATBOT_AT_MOBILES: newConfig.WECHATBOT_AT_MOBILES || '',
      WECHATBOT_AT_ALL: newConfig.WECHATBOT_AT_ALL || 'false',

      RESEND_API_KEY: mergeSecretField(config, newConfig, 'RESEND_API_KEY', clearSecretFields),
      EMAIL_FROM: newConfig.EMAIL_FROM || '',
      EMAIL_FROM_NAME: newConfig.EMAIL_FROM_NAME || '',
      EMAIL_TO: newConfig.EMAIL_TO || '',
      APP_URL: (newConfig.APP_URL as string || '').trim(),

      BARK_DEVICE_KEY: mergeSecretField(config, newConfig, 'BARK_DEVICE_KEY', clearSecretFields),
      BARK_SERVER: newConfig.BARK_SERVER || 'https://api.day.app',
      BARK_IS_ARCHIVE: newConfig.BARK_IS_ARCHIVE || 'false',

      GOTIFY_SERVER_URL: (newConfig.GOTIFY_SERVER_URL as string || '').trim(),
      GOTIFY_APP_TOKEN: mergeSecretField(config, newConfig, 'GOTIFY_APP_TOKEN', clearSecretFields),

      SERVERCHAN_SENDKEY: mergeSecretField(config, newConfig, 'SERVERCHAN_SENDKEY', clearSecretFields),

      PUSHPLUS_TOKEN: mergeSecretField(config, newConfig, 'PUSHPLUS_TOKEN', clearSecretFields),
      PUSHPLUS_TOPIC: (newConfig.PUSHPLUS_TOPIC as string || '').trim(),
      PUSHPLUS_CHANNEL: (newConfig.PUSHPLUS_CHANNEL as string || '').trim(),

      NTFY_SERVER: (newConfig.NTFY_SERVER as string || 'https://ntfy.sh').trim() || 'https://ntfy.sh',
      NTFY_TOPIC: (newConfig.NTFY_TOPIC as string || '').trim(),
      NTFY_TOKEN: mergeSecretField(config, newConfig, 'NTFY_TOKEN', clearSecretFields),

      WPUSH_APIKEY: mergeSecretField(config, newConfig, 'WPUSH_APIKEY', clearSecretFields),
      WPUSH_CHANNEL: (newConfig.WPUSH_CHANNEL as string || '').trim(),
      WPUSH_TOPIC_CODE: (newConfig.WPUSH_TOPIC_CODE as string || '').trim(),

      ENABLED_NOTIFIERS: newConfig.ENABLED_NOTIFIERS || ['notifyx'],
      TIMEZONE: newConfig.TIMEZONE || config.TIMEZONE || 'UTC',
      DEFAULT_REMINDER_RULES: defaultReminderRules,

      THIRD_PARTY_API_TOKEN: mergeSecretField(config, newConfig, 'THIRD_PARTY_API_TOKEN', clearSecretFields),

      DEBUG_LOGS: newConfig.DEBUG_LOGS === true,
      PAYMENT_HISTORY_LIMIT: Number.isFinite(Number(newConfig.PAYMENT_HISTORY_LIMIT))
        ? Math.min(1000, Math.max(10, Math.floor(Number(newConfig.PAYMENT_HISTORY_LIMIT))))
        : (config.PAYMENT_HISTORY_LIMIT || 100)
    };

    updatedConfig.NOTIFICATION_HOURS = sanitizeNotificationHours(newConfig.NOTIFICATION_HOURS);

    if (newConfig.ADMIN_PASSWORD) {
      updatedConfig.ADMIN_PASSWORD = newConfig.ADMIN_PASSWORD as string;
    }

    if (!updatedConfig.JWT_SECRET || updatedConfig.JWT_SECRET === 'your-secret-key') {
      updatedConfig.JWT_SECRET = generateRandomSecret();
      console.log('[安全] 生成新的JWT密钥');
    }

    await setConfig(env, updatedConfig);

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('配置保存错误:', error);
    return new Response(
      JSON.stringify({ success: false, message: '更新配置失败: ' + (error as Error).message }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export { SECRET_FIELDS, handleGetConfig, handleUpdateConfig };
