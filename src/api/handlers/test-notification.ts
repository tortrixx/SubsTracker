import { getConfig, type AppConfig } from '../../data/config.js';
import { testChannel } from '../../services/notify/dispatch.js';
import { writeLog } from '../../data/notification-logs.repo.js';
import type { AppEnv } from '../../platform/storage/storage-port.js';

/**
 * 渠道测试日志的占位 subId（渠道级测试不隶属任何订阅）；
 * 来源以 ruleId = 'test' 标注，与正式发送（真实 ruleId）、订阅手动测试
 * （ruleId = 'manual-test'）区分，活动页与渠道卡按 ruleId 即可辨识。
 */
const CHANNEL_TEST_SUB_ID = 'channel-test';
const CHANNEL_TEST_RULE_ID = 'test';

type ConfigStringKey = {
  [K in keyof AppConfig]-?: AppConfig[K] extends string | undefined ? K : never;
}[keyof AppConfig];

interface ChannelTestSpec {
  label: string;
  /** 非空字符串才覆盖已存值（凭据/ID 字段：留空表示沿用已保存的脱敏凭据） */
  nonEmptyTrimmed?: ConfigStringKey[];
  /** 只要是字符串就 trim 覆盖（允许传空串清空已保存的可选值） */
  stringTrimmed?: ConfigStringKey[];
  /** 其余配置字段（真值覆盖，否则回退 config） */
  fallbackTruthy?: ConfigStringKey[];
}

const CHANNEL_TEST_SPECS: Record<string, ChannelTestSpec> = {
  telegram: {
    label: 'Telegram',
    nonEmptyTrimmed: ['TG_BOT_TOKEN', 'TG_CHAT_ID', 'TG_TOPIC_ID']
  },
  notifyx: {
    label: 'NotifyX',
    nonEmptyTrimmed: ['NOTIFYX_API_KEY']
  },
  webhook: {
    label: 'Webhook ',
    nonEmptyTrimmed: ['WEBHOOK_URL', 'WEBHOOK_HEADERS'],
    fallbackTruthy: ['WEBHOOK_METHOD', 'WEBHOOK_TEMPLATE']
  },
  wechatbot: {
    label: '企业微信机器人',
    nonEmptyTrimmed: ['WECHATBOT_WEBHOOK'],
    fallbackTruthy: ['WECHATBOT_MSG_TYPE', 'WECHATBOT_AT_MOBILES', 'WECHATBOT_AT_ALL']
  },
  email: {
    label: '邮件',
    nonEmptyTrimmed: ['RESEND_API_KEY'],
    fallbackTruthy: ['EMAIL_FROM', 'EMAIL_FROM_NAME', 'EMAIL_TO']
  },
  bark: {
    label: 'Bark',
    nonEmptyTrimmed: ['BARK_DEVICE_KEY'],
    fallbackTruthy: ['BARK_SERVER', 'BARK_IS_ARCHIVE']
  },
  gotify: {
    label: 'Gotify',
    nonEmptyTrimmed: ['GOTIFY_APP_TOKEN'],
    fallbackTruthy: ['GOTIFY_SERVER_URL']
  },
  serverchan: {
    label: 'Server酱',
    nonEmptyTrimmed: ['SERVERCHAN_SENDKEY']
  },
  pushplus: {
    label: 'PushPlus',
    nonEmptyTrimmed: ['PUSHPLUS_TOKEN'],
    fallbackTruthy: ['PUSHPLUS_TOPIC', 'PUSHPLUS_CHANNEL']
  },
  ntfy: {
    label: 'ntfy',
    nonEmptyTrimmed: ['NTFY_TOKEN'],
    fallbackTruthy: ['NTFY_SERVER', 'NTFY_TOPIC']
  },
  wpush: {
    label: 'WPUSH ',
    nonEmptyTrimmed: ['WPUSH_APIKEY'],
    stringTrimmed: ['WPUSH_CHANNEL', 'WPUSH_TOPIC_CODE']
  }
};

function buildTestConfig(
  config: AppConfig,
  body: Record<string, unknown>,
  spec: ChannelTestSpec
): AppConfig {
  const next: AppConfig = { ...config };
  const record = next as unknown as Record<string, unknown>;

  for (const key of spec.nonEmptyTrimmed || []) {
    const val = body[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      record[key] = val.trim();
    }
  }
  for (const key of spec.stringTrimmed || []) {
    const val = body[key];
    if (typeof val === 'string') {
      record[key] = val.trim();
    }
  }
  for (const key of spec.fallbackTruthy || []) {
    if (body[key]) {
      record[key] = body[key];
    }
  }
  return next;
}

async function handleTestNotification(request: Request, env: AppEnv): Promise<Response> {
  try {
    const config = await getConfig(env);
    const body = (await request.json()) as Record<string, unknown>;
    const type = typeof body?.type === 'string' ? body.type.trim() : '';

    if (!type) {
      return new Response(
        JSON.stringify({ success: false, message: '缺少测试类型参数 type' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const spec = Object.hasOwn(CHANNEL_TEST_SPECS, type) ? CHANNEL_TEST_SPECS[type] : undefined;
    if (!spec) {
      return new Response(
        JSON.stringify({ success: false, message: '不支持的测试类型: ' + type }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const testConfig = buildTestConfig(config, body, spec);
    const result = await testChannel(type, testConfig);
    const success = result.success;
    const message = success
      ? `${spec.label}通知发送成功`
      : result.error
        ? `${spec.label}通知发送失败：${result.error}`
        : `${spec.label}通知发送失败，请检查配置`;

    // 渠道测试落一条通知日志（与正式发送同构），使活动页可复查、
    // 渠道卡「最近结果」有真实数据。写日志失败不影响测试结果。
    try {
      await writeLog(env, {
        subId: CHANNEL_TEST_SUB_ID,
        ruleId: CHANNEL_TEST_RULE_ID,
        channel: type,
        status: success ? 'success' : 'failed',
        title: '测试通知',
        error: success ? undefined : (result.error || message)
      });
    } catch (err) {
      console.warn('[测试通知] 写通知日志失败:', err);
    }

    return new Response(
      JSON.stringify({ success, message }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('测试通知失败:', error);
    return new Response(
      JSON.stringify({ success: false, message: '测试通知失败: ' + (error as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export { handleTestNotification };
