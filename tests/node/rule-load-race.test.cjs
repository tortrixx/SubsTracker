const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const page = readFileSync(path.join(__dirname, '../../src/views/adminPage.html'), 'utf8');
const source = page.match(/    async function loadRulesFor\(subId\) \{[\s\S]*?(?=\n    function fillFormFromSub)/);
if (!source) throw new Error('未找到提醒规则加载函数');

function harness() {
  const pending = new Map();
  const context = vm.createContext({
    pending,
    apiJson(url) { return new Promise((resolve, reject) => pending.set(url, { resolve, reject })); },
    renderRules() {}, refreshDirtyDot() {}, normalizeRuleClient(rule) { return rule; },
    $() { return { hidden: false }; }
  });
  vm.runInContext(`let rulesRequestId = 0, rulesState, rulesBaseline, formSnapshot;
    let fieldsSnapshot = '{"name":"原始名称"}';
    const drawerCtx = { rulesSourceId: null };
    ${source[0]}
    globalThis.begin = (id) => { drawerCtx.rulesSourceId = id; return loadRulesFor(id); };
    globalThis.close = () => { ++rulesRequestId; };
    globalThis.state = () => ({ rulesState, rulesBaseline, formSnapshot });`, context);
  return context;
}

test('后发请求先返回时，旧请求不会覆盖当前订阅规则', async () => {
  const ctx = harness();
  const first = ctx.begin('A');
  const second = ctx.begin('B');
  ctx.pending.get('/api/subscriptions/B/reminders').resolve({ rules: [{ id: 'B-rule' }] });
  await second;
  ctx.pending.get('/api/subscriptions/A/reminders').resolve({ rules: [{ id: 'A-rule' }] });
  await first;
  assert.equal(ctx.state().rulesState.model[0].id, 'B-rule');
  assert.equal(ctx.state().rulesBaseline[0].id, 'B-rule');
});

test('关闭后的旧请求失败不会污染下次表单', async () => {
  const ctx = harness();
  const first = ctx.begin('A');
  ctx.close();
  const second = ctx.begin('B');
  ctx.pending.get('/api/subscriptions/A/reminders').reject(new Error('late failure'));
  await first;
  assert.equal(ctx.state().rulesState.status, 'loading');
  ctx.pending.get('/api/subscriptions/B/reminders').resolve({ rules: [] });
  await second;
  assert.equal(ctx.state().rulesState.status, 'ready');
});

test('规则加载完成后仍保留打开时的字段基线', async () => {
  const ctx = harness();
  const request = ctx.begin('A');
  ctx.pending.get('/api/subscriptions/A/reminders').resolve({ rules: [{ id: 'r1' }] });
  await request;
  assert.equal(ctx.state().formSnapshot, '{"name":"原始名称"}|[{"id":"r1"}]|ready');
});
