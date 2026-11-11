const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectBindings, updateBindings } = require('./setup-kv.cjs');

test('保留现有生产和预览绑定及其他 KV 配置', () => {
  const input = `name = "app"\n\n[[kv_namespaces]]\nbinding = "OTHER"\nid = "other"\n\n[[kv_namespaces]]\nbinding = "SUBSCRIPTIONS_KV"\nid = "prod" # existing\npreview_id = "preview"\n\n[vars]\nMODE = "x"\n`;
  assert.equal(updateBindings(input, 'prod', 'preview'), input);
  assert.deepEqual({ id: inspectBindings(input).target.id, preview: inspectBindings(input).target.preview_id }, { id: 'prod', preview: 'preview' });
  assert.throws(() => updateBindings(input, 'different', 'preview'), /拒绝覆盖/);
});

test('仅向目标绑定补充缺失字段，保留其他表和注释', () => {
  const input = `name = "app"\n[[kv_namespaces]]\nbinding = "SUBSCRIPTIONS_KV"\nid = "prod"\n# 保留备注\n[vars]\nMODE = "x"\n`;
  const output = updateBindings(input, 'prod', 'preview');
  assert.match(output, /id = "prod"\n# 保留备注\npreview_id = "preview"\n\[vars\]/);
  assert.equal(inspectBindings(output).target.preview_id, 'preview');
});

test('新绑定放在根级，并保留环境级配置', () => {
  const input = `name = "app"\n[env.production]\nname = "prod"\n[[env.production.kv_namespaces]]\nbinding = "OTHER"\nid = "other"\n`;
  const output = updateBindings(input, 'prod', 'preview');
  assert.ok(output.indexOf('[[kv_namespaces]]') < output.indexOf('[env.production]'));
  assert.ok(output.includes('[[env.production.kv_namespaces]]\nbinding = "OTHER"\nid = "other"'));
});

test('不明确或重复的绑定拒绝修改', () => {
  assert.throws(() => inspectBindings('kv_namespaces = [{ binding = "OTHER" }]\n'), /内联/);
  assert.throws(() => inspectBindings('[[kv_namespaces]]\nbinding = "SUBSCRIPTIONS_KV"\n[[kv_namespaces]]\nbinding = "SUBSCRIPTIONS_KV"\n'), /多个/);
  assert.throws(() => inspectBindings('[[kv_namespaces]]\n"binding" = "SUBSCRIPTIONS_KV"\n'), /binding/);
});
