/**
 * Node 模块钩子：把 .html 导入转成文本模块。
 *
 * 背景：src/views/pages.js 用 `import pageHtml from './x.html'` 读取
 * 页面模板 —— 这是 Wrangler 的 text import 能力，Node 原生不支持。
 * 注册本钩子后，同一份视图代码在 Node 下无需改动即可运行，
 * 视图层从此与运行时解耦（Workers 用打包器、Node 用本钩子）。
 */
import { readFile } from 'node:fs/promises';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.html')) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.html')) {
    const text = await readFile(new URL(url), 'utf8');
    return {
      format: 'module',
      source: `export default ${JSON.stringify(text)};`,
      shortCircuit: true
    };
  }
  return nextLoad(url, context);
}
