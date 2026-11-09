/**
 * 通知调度入口
 *
 * 旧 sendNotificationToAllChannels 现在是 dispatch.dispatch 的薄壳，
 * 保留签名向后兼容。新代码请直接使用 dispatch / testChannel。
 *
 */
import { dispatch } from './dispatch.js';
import type { ChannelMetadata } from './channel.js';
import type { AppConfig } from '../../data/config.js';
import type { AppEnv } from '../../platform/storage/storage-port.js';

export interface SendNotificationOptions {
  env?: AppEnv;
  subId?: string;
  ruleId?: string;
  metadata?: ChannelMetadata;
}

export async function sendNotificationToAllChannels(
  title: string,
  commonContent: string,
  config: AppConfig,
  logPrefix: string = '[定时任务]',
  options: SendNotificationOptions = {}
) {
  const result = await dispatch(
    { title, content: commonContent },
    config,
    {
      logPrefix,
      env: options.env,
      subId: options.subId,
      ruleId: options.ruleId,
      metadata: options.metadata
    }
  );

  // 旧调用方期望的字段名
  return {
    attempted: result.attempted,
    successCount: result.successCount,
    failedCount: result.failedCount,
    channelResults: result.channelResults
  };
}

export { dispatch, testChannel } from './dispatch.js';
