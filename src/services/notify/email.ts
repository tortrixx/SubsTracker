/**
 * 邮件通知渠道（Resend API）
 *
 * 邮件样式：简洁排版风（参考 Craft 欢迎邮件的设计语言，针对订阅提醒重新设计）：
 * - 白底、单一墨色 #1F2225、无渐变/阴影，靠字阶、行高与细分隔线撑质感
 * - 每条订阅渲染成「名称 + 状态胶囊 + 字段明细表」，状态按紧迫程度分三色
 * - 全部样式内联 + 表格布局，<style> 只留 reset 与移动端规则，兼容 Gmail / Apple Mail / Outlook
 * 渲染数据优先取 payload.metadata.subscriptions（scheduler 传入的结构化原件），
 * 直接按结构排版；缺失时回退到把 reminder.js 生成的纯文本正文按空行切块解析
 * 回结构（parseContent），解析不出的块按普通段落兜底渲染，保证第三方 /api/notify
 * 与自定义消息等任意文本内容都可读。
 */
import { ok, fail, errorMessage, stripMarkdown } from './channel.js';
import type { Channel, ChannelMetadata } from './channel.js';
import type { AppConfig } from '../../data/config.js';
import { formatLocalDate, formatTimeInTimezone, formatTimezoneDisplay } from '../../core/time.js';
import { formatAmount } from '../../core/currency-format.js';
import { formatNotificationContent, formatMatchedReminderRule, formatLunarExpiryText } from './reminder.js';

const INK = '#1F2225';
const MUTED = '#8A8F94';
const HAIRLINE = '#E8E8E6';
const LINK = '#087FAA';
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;

/** 状态胶囊配色：即将到期=薄荷绿、今天到期=琥珀、已过期=红 */
const STATUS_TONES = {
  ok: { bg: '#E6FAF3', color: '#107655' },
  warn: { bg: '#FFF3D6', color: '#8A6100' },
  danger: { bg: '#FDECEA', color: '#B3261E' }
};

/** 渲染用的一行字段明细 */
interface RenderRow {
  key: string;
  value: string;
}

/** 渲染用的一条订阅（结构化数据与文本解析收敛到同一形状） */
interface RenderSubscription {
  name: string;
  status: string;
  rows: RenderRow[];
  notes: string[];
}

/** HTML 转义（含引号，供属性值使用） */
function safe(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c] || c));
}

/** 高度精确的空段落做间距（邮件客户端对 margin 支持不一致，与原模板一致用占位段落） */
function spacer(px: number): string {
  return `<p style="height:${px}px;line-height:${px}px;max-height:${px}px;margin:0;padding:0;font-size:1px;">&nbsp;</p>`;
}

/**
 * 把一行 "键: 值" 拆开（兼容全角冒号）。拆不开返回 null。
 */
function splitKv(line: string): { key: string; value: string } | null {
  const m = line.match(/^([^:：]{1,12})[:：]\s*(.+)$/);
  return m ? { key: m[1].trim(), value: m[2].trim() } : null;
}

/**
 * 把纯文本正文解析为结构：订阅块数组 + 元信息行（发送时间/时区）+ 兜底段落。
 * 正文格式由 reminder.js 的 formatNotificationContent 定义：块间空行分隔，
 * 订阅块首行是 "状态emoji 名称"，其余行是 "键: 值"。
 */
function parseContent(content: string): { subscriptions: RenderSubscription[]; paragraphs: string[]; meta: string[] } {
  const text = stripMarkdown(String(content || '')).replace(/\r\n/g, '\n').trim();
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const subscriptions: RenderSubscription[] = [];
  const paragraphs: string[] = [];
  const meta: string[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    if (/^发送时间[:：]/.test(lines[0])) {
      meta.push(...lines);
      continue;
    }

    const bodyLines = lines.slice(1).map(splitKv);
    const kvCount = bodyLines.filter(Boolean).length;
    const isSubscription = kvCount >= 2; // 至少两行键值才认作订阅块，其余走兜底段落

    if (!isSubscription) {
      paragraphs.push(lines.join('\n'));
      continue;
    }

    // 首行形如 "📅 Netflix"：拆出状态 emoji 与名称（emoji 由状态胶囊替代，不再显示在标题里）
    const heading = lines[0].match(/^([^\p{L}\p{N}]+)\s+(.+)$/u);
    const name = heading ? heading[2].trim() : lines[0];

    const rows: RenderRow[] = [];
    let status = '';
    lines.slice(1).forEach((line, i) => {
      const kv = bodyLines[i];
      if (!kv) {
        rows.push({ key: '', value: line });
      } else if (kv.key === '到期状态') {
        status = kv.value; // 状态单独渲染成胶囊，不进明细表
      } else {
        rows.push(kv);
      }
    });

    subscriptions.push({ name, status, rows, notes: [] });
  }

  return { subscriptions, paragraphs, meta };
}

/**
 * 把 metadata 里的结构化订阅数组转成与 parseContent 相同的渲染结构
 * （名称/状态/明细行），字段与文案口径与 reminder.js 的纯文本格式保持一致，
 * 这样两种来源渲染出的邮件长得一样。metadata 缺失、为空或关键字段
 * （name / daysRemaining）不合法时返回 null，调用方回退文本解析。
 */
function structureSubscriptions(metadata: ChannelMetadata | undefined, timezone: string, showLunar: boolean): RenderSubscription[] | null {
  const list = metadata && Array.isArray(metadata.subscriptions) ? metadata.subscriptions : null;
  if (!list || list.length === 0) return null;

  const periodUnits: Record<string, string> = { day: '天', month: '月', year: '年' };
  const subscriptions: RenderSubscription[] = [];

  for (const s of list) {
    const days = Number(s && s.daysRemaining);
    if (!s || typeof s.name !== 'string' || !s.name || !Number.isFinite(days)) return null;

    const status = days < 0
      ? `已过期 ${Math.abs(days)} 天`
      : days === 0
        ? '今天到期！'
        : `将在 ${days} 天后到期`;

    const rows: RenderRow[] = [];
    const periodText = s.periodValue && s.periodUnit
      ? `(周期: ${s.periodValue} ${periodUnits[s.periodUnit] || s.periodUnit})`
      : '';
    rows.push({ key: '类型', value: `${s.customType || '其他'} ${periodText}`.trim() });
    rows.push({ key: '分类', value: s.category || '未分类' });
    const amountText = formatAmount(s.amount, s.currency || 'CNY');
    if (amountText) rows.push({ key: '金额', value: `${amountText}/周期` });
    rows.push({ key: '日历类型', value: s.useLunar ? '农历' : '公历' });
    rows.push({ key: '到期日期', value: formatTimeInTimezone(new Date(s.expiryDate), timezone, 'date') });
    if (showLunar) {
      const lunarText = formatLunarExpiryText(new Date(s.expiryDate), timezone);
      if (lunarText) rows.push({ key: '农历日期', value: lunarText.replace(/^\n农历日期:\s*/, '') });
    }
    rows.push({ key: '自动续期', value: s.autoRenew ? '是' : '否' });
    if (s.reminderText) rows.push({ key: '提醒策略', value: String(s.reminderText) });
    if (s.notes) rows.push({ key: '备注', value: String(s.notes) });

    subscriptions.push({ name: s.name, status, rows, notes: [] });
  }

  return subscriptions;
}

function statusTone(status: string) {
  if (status.includes('已过期')) return STATUS_TONES.danger;
  if (status.includes('今天')) return STATUS_TONES.warn;
  return STATUS_TONES.ok;
}

/**
 * 渲染一条订阅：名称 + 状态胶囊 + 字段明细表。
 */
function renderSubscription(sub: RenderSubscription, isFirst: boolean): string {
  const tone = statusTone(sub.status);
  const pill = sub.status
    ? `<span style="display:inline-block;background-color:${tone.bg};color:${tone.color};font-size:12px;font-weight:600;line-height:1;padding:5px 10px;border-radius:999px;white-space:nowrap;">${safe(sub.status)}</span>`
    : '';

  const rows = sub.rows
    .map((row, i) => {
      const border = i === sub.rows.length - 1 ? '' : `border-bottom:1px solid #F1F1EE;`;
      const valueHtml = row.key === '到期日期' ? `<strong style="font-weight:600;">${safe(row.value)}</strong>` : safe(row.value);
      if (!row.key) {
        return `<tr><td colspan="2" style="padding:8px 0;${border}color:${INK};font-size:15px;line-height:1.55;">${valueHtml}</td></tr>`;
      }
      return `<tr>
        <td style="width:88px;padding:8px 0;${border}color:${MUTED};font-size:13px;line-height:1.55;vertical-align:top;">${safe(row.key)}</td>
        <td style="padding:8px 0;${border}color:${INK};font-size:15px;line-height:1.55;vertical-align:top;">${valueHtml}</td>
      </tr>`;
    })
    .join('\n');

  return `${isFirst ? '' : `<p style="border-bottom:1px solid ${HAIRLINE};height:1px;line-height:1px;margin:0;padding:0;font-size:1px;">&nbsp;</p>${spacer(24)}`}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="color:${INK};font-size:18px;font-weight:600;line-height:1.4;padding:0;vertical-align:middle;">${safe(sub.name)}</td>
    <td align="right" style="padding:0 0 0 12px;vertical-align:middle;white-space:nowrap;">${pill}</td>
  </tr>
</table>
${spacer(6)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows}
</table>`;
}

export interface BuildHtmlExtras {
  /** metadata.subscriptions 存在时按结构化数据渲染 */
  metadata?: ChannelMetadata;
  /** appUrl 非空时在正文末尾渲染「打开订阅管理」回跳按钮 */
  appUrl?: string;
  showLunar?: boolean;
}

/**
 * 构造 HTML 模板。
 */
function buildHtml(title: string, content: string, timezone: string, extras: BuildHtmlExtras = {}): string {
  const tz = timezone || 'UTC';
  const structured = structureSubscriptions(extras.metadata, tz, extras.showLunar === true);
  const parsed = structured ? null : parseContent(content);
  const subscriptions = structured || (parsed ? parsed.subscriptions : []);
  const paragraphs = structured ? [] : (parsed ? parsed.paragraphs : []);
  const ts = formatLocalDate(new Date(), tz, 'datetime');
  const metaLines = structured
    ? [`发送时间: ${ts}`, `当前时区: ${formatTimezoneDisplay(tz)}`]
    : (parsed && parsed.meta.length > 0 ? parsed.meta : [`发送时间: ${ts}`]);

  const firstSub = subscriptions[0];
  // 动态标题本身已以最紧迫订阅开头时，preheader 直接用标题，避免名称重复
  const preheader = firstSub
    ? (title.startsWith(firstSub.name)
      ? title
      : `${title}：${firstSub.name}${firstSub.status ? ` — ${firstSub.status}` : ''}`)
    : title;

  const appUrl = typeof extras.appUrl === 'string' ? extras.appUrl.trim() : '';
  const ctaHtml = appUrl
    ? `${spacer(30)}<p style="margin:0;padding:0;text-align:center;"><a href="${safe(appUrl)}" style="display:inline-block;background-color:#107655;color:#ffffff;font-size:15px;font-weight:600;line-height:1;text-decoration:none;padding:13px 30px;border-radius:999px;">打开订阅管理</a></p>`
    : '';

  const intro = subscriptions.length > 0
    ? `<p style="color:#5F646A;display:block;font-size:15px;line-height:1.6;margin:0;padding:0;">以下订阅即将到期或已经过期，请及时处理续费或取消。</p>${spacer(20)}`
    : '';

  const subsHtml = subscriptions.map((sub, i) => renderSubscription(sub, i === 0)).join(`\n${spacer(26)}\n`);

  const paragraphsHtml = paragraphs
    .map((p) => `<p style="color:${INK};display:block;font-size:16px;line-height:1.7;margin:0;padding:0;">${safe(p).replace(/\n/g, '<br>')}</p>`)
    .join(`\n${spacer(14)}\n`);

  const bodyHtml = [subsHtml, paragraphsHtml].filter(Boolean).join(`\n${spacer(26)}\n`);

  return `<!DOCTYPE html>
<html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${safe(title)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings xmlns:o="urn:schemas-microsoft-com:office:office"><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  html, body { margin:0 !important; padding:0 !important; height:100% !important; width:100% !important; }
  * { -ms-text-size-adjust:100%; -webkit-text-size-adjust:100%; }
  table, td { mso-table-lspace:0pt !important; mso-table-rspace:0pt !important; }
  @media only screen and (max-width:680px) {
    .container { width:100% !important; max-width:100% !important; }
    .content-pad { padding-left:20px !important; padding-right:20px !important; }
    .title { font-size:22px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;word-spacing:normal;background-color:#ffffff;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${safe(preheader)}&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;</div>
<center>
<!--[if mso]><table role="presentation" width="640" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="container" align="center" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;margin:0 auto;background-color:#ffffff;font-family:${FONT};">
<tr>
<td class="content-pad" style="padding:36px 32px 28px 32px;vertical-align:top;">

  <p style="color:${MUTED};display:block;font-size:13px;font-weight:600;letter-spacing:1px;line-height:1.4;margin:0;padding:0;">📅 订阅管理</p>
  ${spacer(14)}
  <p class="title" style="color:${INK};display:block;font-size:24px;font-weight:700;line-height:1.25;margin:0;padding:0;">${safe(title)}</p>
  ${spacer(16)}
  ${intro}<p style="border-bottom:1px solid ${HAIRLINE};height:1px;line-height:1px;margin:0;padding:0;font-size:1px;">&nbsp;</p>
  ${spacer(24)}
  ${bodyHtml}
  ${ctaHtml}
  ${spacer(32)}
  <p style="border-bottom:1px solid ${HAIRLINE};height:1px;line-height:1px;margin:0;padding:0;font-size:1px;">&nbsp;</p>
  ${spacer(16)}
  <p style="color:${MUTED};display:block;font-size:13px;font-weight:300;line-height:1.6;margin:0;padding:0;text-align:center;">此邮件由订阅管理系统自动发送，请及时处理相关订阅事务。</p>
  <p style="color:${MUTED};display:block;font-size:13px;font-weight:300;line-height:1.6;margin:0;padding:0;text-align:center;">${metaLines.map((l) => safe(l)).join(' &nbsp;|&nbsp; ')}</p>

</td>
</tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</center>
</body>
</html>`;
}

export { buildHtml };

export const emailChannel: Channel = {
  name: 'email',

  validateConfig(config) {
    if (!config.RESEND_API_KEY) return { ok: false, error: '缺少 RESEND_API_KEY' };
    if (!config.EMAIL_FROM) return { ok: false, error: '缺少 EMAIL_FROM' };
    if (!config.EMAIL_TO) return { ok: false, error: '缺少 EMAIL_TO' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = emailChannel.validateConfig(config);
    if (!v.ok) return fail('email', v.error || '配置无效');

    const fromEmail = config.EMAIL_FROM_NAME
      ? `${config.EMAIL_FROM_NAME} <${config.EMAIL_FROM}>`
      : config.EMAIL_FROM;

    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: fromEmail,
          to: config.EMAIL_TO,
          subject: payload.title,
          html: buildHtml(payload.title, payload.content, config.TIMEZONE, {
            metadata: payload.metadata,
            appUrl: config.APP_URL,
            showLunar: config.SHOW_LUNAR === true
          }),
          text: stripMarkdown(payload.content)
        })
      });
      const result = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
      return r.ok && result && result.id
        ? ok('email', result)
        : fail('email', result?.message || `HTTP ${r.status}`, result);
    } catch (err) {
      return fail('email', errorMessage(err));
    }
  },

  async test(config) {
    // 发一组内置示例订阅（已过期 / 今天到期 / 即将到期各一条），走与正式
    // 提醒完全相同的结构化渲染路径，让用户在设置页就能预览邮件全貌。
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const samples = [
      {
        name: '示例 · Netflix', daysRemaining: -2,
        expiryDate: new Date(now - 2 * DAY_MS).toISOString(),
        amount: 93, currency: 'CNY', category: '影音', customType: '视频会员',
        periodValue: 1, periodUnit: 'month', autoRenew: true,
        rule: { type: 'after_expiry', value: 0, unit: 'days', repeatInterval: 24 }
      },
      {
        name: '示例 · iCloud', daysRemaining: 0,
        expiryDate: new Date(now).toISOString(),
        amount: 68, currency: 'CNY', category: '云服务', customType: '云存储',
        periodValue: 1, periodUnit: 'month', autoRenew: true,
        rule: { type: 'on_expiry', value: 0, unit: 'days' }
      },
      {
        name: '示例 · Spotify', daysRemaining: 3,
        expiryDate: new Date(now + 3 * DAY_MS).toISOString(),
        amount: 58, currency: 'CNY', category: '影音', customType: '音乐会员',
        periodValue: 1, periodUnit: 'month', autoRenew: false,
        rule: { type: 'before_expiry', value: 3, unit: 'days' }
      }
    ];

    const content = formatNotificationContent(
      samples.map((s) => ({ ...s, matchedReminderRule: s.rule })),
      config
    );

    return emailChannel.send(
      {
        title: '订阅管理 - 测试通知（示例数据）',
        content,
        metadata: {
          subscriptions: samples.map((s) => ({
            name: s.name,
            daysRemaining: s.daysRemaining,
            hoursRemaining: s.daysRemaining * 24,
            expiryDate: s.expiryDate,
            amount: s.amount,
            currency: s.currency,
            category: s.category,
            customType: s.customType,
            periodValue: s.periodValue,
            periodUnit: s.periodUnit,
            autoRenew: s.autoRenew,
            useLunar: false,
            notes: '',
            reminderText: formatMatchedReminderRule(s.rule)
          }))
        }
      },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendEmailNotification(title: string, content: string, config: AppConfig): Promise<boolean> {
  const r = await emailChannel.send({ title, content }, config);
  if (!r.success) console.error('[Email]', r.error);
  return r.success;
}
