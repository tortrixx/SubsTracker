import { MS_PER_DAY, getCurrentTimeInTimezone, getDaysBetween, getTimezoneDateParts } from './time.js';
import type { AppEnv } from '../platform/storage/storage-port.js';

/** 汇率表：币种代码 → 相对 CNY 的汇率 */
export type ExchangeRates = Record<string, number>;

/** currency 统计函数读取的支付记录形状（ data 层 Subscription 的结构子集） */
export interface CurrencyPayment {
  amount?: number;
  currency?: string;
  date: string;
  note?: string;
  [key: string]: unknown;
}

/** currency 统计函数读取的订阅形状（只依赖下列字段） */
export interface CurrencySubscription {
  name: string;
  currency?: string;
  customType?: string;
  category?: string;
  isActive?: boolean;
  expiryDate: string;
  amount?: number;
  paymentHistory?: CurrencyPayment[];
  [key: string]: unknown;
}

/** 月度支出统计结果 */
export interface MonthlyExpense {
  amount: number;
  trend: number;
  trendDirection: string;
}

/** 年度支出统计结果 */
export interface YearlyExpense {
  amount: number;
  monthlyAverage: number;
}

/** 最近支付条目（仪表盘用） */
export interface RecentPayment {
  name: string;
  amount: number;
  currency: string;
  customType?: string;
  paymentDate: string;
  note?: string;
}

/** 即将续费条目（仪表盘用） */
export interface UpcomingRenewal {
  name: string;
  amount: number;
  currency: string;
  customType?: string;
  renewalDate: string;
  daysUntilRenewal: number;
}


const CATEGORY_SEPARATOR_REGEX = /[\/，,\s]+/;

// 汇率配置 (以 CNY 为基准，当 API 不可用或缺少特定币种如 TWD 时使用)
const FALLBACK_RATES: ExchangeRates = {
  'CNY': 1,
  'USD': 6.98,
  'HKD': 0.90,
  'TWD': 0.22,
  'JPY': 0.044,
  'EUR': 8.16,
  'GBP': 9.40,
  'KRW': 0.0048,
  'TRY': 0.16
};

async function getDynamicRates(env: AppEnv): Promise<ExchangeRates> {
  const CACHE_KEY = 'SYSTEM_EXCHANGE_RATES';
  const CACHE_TTL = 86400000; // 24小时
  const FETCH_TIMEOUT_MS = 5000;

  let staleRates: ExchangeRates | null = null;
  try {
    const cached = (await env.SUBSCRIPTIONS_KV.get(CACHE_KEY, { type: 'json' })) as {
      ts?: number;
      rates?: ExchangeRates;
    } | null;
    if (cached && cached.rates && typeof cached.rates === 'object') {
      staleRates = cached.rates;
      if (cached.ts && (Date.now() - cached.ts < CACHE_TTL)) {
        return cached.rates;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.frankfurter.dev/v1/latest?base=CNY', {
        signal: controller.signal
      });
      if (response.ok) {
        const data = (await response.json()) as { rates?: ExchangeRates };
        const newRates = {
          ...FALLBACK_RATES,
          ...data.rates,
          'CNY': 1
        };

        await env.SUBSCRIPTIONS_KV.put(CACHE_KEY, JSON.stringify({
          ts: Date.now(),
          rates: newRates
        }));

        return newRates;
      } else {
        console.warn('[汇率] API 请求失败，使用缓存/兜底汇率');
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error('[汇率] 获取过程出错:', error);
  }
  return staleRates || FALLBACK_RATES;
}

function parseValidDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function convertToCNY(amount: number, currency: string | undefined, rates: ExchangeRates): number {
  if (!amount || amount <= 0) return 0;
  const code = currency || 'CNY';
  if (code === 'CNY') return amount;
  const rate = rates[code];
  if (!rate) return amount;
  return amount / rate;
}

function calculateMonthlyExpense(subscriptions: CurrencySubscription[], timezone: string, rates: ExchangeRates): MonthlyExpense {
  const now = getCurrentTimeInTimezone(timezone);
  const parts = getTimezoneDateParts(now, timezone);
  const currentYear = parts.year;
  const currentMonth = parts.month;
  const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;

  let amount = 0;
  let lastMonthAmount = 0;
  subscriptions.forEach(sub => {
    const paymentHistory = sub.paymentHistory || [];
    paymentHistory.forEach(payment => {
      if (!payment.amount || payment.amount <= 0) return;
      const paymentDate = parseValidDate(payment.date);
      if (!paymentDate) return;
      const paymentParts = getTimezoneDateParts(paymentDate, timezone);
      const paymentCurrency = payment.currency || sub.currency || 'CNY';
      if (paymentParts.year === currentYear && paymentParts.month === currentMonth) {
        amount += convertToCNY(payment.amount, paymentCurrency, rates);
      } else if (paymentParts.year === lastMonthYear && paymentParts.month === lastMonth) {
        lastMonthAmount += convertToCNY(payment.amount, paymentCurrency, rates);
      }
    });
  });

  let trend = 0;
  let trendDirection = 'flat';
  if (lastMonthAmount > 0) {
    trend = Math.round(((amount - lastMonthAmount) / lastMonthAmount) * 100);
    if (trend > 0) trendDirection = 'up';
    else if (trend < 0) trendDirection = 'down';
  } else if (amount > 0) {
    trend = 100;
    trendDirection = 'up';
  }
  return { amount, trend: Math.abs(trend), trendDirection };
}

function calculateYearlyExpense(subscriptions: CurrencySubscription[], timezone: string, rates: ExchangeRates): YearlyExpense {
  const now = getCurrentTimeInTimezone(timezone);
  const parts = getTimezoneDateParts(now, timezone);
  const currentYear = parts.year;

  let amount = 0;
  subscriptions.forEach(sub => {
    const paymentHistory = sub.paymentHistory || [];
    paymentHistory.forEach(payment => {
      if (!payment.amount || payment.amount <= 0) return;
      const paymentDate = parseValidDate(payment.date);
      if (!paymentDate) return;
      const paymentParts = getTimezoneDateParts(paymentDate, timezone);
      if (paymentParts.year === currentYear) {
        amount += convertToCNY(payment.amount, payment.currency || sub.currency || 'CNY', rates);
      }
    });
  });

  const monthlyAverage = amount / parts.month;
  return { amount, monthlyAverage };
}

function getRecentPayments(subscriptions: CurrencySubscription[], timezone: string): RecentPayment[] {
  const now = getCurrentTimeInTimezone(timezone);
  const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
  const recentPayments: RecentPayment[] = [];
  subscriptions.forEach(sub => {
    const paymentHistory = sub.paymentHistory || [];
    paymentHistory.forEach(payment => {
      if (!payment.amount || payment.amount <= 0) return;
      const paymentDate = parseValidDate(payment.date);
      if (!paymentDate) return;
      if (paymentDate >= sevenDaysAgo && paymentDate <= now) {
        recentPayments.push({
          name: sub.name,
          amount: payment.amount,
          currency: payment.currency || sub.currency || 'CNY',
          customType: sub.customType,
          paymentDate: payment.date,
          note: payment.note
        });
      }
    });
  });
  return recentPayments.sort((a, b) => new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime());
}

function getUpcomingRenewals(subscriptions: CurrencySubscription[], timezone: string): UpcomingRenewal[] {
  const now = getCurrentTimeInTimezone(timezone);
  return subscriptions
    .filter(sub => sub.isActive)
    .map(sub => {
      const daysUntilRenewal = getDaysBetween(now, sub.expiryDate, timezone);
      return { sub, daysUntilRenewal };
    })
    .filter(({ daysUntilRenewal }) => daysUntilRenewal >= 0 && daysUntilRenewal <= 7)
    .map(({ sub, daysUntilRenewal }) => ({
      name: sub.name,
      amount: sub.amount || 0,
      currency: sub.currency || 'CNY',
      customType: sub.customType,
      renewalDate: sub.expiryDate,
      daysUntilRenewal
    }))
    .sort((a, b) => a.daysUntilRenewal - b.daysUntilRenewal);
}

function getExpenseByType(subscriptions: CurrencySubscription[], timezone: string, rates: ExchangeRates): Array<{ type: string; amount: number; percentage: number }> {
  const now = getCurrentTimeInTimezone(timezone);
  const parts = getTimezoneDateParts(now, timezone);
  const currentYear = parts.year;
  const typeMap: Record<string, number> = {};
  let total = 0;
  subscriptions.forEach(sub => {
    const paymentHistory = sub.paymentHistory || [];
    paymentHistory.forEach(payment => {
      if (!payment.amount || payment.amount <= 0) return;
      const paymentDate = parseValidDate(payment.date);
      if (!paymentDate) return;
      const paymentParts = getTimezoneDateParts(paymentDate, timezone);
      if (paymentParts.year === currentYear) {
        const type = sub.customType || '未分类';
        const amountCNY = convertToCNY(payment.amount, payment.currency || sub.currency || 'CNY', rates);
        typeMap[type] = (typeMap[type] || 0) + amountCNY;
        total += amountCNY;
      }
    });
  });

  return Object.entries(typeMap)
    .map(([type, amount]) => ({
      type,
      amount,
      percentage: total > 0 ? Math.round((amount / total) * 100) : 0
    }))
    .sort((a, b) => b.amount - a.amount);
}

function getExpenseByCategory(subscriptions: CurrencySubscription[], timezone: string, rates: ExchangeRates): Array<{ category: string; amount: number; percentage: number }> {
  const now = getCurrentTimeInTimezone(timezone);
  const parts = getTimezoneDateParts(now, timezone);
  const currentYear = parts.year;

  const categoryMap: Record<string, number> = {};
  let total = 0;
  subscriptions.forEach(sub => {
    const paymentHistory = sub.paymentHistory || [];
    paymentHistory.forEach(payment => {
      if (!payment.amount || payment.amount <= 0) return;
      const paymentDate = parseValidDate(payment.date);
      if (!paymentDate) return;
      const paymentParts = getTimezoneDateParts(paymentDate, timezone);
      if (paymentParts.year === currentYear) {
        const categories = sub.category ? sub.category.split(CATEGORY_SEPARATOR_REGEX).filter(c => c.trim()) : ['未分类'];
        const amountCNY = convertToCNY(payment.amount, payment.currency || sub.currency || 'CNY', rates);

        categories.forEach(category => {
          const cat = category.trim() || '未分类';
          categoryMap[cat] = (categoryMap[cat] || 0) + amountCNY / categories.length;
        });
        total += amountCNY;
      }
    });
  });

  return Object.entries(categoryMap)
    .map(([category, amount]) => ({
      category,
      amount,
      percentage: total > 0 ? Math.round((amount / total) * 100) : 0
    }))
    .sort((a, b) => b.amount - a.amount);
}

export {
  FALLBACK_RATES,
  getDynamicRates,
  convertToCNY,
  calculateMonthlyExpense,
  calculateYearlyExpense,
  getRecentPayments,
  getUpcomingRenewals,
  getExpenseByType,
  getExpenseByCategory
};
