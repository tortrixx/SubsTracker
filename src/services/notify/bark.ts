/**
 * Bark 通知渠道（iOS）
 *
 * 支持两种 URL 模式：
 *   1. 标准：BARK_SERVER + BARK_DEVICE_KEY → POST {server}/push
 *   2. 自定义：BARK_SERVER 路径不为 / → POST {server}（已含 key 的完整 URL）
 */
import { ok, fail, errorMessage, stripMarkdown } from './channel.js';
import type { Channel } from './channel.js';
import type { AppConfig } from '../../data/config.js';

export const barkChannel: Channel = {
  name: 'bark',

  validateConfig(config) {
    if (!config.BARK_SERVER && !config.BARK_DEVICE_KEY) {
      return { ok: false, error: '缺少 BARK_DEVICE_KEY 或 BARK_SERVER' };
    }
    return { ok: true };
  },

  async send(payload, config) {
    const v = barkChannel.validateConfig(config);
    if (!v.ok) return fail('bark', v.error || '配置无效');

    const serverUrl = (config.BARK_SERVER || 'https://api.day.app').replace(/\/+$/, '');

    let url: string;
    let headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    let body: Record<string, any>;
    try {
      const parsed = new URL(serverUrl);
      const isCustomUrl = parsed.pathname && parsed.pathname !== '/';

      // Extract Basic Auth credentials if present
      if (parsed.username) {
        const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password || '')}`;
        headers['Authorization'] = `Basic ${btoa(credentials)}`;
        parsed.username = '';
        parsed.password = '';
      }

      if (isCustomUrl) {
        url = parsed.href.replace(/\/+$/, '');
        body = { title: payload.title, body: stripMarkdown(payload.content) };
      } else {
        if (!config.BARK_DEVICE_KEY) return fail('bark', '标准 Bark API 缺少 BARK_DEVICE_KEY');
        url = `${parsed.href.replace(/\/+$/, '')}/push`;
        body = {
          title: payload.title,
          body: stripMarkdown(payload.content),
          device_key: config.BARK_DEVICE_KEY
        };
      }
    } catch {
      return fail('bark', `BARK_SERVER 不是合法 URL: ${serverUrl}`);
    }

    if (config.BARK_IS_ARCHIVE === 'true') body.isArchive = 1;

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      const result = (await r.json().catch(() => ({}))) as { code?: number };
      return result && result.code === 200
        ? ok('bark', result)
        : fail('bark', `Bark 返回 code=${result?.code}`, result);
    } catch (err) {
      return fail('bark', errorMessage(err));
    }
  },

  async test(config) {
    return barkChannel.send(
      { title: '订阅管理 - 测试通知', content: '这是一条 Bark 测试通知。' },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendBarkNotification(title: string, content: string, config: AppConfig): Promise<boolean> {
  const r = await barkChannel.send({ title, content }, config);
  if (!r.success) console.error('[Bark]', r.error);
  return r.success;
}
