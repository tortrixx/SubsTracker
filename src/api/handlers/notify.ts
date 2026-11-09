import { getConfig, type AppConfig } from '../../data/config.js';
import { sendNotificationToAllChannels } from '../../services/notify/index.js';
import type { AppEnv } from '../../platform/storage/storage-port.js';

/** 第三方通知请求体（JSON 边界形状；tags 的元素在下方逐个校验）。 */
interface ThirdPartyNotifyBody {
  title?: string;
  content?: string;
  tags?: unknown;
}

async function handleThirdPartyNotify(
  request: Request,
  env: AppEnv,
  config: AppConfig,
  url: URL
): Promise<Response | null> {
  const path = url.pathname.slice(4);
  if (!path.startsWith('/notify/')) return null;

  const pathSegments = path.split('/');
  const tokenFromPath = pathSegments[2] || '';
  const tokenFromHeader = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const tokenFromQuery = url.searchParams.get('token') || '';
  const providedToken = tokenFromPath || tokenFromHeader || tokenFromQuery;
  const expectedToken = config.THIRD_PARTY_API_TOKEN || '';

  if (!expectedToken) {
    return new Response(
      JSON.stringify({ message: '第三方 API 已禁用，请在后台配置访问令牌后使用' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!providedToken || providedToken !== expectedToken) {
    return new Response(
      JSON.stringify({ message: '访问未授权，令牌无效或缺失' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (request.method !== 'POST') return null;

  try {
    const body = (await request.json()) as ThirdPartyNotifyBody;
    const title = body.title || '第三方通知';
    const content = body.content || '';

    if (!content) {
      return new Response(
        JSON.stringify({ message: '缺少必填参数 content' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const config = await getConfig(env);
    const bodyTagsRaw = Array.isArray(body.tags)
      ? body.tags
      : (typeof body.tags === 'string' ? body.tags.split(/[,，\s]+/) : []);
    const bodyTags = Array.isArray(bodyTagsRaw)
      ? bodyTagsRaw.filter(tag => typeof tag === 'string' && tag.trim().length > 0).map(tag => tag.trim())
      : [];

    await sendNotificationToAllChannels(title, content, config, '[第三方API]', {
      metadata: { tags: bodyTags }
    });

    return new Response(
      JSON.stringify({
        message: '发送成功',
        response: {
          errcode: 0,
          errmsg: 'ok',
          msgid: 'MSGID' + Date.now()
        }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[第三方API] 发送通知失败:', error);
    return new Response(
      JSON.stringify({
        message: '发送失败',
        response: {
          errcode: 1,
          errmsg: (error as Error).message
        }
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export { handleThirdPartyNotify };
