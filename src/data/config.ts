import { getKVJson, putKVJson } from './kv.js';
import type { AppEnv } from '../platform/storage/storage-port.js';
import type { ReminderRule } from './reminders.repo.js';

const DEFAULT_CONFIG = {
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'password',
  TG_BOT_TOKEN: '',
  TG_CHAT_ID: '',
  TG_TOPIC_ID: '',
  NOTIFYX_API_KEY: '',
  WEBHOOK_URL: '',
  WEBHOOK_METHOD: 'POST',
  WEBHOOK_HEADERS: '',
  WEBHOOK_TEMPLATE: '',
  SHOW_LUNAR: false,
  WECHATBOT_WEBHOOK: '',
  WECHATBOT_MSG_TYPE: 'text',
  WECHATBOT_AT_MOBILES: '',
  WECHATBOT_AT_ALL: 'false',
  RESEND_API_KEY: '',
  EMAIL_FROM: '',
  EMAIL_FROM_NAME: '订阅提醒系统',
  EMAIL_TO: '',
  APP_URL: '',
  BARK_DEVICE_KEY: '',
  BARK_SERVER: 'https://api.day.app',
  BARK_IS_ARCHIVE: 'false',
  ENABLED_NOTIFIERS: ['notifyx'] as string[],
  THEME_MODE: 'system',
  TIMEZONE: 'Asia/Shanghai',
  NOTIFICATION_HOURS: [] as string[],
  // 全局默认提醒规则：null = 从未配置（新建订阅回退内置预设 7/3/1/当天）；
  // 数组（含空数组）= 用户已配置的默认模板，空数组表示新订阅不带任何规则
  DEFAULT_REMINDER_RULES: null as ReminderRule[] | null,
  THIRD_PARTY_API_TOKEN: '',
  DEBUG_LOGS: false,
  PAYMENT_HISTORY_LIMIT: 100,
  GOTIFY_SERVER_URL: '',
  GOTIFY_APP_TOKEN: '',
  SERVERCHAN_SENDKEY: '',
  PUSHPLUS_TOKEN: '',
  PUSHPLUS_TOPIC: '',
  PUSHPLUS_CHANNEL: '',
  NTFY_SERVER: 'https://ntfy.sh',
  NTFY_TOPIC: '',
  NTFY_TOKEN: '',
  WPUSH_APIKEY: '',
  WPUSH_CHANNEL: '',
  WPUSH_TOPIC_CODE: ''
};

/** 应用配置：字段与默认值由 DEFAULT_CONFIG 推导，JWT_SECRET 为运行时生成/持久化的密钥。 */
export type AppConfig = typeof DEFAULT_CONFIG & { JWT_SECRET?: string };

async function getConfig(env: AppEnv): Promise<AppConfig> {
  if (!env.SUBSCRIPTIONS_KV) {
    console.error('[配置] KV存储未绑定');
    throw new Error('KV存储未绑定');
  }
  const data = await env.SUBSCRIPTIONS_KV.get('config');
  console.log('[配置] 从KV读取配置:', data ? '成功' : '空配置');
  // KV 中存的是历史写入的任意 JSON，在系统边界处按 AppConfig 形状断言
  const config = (data ? JSON.parse(data) : {}) as Partial<AppConfig>;

  let jwtSecret = config.JWT_SECRET;
  if (!jwtSecret) {
    console.log('[配置] 生成新的JWT密钥');
    jwtSecret = crypto.randomUUID();
    const updatedConfig = { ...config, JWT_SECRET: jwtSecret };
    await env.SUBSCRIPTIONS_KV.put('config', JSON.stringify(updatedConfig));
  }

  return {
    ...DEFAULT_CONFIG,
    ...config,
    JWT_SECRET: jwtSecret
  } as AppConfig;
}

async function setConfig(env: AppEnv, config: Record<string, unknown>): Promise<void> {
  await putKVJson(env, 'config', config);
}

export {
  DEFAULT_CONFIG,
  getConfig,
  setConfig
};
