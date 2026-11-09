/**
 * Server酱 3 通知渠道
 */
import { ok, fail, errorMessage } from './channel.js';
import type { Channel } from './channel.js';
import type { AppConfig } from '../../data/config.js';

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
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const result = (await r.json().catch(() => ({}))) as { code?: number; message?: string };
      return result && result.code === 0
        ? ok('serverchan', result)
        : fail('serverchan', `Server酱返回 code=${result?.code} ${result?.message || ''}`, result);
    } catch (err) {
      return fail('serverchan', errorMessage(err));
    }
  },

  async test(config) {
    return serverChanChannel.send(
      { title: '订阅管理 - 测试通知', content: '这是一条 Server酱 测试通知。' },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendServerChanNotification(title: string, content: string, config: AppConfig): Promise<boolean> {
  const r = await serverChanChannel.send({ title, content }, config);
  if (!r.success) console.error('[Server酱]', r.error);
  return r.success;
}
