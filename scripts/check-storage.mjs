/**
 * StoragePort 契约检查：对每个适配器跑同一组断言。
 * 用法：npm run check:storage（先 build 再检查，对象是实际交付的 dist 产物）
 * 覆盖：put/get、json 读、覆盖写、delete、TTL 过期、list 前缀+分页游标。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStorage } from '../dist/platform/storage/memory-storage.js';
import { createSqliteStorage } from '../dist/platform/storage/sqlite-storage.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function contract(name, storage) {
  await storage.put('cfg', JSON.stringify({ a: 1 }));
  assert.equal(await storage.get('cfg'), '{"a":1}', `${name}: get string`);
  assert.deepEqual(await storage.get('cfg', { type: 'json' }), { a: 1 }, `${name}: get json`);
  assert.equal(await storage.get('missing'), null, `${name}: missing -> null`);

  await storage.put('cfg', 'v2');
  assert.equal(await storage.get('cfg'), 'v2', `${name}: overwrite`);

  await storage.put('ttl', 'x', { expirationTtl: 1 });
  assert.equal(await storage.get('ttl'), 'x', `${name}: ttl alive`);
  await sleep(1200);
  assert.equal(await storage.get('ttl'), null, `${name}: ttl expired`);

  await storage.put('gone', '1');
  await storage.delete('gone');
  assert.equal(await storage.get('gone'), null, `${name}: delete`);

  for (const k of ['log:b', 'log:a', 'log:c', 'other:x']) await storage.put(k, '1');
  const page1 = await storage.list({ prefix: 'log:', limit: 2 });
  assert.deepEqual(page1.keys.map((k) => k.name), ['log:a', 'log:b'], `${name}: list page1 sorted`);
  assert.equal(page1.list_complete, false, `${name}: list not complete`);
  const page2 = await storage.list({ prefix: 'log:', limit: 2, cursor: page1.cursor });
  assert.deepEqual(page2.keys.map((k) => k.name), ['log:c'], `${name}: list page2`);
  assert.equal(page2.list_complete, true, `${name}: list complete`);
  const expiredInList = await storage.list({ prefix: 'ttl' });
  assert.deepEqual(expiredInList.keys, [], `${name}: expired excluded from list`);

  console.log(`✓ ${name} 通过 StoragePort 契约`);
}

const dir = mkdtempSync(join(tmpdir(), 'substracker-storage-'));
try {
  await contract('memory', createMemoryStorage());
  const sqlite = createSqliteStorage({ path: join(dir, 'test.sqlite') });
  try {
    await contract('sqlite', sqlite);
  } finally {
    sqlite.close();
  }
  console.log('✓ sqlite close 正常');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('全部存储适配器契约检查通过');
