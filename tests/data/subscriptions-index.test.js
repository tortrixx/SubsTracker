import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import * as repo from '../../src/data/subscriptions.repo.ts';

beforeEach(async () => {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((key) => env.SUBSCRIPTIONS_KV.delete(key.name)));
});

describe('订阅索引损坏时保护已有数据', () => {
  it.each(['{invalid', '{}', '["valid", 42]', ''])('索引无效时拒绝读写而不是当作空列表：%s', async (raw) => {
    const existing = JSON.stringify({ id: 'valid', name: '保留', expiryDate: '2026-12-01T00:00:00Z' });
    await env.SUBSCRIPTIONS_KV.put('sub_index', raw);
    await env.SUBSCRIPTIONS_KV.put('sub:valid', existing);
    await expect(repo.listIds(env)).rejects.toThrow('订阅索引数据无效');
    await expect(repo.save(env, { id: 'new', name: '新', expiryDate: '2026-12-01T00:00:00Z' })).rejects.toThrow('订阅索引数据无效');
    await expect(repo.saveMany(env, [{ id: 'valid', name: '覆盖' }])).rejects.toThrow('订阅索引数据无效');
    await expect(repo.deleteById(env, 'valid')).rejects.toThrow('订阅索引数据无效');
    expect(await env.SUBSCRIPTIONS_KV.get('sub_index')).toBe(raw);
    expect(await env.SUBSCRIPTIONS_KV.get('sub:valid')).toBe(existing);
    expect(await env.SUBSCRIPTIONS_KV.get('sub:new')).toBeNull();
  });

  it('缺失索引仍代表新环境的空列表', async () => {
    expect(await repo.listIds(env)).toEqual([]);
  });
});
