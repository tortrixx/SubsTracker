/**
 * Server酱 3 通知渠道
 */
import { ok, fail, errorMessage, fetchWithTimeout, redactSecrets } from './channel.js';
import type { Channel } from './channel.js';

export const serverChanChannel: Channel = {
  name: 'serverchan',

  validateConfig(config) {
    if (!config.SERVERCHAN_SENDKEY) return { ok: false, error: '缺少 SERVERCHAN_SENDKEY' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = serverChanChannel.validateConfig(config);
    if (!v.ok) return fail('serverchan', v.error || '配置无效');

    const endpoint = `https://sctapi.ftqq.com/${config.SERVERCHAN_SENDKEY}.send`;
    const body = new URLSearchParams({
      title: payload.title || '订阅提醒',
      desp: `## ${payload.title || '订阅提醒'}\n\n${payload.content || ''}`
    });

    try {
      const r = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const result = (await r.json().catch(() => ({}))) as { code?: number; message?: string };
      return result && result.code === 0
        ? ok('serverchan', result)
        : fail('serverchan', `Server酱返回 code=${result?.code} ${result?.message || ''}`, result);
    } catch (err) {
      return fail('serverchan', redactSecrets(errorMessage(err), config.SERVERCHAN_SENDKEY));
    }
  },

  async test(config) {
    return serverChanChannel.send(
      { title: '订阅管理 - 测试通知', content: '这是一条 Server酱 测试通知。' },
      config
    );
  }
};
