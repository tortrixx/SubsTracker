/**
 * 通知调度器：把一条通知并发分发到所有启用的渠道，并把结果写入通知日志。
 *
 * 调用方：
 * - services/scheduler.js（定时到期检查）
 * - api/handlers/test-notification.js（手动测试单个渠道）
 * - api/handlers/notify.js（第三方 /api/notify/{token}）
 *
 */

import { telegramChannel } from './telegram.js';
import { notifyxChannel } from './notifyx.js';
import { webhookChannel } from './webhook.js';
import { wecomChannel } from './wechat.js';
import { emailChannel } from './email.js';
import { barkChannel } from './bark.js';
import { gotifyChannel } from './gotify.js';
import { serverChanChannel } from './serverchan.js';
import { pushplusChannel } from './pushplus.js';
import { ntfyChannel } from './ntfy.js';
import { wpushChannel } from './wpush.js';
import { writeLog } from '../../data/notification-logs.repo.js';
import type { Channel, ChannelMetadata, ChannelResult } from './channel.js';
import type { AppConfig } from '../../data/config.js';
import type { AppEnv } from '../../platform/storage/storage-port.js';

/** 名字到渠道实例的映射；新增渠道在此注册即可 */
export const ALL_CHANNELS: Record<string, Channel> = {
  telegram: telegramChannel,
  notifyx: notifyxChannel,
  webhook: webhookChannel,
  wechatbot: wecomChannel,
  email: emailChannel,
  bark: barkChannel,
  gotify: gotifyChannel,
  serverchan: serverChanChannel,
  pushplus: pushplusChannel,
  ntfy: ntfyChannel,
  wpush: wpushChannel
};

export interface DispatchOptions {
  /** 可选的渠道子集；仍受 ENABLED_NOTIFIERS 约束。 */
  channels?: string[];
  /** 若提供，会同时把每条结果写入 notify_log */
  env?: AppEnv;
  /** 关联的订阅 ID（写日志用） */
  subId?: string;
  /** 触发的提醒规则 ID（写日志用） */
  ruleId?: string;
  /** 聚合通知中的所有订阅和规则；每项各写一条记录，便于按订阅查询。 */
  logTargets?: Array<{ subId: string; ruleId?: string }>;
  /** 附加给 channel.send 的 metadata */
  metadata?: ChannelMetadata;
  /** console 日志前缀 */
  logPrefix?: string;
}

export interface DispatchResult {
  attempted: number;
  successCount: number;
  failedCount: number;
  results: ChannelResult[];
  channelResults: Record<string, boolean>;
}

/**
 * 把一条通知发到所有启用渠道。
 */
export async function dispatch(
  payload: { title: string; content: string },
  config: AppConfig,
  options: DispatchOptions = {}
): Promise<DispatchResult> {
  const enabled = Array.isArray(config.ENABLED_NOTIFIERS) ? config.ENABLED_NOTIFIERS : [];
  const prefix = options.logPrefix || '[notify]';

  const channels = [...new Set(enabled)]
    .filter((name) => Object.hasOwn(ALL_CHANNELS, name) && (!options.channels || options.channels.includes(name)))
    .map((name) => ALL_CHANNELS[name])
    .filter((ch) => ch != null);

  if (channels.length === 0) {
    console.log(`${prefix} 未启用任何通知渠道`);
    return { attempted: 0, successCount: 0, failedCount: 0, results: [], channelResults: {} };
  }

  const settled = await Promise.allSettled(
    channels.map((ch) =>
      ch.send({ ...payload, metadata: options.metadata }, config).catch((err) => ({
        success: false,
        channel: ch.name,
        error: err && err.message ? err.message : String(err)
      }))
    )
  );

  const results: ChannelResult[] = settled.map((r, idx) => {
    if (r.status === 'fulfilled') {
      return r.value;
    }
    return {
      success: false,
      channel: channels[idx].name,
      error: r.reason && r.reason.message ? r.reason.message : String(r.reason)
    };
  });

  const channelResults: Record<string, boolean> = {};
  let successCount = 0;
  let failedCount = 0;
  for (const r of results) {
    channelResults[r.channel] = r.success;
    if (r.success) {
      successCount++;
      console.log(`${prefix} ${r.channel} 发送成功`);
    } else {
      failedCount++;
      console.log(`${prefix} ${r.channel} 发送失败: ${r.error}`);
    }

    // 写通知日志（带 env 时）
    const targets = options.logTargets ?? (options.subId ? [{ subId: options.subId, ruleId: options.ruleId }] : []);
    if (options.env) {
      const env = options.env;
      await Promise.all(targets.map(async (target) => {
        try {
          await writeLog(env, {
            subId: target.subId,
            ruleId: target.ruleId || null,
            channel: r.channel,
            status: r.success ? 'success' : 'failed',
            title: payload.title,
            content: payload.content,
            error: r.error,
            raw: r.raw
          });
        } catch (err) {
          console.warn(`${prefix} 写通知日志失败:`, err);
        }
      }));
    }
  }

  return {
    attempted: results.length,
    successCount,
    failedCount,
    results,
    channelResults
  };
}

/**
 * 测试某个渠道（用于配置页"测试发送"按钮）。
 */
export async function testChannel(channelName: string, config: AppConfig): Promise<ChannelResult> {
  const ch = Object.hasOwn(ALL_CHANNELS, channelName) ? ALL_CHANNELS[channelName] : undefined;
  if (!ch) {
    return {
      success: false,
      channel: channelName,
      error: `未知渠道: ${channelName}`
    };
  }
  try {
    return await ch.test(config);
  } catch (err: any) {
    // 边界：渠道 test 抛出的异常形态不限，统一字符串化
    return {
      success: false,
      channel: channelName,
      error: err && err.message ? err.message : String(err)
    };
  }
}
