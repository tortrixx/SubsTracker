#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const WRANGLER_TOML = path.join(ROOT, 'wrangler.toml');
const PROD_TITLE = 'SUBSCRIPTIONS_KV';
const PREVIEW_TITLE_CANDIDATES = ['SUBSCRIPTIONS_KV_PREVIEW', 'SUBSCRIPTIONS_KV_preview'];

function run(command) {
  return execSync(command, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function listNamespaces() {
  const output = run('npx wrangler kv namespace list')
    .replace(/^\s*Proxy environment variables detected\.[^\r\n]*\r?\n/, '');
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error('Wrangler 返回的 namespace 列表不是数组');
  return parsed;
}

function readWorkerName() {
  const content = fs.readFileSync(WRANGLER_TOML, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    if (/^\s*\[/.test(line)) break;

    const match = line.match(/^\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(?:#.*)?$/);
    if (match) return match[1] || match[2] || match[3];
  }

  return null;
}

function namespaceTitlesFor(title) {
  const workerName = readWorkerName();
  return workerName ? [title, `${workerName}-${title}`] : [title];
}

function findNamespace(namespaces, title) {
  const expectedTitles = namespaceTitlesFor(title);
  const matches = namespaces.filter(ns => expectedTitles.includes(ns.title));
  if (matches.length > 1) throw new Error(`存在多个匹配 ${title} 的 KV，请在 wrangler.toml 手动指定 ID`);
  return matches[0];
}

function ensureNamespace(title) {
  let namespaces = listNamespaces();
  // Wrangler 会用项目名作为 namespace title 前缀；只匹配当前项目，避免误用其他 Worker 的同名 binding。
  let found = findNamespace(namespaces, title);
  if (found && found.id) return found;

  console.log(`[setup-kv] Namespace ${title} 不存在，开始创建...`);
  run(`npx wrangler kv namespace create ${title}`);

  namespaces = listNamespaces();
  found = findNamespace(namespaces, title);
  if (!found || !found.id) {
    throw new Error(`创建失败：未找到 namespace ${title}`);
  }
  return found;
}

/** 只识别根级数组表；不理解的写法拒绝修改，避免替换用户的数据源。 */
function inspectBindings(content) {
  const lines = content.split(/\r?\n/);
  const headers = [];
  let inRoot = true;
  lines.forEach((line, index) => {
    if (/^\s*\[/.test(line)) inRoot = false;
    if (inRoot && /^\s*kv_namespaces\s*=/.test(line)) {
      throw new Error('不支持内联 kv_namespaces，请改用 [[kv_namespaces]] 后重试');
    }
    if (/^\s*\[/.test(line)) headers.push(index);
  });
  const targets = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i];
    if (!/^\s*\[\[\s*kv_namespaces\s*\]\]\s*(?:#.*)?$/.test(lines[start])) continue;
    const end = headers[i + 1] ?? lines.length;
    const fields = {};
    for (const line of lines.slice(start + 1, end)) {
      const key = line.match(/^\s*(binding|id|preview_id)\s*=/);
      if (!key) continue;
      const value = line.match(/^\s*(binding|id|preview_id)\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)')\s*(?:#.*)?$/);
      if (!value || Object.hasOwn(fields, key[1])) throw new Error(`KV 配置字段 ${key[1]} 无法安全解析`);
      fields[key[1]] = value[2] || value[3];
    }
    if (!fields.binding) throw new Error('KV 绑定缺少可识别的 binding，拒绝修改配置');
    if (fields.binding === 'SUBSCRIPTIONS_KV') targets.push({ start, end, ...fields });
  }
  if (targets.length > 1) throw new Error('发现多个 SUBSCRIPTIONS_KV 绑定，请先手动处理');
  return { lines, target: targets[0] || null };
}

function updateBindings(content, prodId, previewId) {
  const { lines, target } = inspectBindings(content);
  if (target) {
    if (target.id && target.id !== prodId) throw new Error('已有 KV ID 与待写入 ID 不一致，拒绝覆盖');
    if (target.preview_id && target.preview_id !== previewId) throw new Error('已有预览 KV ID 与待写入 ID 不一致，拒绝覆盖');
    const additions = [];
    if (!target.id) additions.push(`id = "${prodId}"`);
    if (!target.preview_id) additions.push(`preview_id = "${previewId}"`);
    lines.splice(target.end, 0, ...additions);
    return lines.join('\n');
  }
  // 必须插在首个 TOML 表之前，否则数组表可能属于后续环境配置。
  const firstHeader = lines.findIndex((line) => /^\s*\[/.test(line));
  const block = ['', '[[kv_namespaces]]', 'binding = "SUBSCRIPTIONS_KV"', `id = "${prodId}"`, `preview_id = "${previewId}"`, ''];
  lines.splice(firstHeader < 0 ? lines.length : firstHeader, 0, ...block);
  return lines.join('\n');
}

function main() {
  if (!fs.existsSync(WRANGLER_TOML)) {
    throw new Error('未找到 wrangler.toml，请在项目根目录执行');
  }

  const content = fs.readFileSync(WRANGLER_TOML, 'utf8');
  const existing = inspectBindings(content).target;
  const prod = existing?.id ? { id: existing.id } : ensureNamespace(PROD_TITLE);

  let preview = existing?.preview_id ? { id: existing.preview_id } : null;
  if (!preview) {
    const namespaces = listNamespaces();
    for (const name of PREVIEW_TITLE_CANDIDATES) {
      preview = findNamespace(namespaces, name);
      if (preview && preview.id) break;
    }
    if (!preview || !preview.id) preview = ensureNamespace('SUBSCRIPTIONS_KV_PREVIEW');
  }

  fs.writeFileSync(WRANGLER_TOML, updateBindings(content, prod.id, preview.id), 'utf8');

  console.log('[setup-kv] 完成 ✅');
  console.log(`[setup-kv] SUBSCRIPTIONS_KV: ${prod.id}`);
  console.log(`[setup-kv] SUBSCRIPTIONS_KV_PREVIEW: ${preview.id}`);
  console.log('[setup-kv] 已更新 wrangler.toml');
}

module.exports = { inspectBindings, updateBindings };
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[setup-kv] 失败:', error.message || error);
    process.exit(1);
  }
}
