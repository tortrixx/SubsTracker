// Wrangler text import 与 Node html-loader 的共同契约：
// 导入 .html 得到文件文本字符串。
declare module '*.html' {
  const content: string;
  export default content;
}
