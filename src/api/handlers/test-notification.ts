import { getConfig, type AppConfig } from '../../data/config.js';
import { formatBeijingTime } from '../../core/time.js';
import { sendTelegramNotification } from '../../services/notify/telegram.js';
import { sendNotifyXNotification } from '../../services/notify/notifyx.js';
import { sendWebhookNotification } from '../../services/notify/webhook.js';
import { sendWechatBotNotification } from '../../services/notify/wechat.js';
import { emailChannel } from '../../services/notify/email.js';
import { sendBarkNotification } from '../../services/notify/bark.js';
import { sendGotifyNotification } from '../../services/notify/gotify.js';
import { sendServerChanNotification } from '../../services/notify/serverchan.js';
import { sendPushPlusNotification } from '../../services/notify/pushplus.js';
import { sendNtfyNotification } from '../../services/notify/ntfy.js';
import { sendWPushNotification } from '../../services/notify/wpush.js';
import { writeLog } from '../../data/notification-logs.repo.js';
import type { AppEnv } from '../../platform/storage/storage-port.js';

/**
 * 渠道测试日志的占位 subId（渠道级测试不隶属任何订阅）；
 * 来源以 ruleId = 'test' 标注，与正式发送（真实 ruleId）、订阅手动测试
 * （ruleId = 'manual-test'）区分，活动页与渠道卡按 ruleId 即可辨识。
 */
const CHANNEL_TEST_SUB_ID = 'channel-test';
const CHANNEL_TEST_RULE_ID = 'test';

/** 测试通知请求体（JSON 边界：各渠道的待测字段，取值在使用处逐个守卫） */
interface TestNotificationBody {
  type?: unknown;
  TG_BOT_TOKEN?: string;
  TG_CHAT_ID?: string;
  TG_TOPIC_ID?: string;
  NOTIFYX_API_KEY?: string;
  WEBHOOK_URL?: string;
  WEBHOOK_METHOD?: string;
  WEBHOOK_HEADERS?: string;
  WEBHOOK_TEMPLATE?: string;
  WECHATBOT_WEBHOOK?: string;
  WECHATBOT_MSG_TYPE?: string;
  WECHATBOT_AT_MOBILES?: string;
  WECHATBOT_AT_ALL?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  EMAIL_TO?: string;
  BARK_SERVER?: string;
  BARK_DEVICE_KEY?: string;
  BARK_IS_ARCHIVE?: string;
  GOTIFY_SERVER_URL?: string;
  GOTIFY_APP_TOKEN?: string;
  SERVERCHAN_SENDKEY?: string;
  PUSHPLUS_TOKEN?: string;
  PUSHPLUS_TOPIC?: string;
  PUSHPLUS_CHANNEL?: string;
  NTFY_SERVER?: string;
  NTFY_TOPIC?: string;
  NTFY_TOKEN?: string;
  WPUSH_APIKEY?: string;
  WPUSH_CHANNEL?: string;
  WPUSH_TOPIC_CODE?: string;
}

async function handleTestNotification(request: Request, env: AppEnv): Promise<Response> {
  try {
    const config = await getConfig(env);
    const body = (await request.json()) as TestNotificationBody;
    let success = false;
    let message = '';

    const type = typeof body.type === 'string' ? body.type.trim() : '';
    const supportedTypes = ['telegram', 'notifyx', 'webhook', 'wechatbot', 'email', 'bark', 'gotify', 'serverchan', 'pushplus', 'ntfy', 'wpush'];

    if (!type) {
      return new Response(
        JSON.stringify({ success: false, message: '缺少测试类型参数 type' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!supportedTypes.includes(type)) {
      return new Response(
        JSON.stringify({ success: false, message: '不支持的测试类型: ' + type }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (type === 'telegram') {
      const testConfig: AppConfig = {
        ...config,
        TG_BOT_TOKEN: typeof body.TG_BOT_TOKEN === 'string' && body.TG_BOT_TOKEN.trim().length > 0 ? body.TG_BOT_TOKEN.trim() : config.TG_BOT_TOKEN,
        TG_CHAT_ID: typeof body.TG_CHAT_ID === 'string' && body.TG_CHAT_ID.trim().length > 0 ? body.TG_CHAT_ID.trim() : config.TG_CHAT_ID,
        TG_TOPIC_ID: typeof body.TG_TOPIC_ID === 'string' && body.TG_TOPIC_ID.trim().length > 0 ? body.TG_TOPIC_ID.trim() : config.TG_TOPIC_ID
      };

      const content = '*测试通知*\n\n这是一条测试通知，用于验证Telegram通知功能是否正常工作。\n\n发送时间: ' + formatBeijingTime();
      success = await sendTelegramNotification(content, testConfig);
      message = success ? 'Telegram通知发送成功' : 'Telegram通知发送失败，请检查配置';
    } else if (type === 'notifyx') {
      const testConfig: AppConfig = {
        ...config,
        NOTIFYX_API_KEY: (typeof body.NOTIFYX_API_KEY === 'string' && body.NOTIFYX_API_KEY.trim().length > 0)
          ? body.NOTIFYX_API_KEY.trim()
          : config.NOTIFYX_API_KEY
      };

      const title = '测试通知';
      const content = '## 这是一条测试通知\n\n用于验证NotifyX通知功能是否正常工作。\n\n发送时间: ' + formatBeijingTime();
      const description = '测试NotifyX通知功能';

      success = await sendNotifyXNotification(title, content, description, testConfig);
      message = success ? 'NotifyX通知发送成功' : 'NotifyX通知发送失败，请检查配置';
    } else if (type === 'webhook') {
      const testConfig: AppConfig = {
        ...config,
        WEBHOOK_URL: (typeof body.WEBHOOK_URL === 'string' && body.WEBHOOK_URL.trim().length > 0)
          ? body.WEBHOOK_URL.trim()
          : config.WEBHOOK_URL,
        WEBHOOK_METHOD: body.WEBHOOK_METHOD || config.WEBHOOK_METHOD,
        WEBHOOK_HEADERS: (typeof body.WEBHOOK_HEADERS === 'string' && body.WEBHOOK_HEADERS.trim().length > 0)
          ? body.WEBHOOK_HEADERS.trim()
          : config.WEBHOOK_HEADERS,
        WEBHOOK_TEMPLATE: body.WEBHOOK_TEMPLATE || config.WEBHOOK_TEMPLATE
      };

      const title = '测试通知';
      const content = '这是一条测试通知，用于验证Webhook 通知功能是否正常工作。\n\n发送时间: ' + formatBeijingTime();

      success = await sendWebhookNotification(title, content, testConfig);
      message = success ? 'Webhook 通知发送成功' : 'Webhook 通知发送失败，请检查配置';
    } else if (type === 'wechatbot') {
      const testConfig: AppConfig = {
        ...config,
        WECHATBOT_WEBHOOK: (typeof body.WECHATBOT_WEBHOOK === 'string' && body.WECHATBOT_WEBHOOK.trim().length > 0)
          ? body.WECHATBOT_WEBHOOK.trim()
          : config.WECHATBOT_WEBHOOK,
        WECHATBOT_MSG_TYPE: body.WECHATBOT_MSG_TYPE || config.WECHATBOT_MSG_TYPE,
        WECHATBOT_AT_MOBILES: body.WECHATBOT_AT_MOBILES || config.WECHATBOT_AT_MOBILES,
        WECHATBOT_AT_ALL: body.WECHATBOT_AT_ALL || config.WECHATBOT_AT_ALL
      };

      const title = '测试通知';
      const content = '这是一条测试通知，用于验证企业微信机器人功能是否正常工作。\n\n发送时间: ' + formatBeijingTime();

      success = await sendWechatBotNotification(title, content, testConfig);
      message = success ? '企业微信机器人通知发送成功' : '企业微信机器人通知发送失败，请检查配置';
    } else if (type === 'email') {
      const testConfig: AppConfig = {
        ...config,
        RESEND_API_KEY: (typeof body.RESEND_API_KEY === 'string' && body.RESEND_API_KEY.trim().length > 0)
          ? body.RESEND_API_KEY.trim()
          : config.RESEND_API_KEY,
        EMAIL_FROM: body.EMAIL_FROM || config.EMAIL_FROM,
        EMAIL_FROM_NAME: body.EMAIL_FROM_NAME || config.EMAIL_FROM_NAME,
        EMAIL_TO: body.EMAIL_TO || config.EMAIL_TO
      };

      // 邮件测试走渠道 test()：发送内置示例订阅的真实版式邮件（所见即所得）
      const result = await emailChannel.test(testConfig);
      success = result.success;
      message = success ? '邮件通知发送成功' : '邮件通知发送失败，请检查配置';
    } else if (type === 'bark') {
      const testConfig: AppConfig = {
        ...config,
        BARK_SERVER: body.BARK_SERVER || config.BARK_SERVER,
        BARK_DEVICE_KEY: (typeof body.BARK_DEVICE_KEY === 'string' && body.BARK_DEVICE_KEY.trim().length > 0)
          ? body.BARK_DEVICE_KEY.trim()
          : config.BARK_DEVICE_KEY,
        BARK_IS_ARCHIVE: body.BARK_IS_ARCHIVE || config.BARK_IS_ARCHIVE
      };

      const title = '测试通知';
      const content = '这是一条测试通知，用于验证Bark通知功能是否正常工作。\n\n发送时间: ' + formatBeijingTime();

      success = await sendBarkNotification(title, content, testConfig);
      message = success ? 'Bark通知发送成功' : 'Bark通知发送失败，请检查配置';
    } else if (type === 'gotify') {
      const testConfig: AppConfig = {
        ...config,
        GOTIFY_SERVER_URL: body.GOTIFY_SERVER_URL || config.GOTIFY_SERVER_URL,
        GOTIFY_APP_TOKEN: (typeof body.GOTIFY_APP_TOKEN === 'string' && body.GOTIFY_APP_TOKEN.trim().length > 0)
          ? body.GOTIFY_APP_TOKEN.trim()
          : config.GOTIFY_APP_TOKEN
      };

      const title = '测试通知';
      const content = '这是一条测试通知，用于验证Gotify通知功能是否正常工作。\n\n发送时间: ' + formatBeijingTime();

      success = await sendGotifyNotification(title, content, testConfig);
      message = success ? 'Gotify通知发送成功' : 'Gotify通知发送失败，请检查配置';
    } else if (type === 'serverchan') {
      const testConfig: AppConfig = {
        ...config,
        SERVERCHAN_SENDKEY: (typeof body.SERVERCHAN_SENDKEY === 'string' && body.SERVERCHAN_SENDKEY.trim().length > 0)
          ? body.SERVERCHAN_SENDKEY.trim()
          : config.SERVERCHAN_SENDKEY
      };

      const title = '测试通知';
      const content = '这是一条测试通知，用于验证Server酱通知功能是否正常工作。\n\n发送时间: ' + formatBeijingTime();

      success = await sendServerChanNotification(title, content, testConfig);
      message = success ? 'Server酱通知发送成功' : 'Server酱通知发送失败，请检查配置';
    } else if (type === 'pushplus') {
      const testConfig: AppConfig = {
        ...config,
        PUSHPLUS_TOKEN: (typeof body.PUSHPLUS_TOKEN === 'string' && body.PUSHPLUS_TOKEN.trim().length > 0)
          ? body.PUSHPLUS_TOKEN.trim()
          : config.PUSHPLUS_TOKEN,
        PUSHPLUS_TOPIC: body.PUSHPLUS_TOPIC || config.PUSHPLUS_TOPIC,
        PUSHPLUS_CHANNEL: body.PUSHPLUS_CHANNEL || config.PUSHPLUS_CHANNEL
      };

      const title = '测试通知';
      const content = '这是一条测试通知，用于验证PushPlus通知功能是否正常工作。\n\n发送时间: ' + formatBeijingTime();

      success = await sendPushPlusNotification(title, content, testConfig);
      message = success ? 'PushPlus通知发送成功' : 'PushPlus通知发送失败，请检查配置';
    } else if (type === 'ntfy') {
      const testConfig: AppConfig = {
        ...config,
        NTFY_SERVER: body.NTFY_SERVER || config.NTFY_SERVER,
        NTFY_TOPIC: body.NTFY_TOPIC || config.NTFY_TOPIC,
        NTFY_TOKEN: (typeof body.NTFY_TOKEN === 'string' && body.NTFY_TOKEN.trim().length > 0)
          ? body.NTFY_TOKEN.trim()
          : config.NTFY_TOKEN
      };
      const title = '测试通知';
      const content = '这是一条测试通知，用于验证 ntfy 通知功能是否正常工作。\n\n发送时间: ' + formatBeijingTime();
      success = await sendNtfyNotification(title, content, testConfig);
      message = success ? 'ntfy 通知发送成功' : 'ntfy 通知发送失败，请检查配置';
    } else if (type === 'wpush') {
      const testConfig: AppConfig = {
        ...config,
        WPUSH_APIKEY: (typeof body.WPUSH_APIKEY === 'string' && body.WPUSH_APIKEY.trim().length > 0)
          ? body.WPUSH_APIKEY.trim()
          : config.WPUSH_APIKEY,
        WPUSH_CHANNEL: typeof body.WPUSH_CHANNEL === 'string' ? body.WPUSH_CHANNEL.trim() : config.WPUSH_CHANNEL,
        WPUSH_TOPIC_CODE: typeof body.WPUSH_TOPIC_CODE === 'string' ? body.WPUSH_TOPIC_CODE.trim() : config.WPUSH_TOPIC_CODE
      };
      const title = '测试通知';
      const content = '这是一条测试通知，用于验证 WPUSH 通知功能是否正常工作。\n\n发送时间: ' + formatBeijingTime();
      success = await sendWPushNotification(title, content, testConfig);
      message = success ? 'WPUSH 通知发送成功' : 'WPUSH 通知发送失败，请检查配置';
    }

    // 渠道测试落一条通知日志（与正式发送同构），使活动页可复查、
    // 渠道卡「最近结果」有真实数据（验收 A11/A12）。写日志失败不影响测试结果。
    try {
      await writeLog(env, {
        subId: CHANNEL_TEST_SUB_ID,
        ruleId: CHANNEL_TEST_RULE_ID,
        channel: type,
        status: success ? 'success' : 'failed',
        title: '测试通知',
        error: success ? undefined : message
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
