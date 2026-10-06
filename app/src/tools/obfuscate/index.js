// 工具：图片混淆（与手机版「番茄图片混淆」保持一致）
// 本文件只做「声明」，界面与逻辑分别在 ui.js / core/ 里，样式在 styles.css。
import { mount, unmount } from './ui.js';

export default {
  id: 'obfuscate',
  name: '图片混淆',
  icon: '🍅',
  group: 'image', // 左侧分组：image 图片 / video 视频 / doc 文档（见 shell/registry.js 的 GROUPS）
  order: 10,
  styles: ['../tools/obfuscate/styles.css'], // 相对 src/shell/index.html
  mount,
  unmount
};