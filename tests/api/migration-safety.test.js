// @ts-check
import { describe, expect, it, beforeEach } from 'vitest';
import app from '../../src/app.ts';
import worker from '../../src/index.ts';
import { _resetMigrationCache } from '../../src/data/migrate.ts';

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async put(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async list() { return { keys: [], list_complete: true }; }
  };
}

beforeEach(() => _resetMigrationCache());

describe('迁移失败时保护数据', () => {
  it('损坏的旧订阅数据保留原样，业务请求返回 503', async () => {
    const kv = storage({ subscriptions: '{invalid' });
    const res = await app.fetch(new Request('https://example.test/api/subscriptions', { method: 'POST', body: '{}' }), { SUBSCRIPTIONS_KV: kv });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('migration_failed');
    expect(kv.data.get('subscriptions')).toBe('{invalid');
    expect(kv.data.has('schema_version')).toBe(false);
    expect(kv.data.has('sub_index')).toBe(false);
  });

  it('迁移锁存在时，业务和定时任务均等待，避免读写半迁移数据', async () => {
    const kv = storage({ migration_lock: 'held' });
    const env = { SUBSCRIPTIONS_KV: kv };
    const res = await app.fetch(new Request('https://example.test/'), env);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('migration_in_progress');
    await expect(worker.scheduled({ cron: '0 * * * *' }, env, {})).rejects.toThrow('数据迁移进行中');
    expect([...kv.data.keys()]).toEqual(['migration_lock']);
  });
});
