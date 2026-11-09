/**
 * WPUSH 通知渠道
 *
 * 文档：https://wpush.cn/docs
 * 发送：POST https://api.wpush.cn/api/v1/send
 * 成功条件：响应 JSON 的 code === 0（注意：与 PushPlus 的 200 不同）
 *
 * 配置：
 * - WPUSH_APIKEY     API Key（必填，勿写入日志）
 * - WPUSH_CHANNEL    可选推送渠道（wechat/app/sms/mail/webhook/dingtalk/feishu/wechat_work/clawbot/qqbot）
 * - WPUSH_TOPIC_CODE 可选 Topic 广播编码
 */
import { ok, fail, errorMessage } from './channel.js';
import type { Channel } from './channel.js';
import type { AppConfig } from '../../data/config.js';

export const wpushChannel: Channel = {
  name: 'wpush',

  validateConfig(config) {
    if (!config.WPUSH_APIKEY || !String(config.WPUSH_APIKEY).trim()) {
      return { ok: false, error: '缺少 WPUSH_APIKEY' };
    }
    return { ok: true };
  },

  async send(payload, config) {
    const v = wpushChannel.validateConfig(config);
    if (!v.ok) return fail('wpush', v.error || '配置无效');

    const body: Record<string, any> = {
      apikey: String(config.WPUSH_APIKEY).trim(),
      title: payload.title || '订阅提醒',
      content: payload.content || payload.title || '订阅提醒'
    };
    if (config.WPUSH_CHANNEL && String(config.WPUSH_CHANNEL).trim()) {
      body.channel = String(config.WPUSH_CHANNEL).trim();
    }
    if (config.WPUSH_TOPIC_CODE && String(config.WPUSH_TOPIC_CODE).trim()) {
      body.topic_code = String(config.WPUSH_TOPIC_CODE).trim();
    }

    try {
      const r = await fetch('https://api.wpush.cn/api/v1/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = (await r.json().catch(() => ({}))) as { code?: number };
      // 第三方响应可能回显 apikey；dispatch 会把 raw/error 写入通知日志。
      const responseCode = typeof result?.code === 'number' ? result.code : null;
      const diagnostic = { httpStatus: r.status, code: responseCode };
      return r.ok && responseCode === 0
        ? ok('wpush', diagnostic)
        : fail('wpush', `WPUSH 返回 HTTP ${r.status}，code=${responseCode ?? '未知'}`, diagnostic);
    } catch (err) {
      const apiKey = String(config.WPUSH_APIKEY).trim();
      return fail('wpush', errorMessage(err).replaceAll(apiKey, '[REDACTED]'));
    }
  },

  async test(config) {
    return wpushChannel.send(
      { title: '订阅管理 - 测试通知', content: '这是一条 WPUSH 测试通知。' },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendWPushNotification(title: string, content: string, config: AppConfig): Promise<boolean> {
  const r = await wpushChannel.send({ title, content }, config);
  if (!r.success) console.error('[WPUSH]', r.error);
  return r.success;
}
