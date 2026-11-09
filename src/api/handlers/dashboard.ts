/**
 * 仪表盘统计 handler
 *
 * 改动：
 * - 用户时区从 config.TIMEZONE 读取（不再硬编码 'UTC'）
 * - schedulerStatus / schedulerStatusHistory 从新的 scheduler-logs.repo 取
 *   旧 'scheduler_status' / 'scheduler_status_history' 已废弃（迁移会清掉）
 *
 */
import { getAllSubscriptions } from '../../data/subscriptions.js';
import {
  getDynamicRates,
  calculateMonthlyExpense,
  calculateYearlyExpense,
  getRecentPayments,
  getUpcomingRenewals,
  getExpenseByType,
  getExpenseByCategory,
  type CurrencySubscription
} from '../../core/currency.js';
import { getCurrentTimeInTimezone, MS_PER_DAY } from '../../core/time.js';
import * as schedulerLogsRepo from '../../data/scheduler-logs.repo.js';
import type { SchedulerLogEntry } from '../../data/scheduler-logs.repo.js';
import type { AppConfig } from '../../data/config.js';
import type { AppEnv } from '../../platform/storage/storage-port.js';

async function handleDashboardStats(env: AppEnv, config: AppConfig): Promise<Response> {
  try {
    const subscriptions = await getAllSubscriptions(env);
    const timezone = (config && config.TIMEZONE) || 'UTC';

    /** 本次：从结构化日志库读最新调度状态 */
    let schedulerStatus = null;
    let schedulerStatusHistory: SchedulerLogEntry[] = [];
    try {
      const recent = await schedulerLogsRepo.getRecent(env, 10);
      schedulerStatusHistory = recent;
      // 兼容老前端字段：转一份扁平结构
      if (recent.length > 0) {
        const head = recent[0];
        schedulerStatus = {
          lastRunAt: head.startedAt,
          timezone: head.timezone,
          currentHour: head.currentHour,
          configuredHours: head.configuredHours,
          shouldNotifyThisHour: head.inWindow,
          checkedSubscriptions: head.checkedCount,
          activeSubscriptions: head.checkedCount,
          expiringMatched: head.matchedCount,
          dedupeSkipped: head.dedupedCount,
          updatedSubscriptions: head.autoRenewedCount,
          sent: head.sentCount > 0,
          reason: head.reason,
          status: head.status,
          extra: head.extra
        };
      }
    } catch (error) {
      console.error('读取调度日志失败:', error);
    }

    const rates = await getDynamicRates(env);
    // 跨组类型口径差异：Subscription.amount 是 number | null，CurrencySubscription.amount
    // 是 number | undefined；货币函数运行时只做数值读取，这里仅做类型桥接（同一数组引用）。
    const currencySubs = subscriptions as unknown as CurrencySubscription[];
    const monthlyExpense = calculateMonthlyExpense(currencySubs, timezone, rates);
    const yearlyExpense = calculateYearlyExpense(currencySubs, timezone, rates);
    const recentPayments = getRecentPayments(currencySubs, timezone);
    const upcomingRenewals = getUpcomingRenewals(currencySubs, timezone);
    const expenseByType = getExpenseByType(currencySubs, timezone, rates);
    const expenseByCategory = getExpenseByCategory(currencySubs, timezone, rates);

    const activeSubscriptions = subscriptions.filter((s) => s.isActive);
    const now = getCurrentTimeInTimezone(timezone);
    const sevenDaysLater = new Date(now.getTime() + 7 * MS_PER_DAY);
    const expiringSoon = activeSubscriptions.filter((s) => {
      const expiryDate = new Date(s.expiryDate);
      return expiryDate >= now && expiryDate <= sevenDaysLater;
    }).length;

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          monthlyExpense,
          yearlyExpense,
          activeSubscriptions: {
            active: activeSubscriptions.length,
            total: subscriptions.length,
            expiringSoon
          },
          recentPayments,
          upcomingRenewals,
          expenseByType,
          expenseByCategory,
          schedulerStatus,
          schedulerStatusHistory,
          /** 新增：用户时区（前端可据此显示） */
          timezone
        }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('获取仪表盘统计失败:', error);
    return new Response(
      JSON.stringify({
        success: false,
        message: '获取统计数据失败: ' + (error instanceof Error ? error.message : error)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export { handleDashboardStats };
