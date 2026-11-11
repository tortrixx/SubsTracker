import { beforeEach, describe, expect, it } from 'vitest';
import app from '../../src/app.ts';
import { _resetMigrationCache } from '../../src/data/migrate.ts';

function makeStorage() {
  const data = new Map([
    ['schema_version', 'v3'],
    ['config', JSON.stringify({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'password', JWT_SECRET: 'test', TIMEZONE: 'UTC' })]
  ]);
  return {
    data, failRules: false,
    async get(key) { return data.get(key) ?? null; },
    async put(key, value) {
      if (this.failRules && key.startsWith('reminder_rules:')) throw new Error('injected storage failure');
      data.set(key, value);
    },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) { return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; }
  };
}

beforeEach(() => _resetMigrationCache());

describe('订阅与规则写入失败', () => {
  it('撤销删除不会覆盖同 ID 的损坏原始记录', async () => {
    const kv = makeStorage();
    const env = { SUBSCRIPTIONS_KV: kv };
    const login = await app.request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' }) }, env);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    kv.data.set('sub:silent', '{broken');
    const response = await app.request('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ mode: 'missing', backup: { subscriptions: [{ id: 'silent', name: '无提醒', expiryDate: '2027-01-01' }], reminderRules: { silent: [] } } }) }, env);
    expect(response.status).toBe(409);
    expect(kv.data.get('sub:silent')).toBe('{broken');
  });
  it('撤销删除时规则写入失败，不会恢复无规则键的订阅', async () => {
    const kv = makeStorage();
    const env = { SUBSCRIPTIONS_KV: kv };
    const login = await app.request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' }) }, env);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    kv.failRules = true;
    const response = await app.request('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ mode: 'missing', backup: { subscriptions: [{ id: 'silent', name: '无提醒', expiryDate: '2027-01-01' }], reminderRules: { silent: [] } } }) }, env);
    expect(response.status).toBe(500);
    expect(kv.data.has('sub:silent')).toBe(false);
  });
  it('创建时规则写入失败会返回错误并回滚订阅', async () => {
    const kv = makeStorage();
    const env = { SUBSCRIPTIONS_KV: kv };
    const login = await app.request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' }) }, env);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    kv.failRules = true;
    const response = await app.request('/api/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: '失败测试', expiryDate: '2027-01-01', reminderRules: [] }) }, env);
    expect(response.status).toBe(500);
    expect((await response.json()).message).toContain('未创建订阅');
    expect([...kv.data.keys()].filter((key) => key.startsWith('sub:'))).toEqual([]);
    expect(JSON.parse(kv.data.get('sub_index'))).toEqual([]);
  });

  it('编辑时规则写入失败明确提示信息已保存、规则未保存', async () => {
    const kv = makeStorage();
    const env = { SUBSCRIPTIONS_KV: kv };
    const login = await app.request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' }) }, env);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const created = await app.request('/api/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: '原名称', expiryDate: '2027-01-01', reminderRules: [] }) }, env);
    const sub = (await created.json()).subscription;
    kv.failRules = true;
    const response = await app.request(`/api/subscriptions/${sub.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ...sub, name: '新名称', reminderRules: [] }) }, env);
    expect(response.status).toBe(500);
    expect((await response.json()).message).toContain('订阅信息已保存，但提醒规则保存失败');
    expect(JSON.parse(kv.data.get(`sub:${sub.id}`)).name).toBe('新名称');
  });
});
