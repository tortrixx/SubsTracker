// 对实际构建产物进行 Node HTTP 冒烟检查，使用临时 SQLite 与随机端口。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'substracker-http-'));
const child = spawn(process.execPath, ['dist/server.js'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', STORAGE_DRIVER: 'sqlite',
    SQLITE_PATH: join(dir, 'test.sqlite'), SCHEDULER_ENABLED: 'false' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Node 服务启动超时：${output}`)), 15000);
    const onData = () => {
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    child.stdout.on('data', onData);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Node 服务提前退出：${output}`)); });
    onData();
  });
  const base = `http://127.0.0.1:${port}`;
  const get = (path, options = {}) => fetch(base + path, { ...options, signal: AbortSignal.timeout(5000) });
  const health = await get('/healthz');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).storage, 'sqlite');
  const login = await get('/');
  assert.equal(login.status, 200);
  assert.match(await login.text(), /登录管理您的订阅提醒/);
  const asset = await get('/js/lib/api-client.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') || '', /javascript/);
  assert.match(await asset.text(), /api/i);
  const admin = await get('/admin', { redirect: 'manual' });
  assert.equal(admin.status, 302);
  console.log('✓ Node SQLite 服务、登录页、静态资源与未登录跳转正常');
} finally {
  child.kill('SIGTERM');
  await exited;
  rmSync(dir, { recursive: true, force: true });
}
