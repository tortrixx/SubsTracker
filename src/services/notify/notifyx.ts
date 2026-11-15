/**
 * NotifyX 通知渠道（https://www.notifyx.cn）
 */
import { ok, fail, errorMessage, fetchWithTimeout, redactSecrets } from './channel.js';
import type { Channel } from './channel.js';

export const notifyxChannel: Channel = {
  name: 'notifyx',

  validateConfig(config) {
    if (!config.NOTIFYX_API_KEY) return { ok: false, error: '缺少 NOTIFYX_API_KEY' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = notifyxChannel.validateConfig(config);
    if (!v.ok) return fail('notifyx', v.error || '配置无效');

    const url = `https://www.notifyx.cn/api/v1/send/${config.NOTIFYX_API_KEY}`;
    const body = JSON.stringify({
      title: payload.title || '订阅提醒',
      content: `## ${payload.title || '订阅提醒'}\n\n${payload.content || ''}`,
      description: '订阅提醒'
    });

    try {
      const r = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      const result = (await r.json()) as { status?: string };
      return result.status === 'queued'
        ? ok('notifyx', result)
        : fail('notifyx', `NotifyX 返回 ${result.status || 'unknown'}`, result);
    } catch (err) {
      return fail('notifyx', redactSecrets(errorMessage(err), config.NOTIFYX_API_KEY));
    }
  },

  async test(config) {
    return notifyxChannel.send(
      { title: '订阅管理 - 测试通知', content: '这是一条 NotifyX 测试通知。' },
      config
    );
  }
};
