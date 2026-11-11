const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const page = readFileSync(path.join(__dirname, '../../src/views/adminPage.html'), 'utf8');
const source = page.match(/    const renewCtx = \{[\s\S]*?(?=\n    \/\* ═══════════ 支付历史抽屉)/);
if (!source) throw new Error('未找到续期预览函数');

function harness() {
  const elements = Object.fromEntries(['renewAmount', 'renewPaymentDate', 'renewPeriodMultiplier', 'renewNote', 'renewPreviewBox', 'confirmRenewBtn', 'renewAlert']
    .map((id) => [id, { value: '', disabled: false, textContent: '', innerHTML: '' }]));
  elements.renewPaymentDate.value = '2026-06-01';
  elements.renewPeriodMultiplier.value = '1';
  const requests = [], renewals = [], timers = new Map();
  let nextTimer = 0;
  const ctx = vm.createContext({
    elements, requests, renewals, timers,
    $(id) { return elements[id]; },
    postJson(url, body) { return new Promise((resolve, reject) => requests.push({ url, body, resolve, reject })); },
    async doRenew(sub, options) { renewals.push({ sub, options }); },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    isValidDateStr(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value); },
    ST: { esc: String, fmtDateInTz: String, tz: () => 'UTC' },
    hideDrawer() {}, restoreFocus() {}
  });
  vm.runInContext(`${source[0]}
    renewCtx.sub = { id: 'sub-1' }; renewCtx.snapshot = {};
    globalThis.refresh = refreshRenewPreview;
    globalThis.schedule = scheduleRenewPreview;
    globalThis.confirm = confirmRenew;
    globalThis.state = () => renewCtx;`, ctx);
  ctx.runTimer = () => {
    const [id, fn] = [...timers.entries()].at(-1);
    timers.delete(id);
    return fn();
  };
  return ctx;
}

function preview(date) {
  return { success: true, preview: { newExpiryDate: date, newStartDate: 'start', paymentDate: 'payment' } };
}

test('旧预览晚返回时不会覆盖最新预览或重新启用确认', async () => {
  const ctx = harness();
  const first = ctx.refresh();
  ctx.elements.renewPeriodMultiplier.value = '2';
  ctx.schedule();
  assert.equal(ctx.elements.confirmRenewBtn.disabled, true);
  const second = ctx.runTimer();
  ctx.requests[1].resolve(preview('new'));
  await second;
  assert.match(ctx.elements.renewPreviewBox.innerHTML, /new/);
  ctx.requests[0].resolve(preview('old'));
  await first;
  assert.match(ctx.elements.renewPreviewBox.innerHTML, /new/);
  assert.equal(ctx.elements.confirmRenewBtn.disabled, false);
  assert.equal(JSON.parse(ctx.state().previewKey).periodMultiplier, 2);
});

test('输入变更为无效值时立即禁用确认且忽略在途响应', async () => {
  const ctx = harness();
  const first = ctx.refresh();
  ctx.elements.renewPaymentDate.value = '';
  ctx.schedule();
  assert.equal(ctx.elements.confirmRenewBtn.disabled, true);
  ctx.requests[0].resolve(preview('old'));
  await first;
  assert.equal(ctx.elements.confirmRenewBtn.disabled, true);
  await ctx.runTimer();
  assert.match(ctx.elements.renewPreviewBox.textContent, /请选择有效的支付日期/);
  await ctx.confirm();
  assert.equal(ctx.renewals.length, 0);
});

test('确认只接受与当前表单一致的成功预览', async () => {
  const ctx = harness();
  const first = ctx.refresh();
  ctx.requests[0].resolve(preview('first'));
  await first;
  ctx.elements.renewPeriodMultiplier.value = '3';
  await ctx.confirm();
  assert.equal(ctx.renewals.length, 0);
  ctx.schedule();
  const second = ctx.runTimer();
  ctx.requests[1].resolve(preview('second'));
  await second;
  await ctx.confirm();
  assert.equal(ctx.renewals.length, 1);
  assert.equal(ctx.renewals[0].options.periodMultiplier, 3);
});
