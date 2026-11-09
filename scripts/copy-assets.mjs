// 构建后处理：把运行时需要的非 TS 资源复制到 dist
// - src/views/*.html（pages.ts 以文本导入，Node 侧靠 dist 内的副本 + loader）
// - src/platform/node-html-loader.mjs（server.ts 注册的模块钩子）
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist', 'views'), { recursive: true });
mkdirSync(join(root, 'dist', 'platform'), { recursive: true });
cpSync(join(root, 'src', 'views'), join(root, 'dist', 'views'), {
  recursive: true,
  filter: (src) => src.endsWith('.html') || !src.includes('.')
});
cpSync(
  join(root, 'src', 'platform', 'node-html-loader.mjs'),
  join(root, 'dist', 'platform', 'node-html-loader.mjs')
);
console.log('[build] 资源已复制到 dist/');
