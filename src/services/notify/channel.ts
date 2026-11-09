/**
 * 通知渠道统一适配器协议
 *
 * 所有渠道实现均遵循此 shape：
 *
 *   export const xxxChannel = {
 *     name: 'xxx',                        // 渠道名（必须与 ENABLED_NOTIFIERS / 配置 key 保持一致）
 *     validateConfig(config) { ... },     // 返回 { ok: true } 或 { ok: false, error: '...' }
 *     async send(payload, config) { ... },// 实际发送
 *     async test(config) { ... }          // 用配置发送一条测试通知
 *   };
 *
 * 这样 dispatch / 通知日志 / 配置页测试按钮可以用同一份代码处理 9 种渠道。
 *
 */

import type { AppConfig } from '../../data/config.js';

/**
 * 结构化订阅（scheduler 随通知传入，供富渲染渠道直接排版）。
 * 字段与 scheduler 的 metadata.subscriptions 构造保持一致，
 * 只含渲染所需信息，不带 paymentHistory 等无关数据。
 */
export interface StructuredSubscription {
  name: string;
  daysRemaining: number;
  hoursRemaining?: number;
  expiryDate: string;
  amount?: number | null;
  currency?: string;
  category?: string;
  customType?: string;
  periodValue?: number | null;
  periodUnit?: string;
  autoRenew?: boolean;
  useLunar?: boolean;
  notes?: string;
  reminderText?: string;
}

/** 通知元数据（tags、紧迫度、结构化订阅等）；保留索引签名供第三方调用方扩展 */
export interface ChannelMetadata {
  tags?: string[];
  daysRemaining?: number;
  ruleType?: string;
  ruleValue?: number;
  subscriptions?: StructuredSubscription[];
  [key: string]: unknown;
}

/** 通知内容载荷 */
export interface ChannelPayload {
  title: string;
  /** 正文（Markdown 风格，由各渠道按需转换） */
  content: string;
  /** 元数据（tags、subscriptionId 等） */
  metadata?: ChannelMetadata;
}

/** 渠道发送结果 */
export interface ChannelResult {
  /** 是否成功 */
  success: boolean;
  /** 渠道名 */
  channel: string;
  /** 失败原因（HTTP 错误、API 拒绝等） */
  error?: string;
  /** 三方接口原始返回，便于排查（系统边界，保持 any） */
  raw?: any;
}

export interface ValidateResult {
  ok: boolean;
  error?: string;
}

export interface Channel {
  name: string;
  validateConfig(config: AppConfig): ValidateResult;
  send(payload: ChannelPayload, config: AppConfig): Promise<ChannelResult>;
  test(config: AppConfig): Promise<ChannelResult>;
}

/**
 * Telegram MarkdownV2 转义。
 *
 * 修复 #81：订阅名包含 `_*[]()~`>#+-=|{}.!\\` 时 Telegram 会拒绝消息。
 * 注意：这个函数只用于发往 Telegram 的内容，不要污染其他渠道。
 */
export function escapeMarkdownV2(text: string = ''): string {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * 把 commonContent 中的 Markdown 标记移除（用于纯文本渠道）。
 */
export function stripMarkdown(text: string = ''): string {
  return String(text).replace(/(\*\*|\*|##|#|`)/g, '');
}

/**
 * 构造统一的成功结果。
 */
export function ok(name: string, raw?: any): ChannelResult {
  return { success: true, channel: name, raw };
}

/**
 * 构造统一的失败结果。
 */
export function fail(name: string, error: string, raw?: any): ChannelResult {
  return { success: false, channel: name, error, raw };
}

/**
 * 把任意 error 转字符串（兼容 fetch 抛出的 TypeError、Response 等）。
 */
export function errorMessage(err: any): string {
  // 系统边界：入参为任意异常对象（Error / 字符串 / 三方响应），统一在此收口
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
