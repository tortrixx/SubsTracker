/**
 * 企业微信机器人通知渠道
 *
 * 支持 text / markdown 两种消息格式，可配置 @所有人 / @手机号。
 */
import { ok, fail, errorMessage, stripMarkdown } from './channel.js';
import type { Channel } from './channel.js';
import type { AppConfig } from '../../data/config.js';

export const wecomChannel: Channel = {
  name: 'wechatbot',

  validateConfig(config) {
    if (!config.WECHATBOT_WEBHOOK) return { ok: false, error: '缺少 WECHATBOT_WEBHOOK' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = wecomChannel.validateConfig(config);
    if (!v.ok) return fail('wechatbot', v.error || '配置无效');

    const msgType = config.WECHATBOT_MSG_TYPE || 'text';
    let messageData: {
      msgtype: string;
      markdown?: { content: string };
      text?: { content: string; mentioned_list?: string[]; mentioned_mobile_list?: string[] };
    };

    if (msgType === 'markdown') {
      const markdownContent = `# ${payload.title}\n\n${payload.content}`;
      messageData = { msgtype: 'markdown', markdown: { content: markdownContent } };
    } else {
      const textContent = `${payload.title}\n\n${stripMarkdown(payload.content)}`;
      messageData = { msgtype: 'text', text: { content: textContent } };
    }

    if (config.WECHATBOT_AT_ALL === 'true' && msgType === 'text') {
      messageData.text!.mentioned_list = ['@all'];
    } else if (config.WECHATBOT_AT_MOBILES) {
      const mobiles = String(config.WECHATBOT_AT_MOBILES)
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
      if (mobiles.length > 0 && msgType === 'text') {
        messageData.text!.mentioned_mobile_list = mobiles;
      }
    }

    try {
      const r = await fetch(config.WECHATBOT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageData)
      });
      const text = await r.text();
      if (!r.ok) return fail('wechatbot', `HTTP ${r.status}`, text);

      let result: { errcode?: number; errmsg?: string };
      try {
        result = JSON.parse(text) as { errcode?: number; errmsg?: string };
      } catch {
        return fail('wechatbot', '响应非 JSON', text);
      }
      return result.errcode === 0
        ? ok('wechatbot', result)
        : fail('wechatbot', `企业微信返回 errcode=${result.errcode} ${result.errmsg || ''}`, result);
    } catch (err) {
      return fail('wechatbot', errorMessage(err));
    }
  },

  async test(config) {
    return wecomChannel.send(
      { title: '订阅管理 - 测试通知', content: '这是一条企业微信测试通知。' },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendWechatBotNotification(title: string, content: string, config: AppConfig): Promise<boolean> {
  const r = await wecomChannel.send({ title, content }, config);
  if (!r.success) console.error('[企业微信]', r.error);
  return r.success;
}
