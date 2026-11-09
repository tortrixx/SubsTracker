import {
  getAllSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  manualRenewSubscription,
  previewManualRenewal,
  deletePaymentRecord,
  updatePaymentRecord,
  toggleSubscriptionStatus,
  type SubscriptionInput
} from '../../data/subscriptions.js';
import { getConfig } from '../../data/config.js';
import { sendNotificationToAllChannels } from '../../services/notify/index.js';
import { lunarCalendar } from '../../core/lunar.js';
import { formatTimeInTimezone, formatTimezoneDisplay, getTimezoneDateParts } from '../../core/time.js';
import { formatAmount } from '../../core/currency-format.js';
import { extractTagsFromSubscriptions } from '../utils.js';
import type { AppEnv } from '../../platform/storage/storage-port.js';

interface ActionResult {
  success: boolean;
  message: string;
}

/** 手动续订可选项（与 data 层 manualRenewSubscription 的 options 形状一致） */
interface RenewOptions {
  paymentDate?: string | Date;
  amount?: number;
  periodMultiplier?: number;
  note?: string;
}

/** 支付记录更新体（与 data 层 updatePaymentRecord 的 paymentData 形状一致） */
interface PaymentData {
  date?: string;
  amount?: number;
  currency?: string;
  note?: string;
}

async function testSingleSubscriptionNotification(id: string, env: AppEnv): Promise<ActionResult> {
  try {
    const subscription = await getSubscription(id, env);
    if (!subscription) {
      return { success: false, message: '未找到该订阅' };
    }
    const config = await getConfig(env);

    const title = `手动测试通知: ${subscription.name}`;

    const showLunar = config.SHOW_LUNAR === true;
    let lunarExpiryText = '';

    if (showLunar) {
      const timezoneForLunar = config?.TIMEZONE || 'UTC';
      const expiryParts = getTimezoneDateParts(subscription.expiryDate, timezoneForLunar);
      const lunarExpiry = lunarCalendar.solar2lunar(expiryParts.year, expiryParts.month, expiryParts.day);
      lunarExpiryText = lunarExpiry ? ` (农历: ${lunarExpiry.fullStr})` : '';
    }

    const timezone = config?.TIMEZONE || 'UTC';
    const formattedExpiryDate = formatTimeInTimezone(new Date(subscription.expiryDate), timezone, 'date');
    const currentTime = formatTimeInTimezone(new Date(), timezone, 'datetime');

    const calendarType = subscription.useLunar ? '农历' : '公历';
    const autoRenewText = subscription.autoRenew ? '是' : '否';
    const formattedAmount = formatAmount(subscription.amount, subscription.currency || 'CNY');
    const amountText = formattedAmount ? `\n金额: ${formattedAmount}/周期` : '';

    const categoryText = subscription.category ? subscription.category : '未分类';

    const commonContent = `**订阅详情**
类型: ${subscription.customType || '其他'}${amountText}
分类: ${categoryText}
日历类型: ${calendarType}
到期日期: ${formattedExpiryDate}${lunarExpiryText}
自动续期: ${autoRenewText}
备注: ${subscription.notes || '无'}
发送时间: ${currentTime}
当前时区: ${formatTimezoneDisplay(timezone)}`;

    const tags = extractTagsFromSubscriptions([subscription]);
    const notifyResult = await sendNotificationToAllChannels(title, commonContent, config, '[手动测试]', {
      env, subId: id, ruleId: 'manual-test',
      metadata: { tags }
    });

    const attempted = notifyResult?.attempted || 0;
    const successCount = notifyResult?.successCount || 0;
    const failedCount = notifyResult?.failedCount || 0;

    if (attempted === 0) {
      return { success: false, message: '未启用任何通知渠道，请先在系统配置中开启至少一种通知方式' };
    }

    if (successCount === 0) {
      return { success: false, message: `测试通知发送失败（已尝试 ${attempted} 个渠道）` };
    }

    if (failedCount > 0) {
      return { success: true, message: `测试通知已发送：成功 ${successCount} 个，失败 ${failedCount} 个渠道` };
    }

    return { success: true, message: `测试通知发送成功（共 ${successCount} 个渠道）` };
  } catch (error) {
    console.error('[手动测试] 发送失败:', error);
    return { success: false, message: '发送时发生错误: ' + (error as Error).message };
  }
}

async function handleSubscriptions(request: Request, env: AppEnv, path: string): Promise<Response | null> {
  const method = request.method;

  if (path === '/subscriptions') {
    if (method === 'GET') {
      const subscriptions = await getAllSubscriptions(env);
      return new Response(JSON.stringify(subscriptions), { headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'POST') {
      let subscription: SubscriptionInput;
      try {
        subscription = (await request.json()) as SubscriptionInput;
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: '请求体不是合法 JSON' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const result = await createSubscription(subscription, env);
      // 创建成功后写入提醒规则，并同步 legacy 提醒字段（列表展示依赖）
      if (result.success && result.subscription) {
        try {
          const remindersRepo = await import('../../data/reminders.repo.js');
          const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
          const incoming = Array.isArray(subscription.reminderRules)
            ? subscription.reminderRules
            : null;
          // 未提供规则（或空数组）时套默认：优先全局配置 DEFAULT_REMINDER_RULES，
          // 未配置则由 resolveDefaultRules 回退内置预设（行为与历史一致）
          const rules = incoming && incoming.length > 0
            ? incoming.map(remindersRepo.normalizeRule)
            : remindersRepo.resolveDefaultRules(await getConfig(env));
          await remindersRepo.replaceForSubscription(env, result.subscription.id, rules);
          await syncLegacyReminderFields(env, result.subscription.id, rules);
        } catch (err) {
          console.error('[subscriptions] 写入提醒规则失败（订阅本身已创建）:', err);
        }
      }
      return new Response(JSON.stringify(result), {
        status: result.success ? 201 : 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  if (path.startsWith('/subscriptions/')) {
    const parts = path.split('/');
    const id = parts[2];

    if (parts[3] === 'toggle-status' && method === 'POST') {
      const body = (await request.json()) as { isActive: boolean };
      const result = await toggleSubscriptionStatus(id, body.isActive, env);
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (parts[3] === 'test-notify' && method === 'POST') {
      const result = await testSingleSubscriptionNotification(id, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'renew' && parts[4] === 'preview' && method === 'POST') {
      let options: RenewOptions = {};
      try {
        const body = (await request.json()) as RenewOptions | null;
        options = body || {};
      } catch (e) {
        // empty
      }
      const result = await previewManualRenewal(id, env, options);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'renew' && method === 'POST') {
      let options: RenewOptions = {};
      try {
        const body = (await request.json()) as RenewOptions | null;
        options = body || {};
      } catch (e) {
        // empty
      }
      const result = await manualRenewSubscription(id, env, options);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'payments' && method === 'GET') {
      const subscription = await getSubscription(id, env);
      if (!subscription) {
        return new Response(JSON.stringify({ success: false, message: '订阅不存在' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ success: true, payments: subscription.paymentHistory || [] }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'payments' && parts[4] && method === 'DELETE') {
      const paymentId = parts[4];
      const result = await deletePaymentRecord(id, paymentId, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'payments' && parts[4] && method === 'PUT') {
      const paymentId = parts[4];
      const paymentData = (await request.json()) as PaymentData;
      const result = await updatePaymentRecord(id, paymentId, paymentData, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'GET') {
      const subscription = await getSubscription(id, env);
      if (!subscription) {
        return new Response(
          JSON.stringify({ success: false, message: '订阅不存在' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify(subscription), { headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'PUT') {
      let subscription: SubscriptionInput;
      try {
        subscription = (await request.json()) as SubscriptionInput;
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: '请求体不是合法 JSON' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const result = await updateSubscription(id, subscription, env);
      // 与创建路径对称：若 body 带 reminderRules 则整体替换并同步 legacy
      if (result.success && Array.isArray(subscription.reminderRules)) {
        try {
          const remindersRepo = await import('../../data/reminders.repo.js');
          const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
          const rules = subscription.reminderRules.map(remindersRepo.normalizeRule);
          await remindersRepo.replaceForSubscription(env, id, rules);
          await syncLegacyReminderFields(env, id, rules);
        } catch (err) {
          console.error('[subscriptions] 更新提醒规则失败（订阅本体已更新）:', err);
        }
      }
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'DELETE') {
      const result = await deleteSubscription(id, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return null;
}

export { handleSubscriptions };
