// 工具：文件藏图（把文件藏进图片 / 从图片里取出文件；与「图夹」网站、APP 双向互通）
// 规格见 spec/modules/imghide.md；核心逻辑在 core/（format 容器 / crypto 密码 / engine 引擎）。
import { mount, unmount, activate, deactivate } from './ui.js';

export default {
  id: 'imghide',
  name: '文件藏图',
  icon: '📎',
  group: 'image', // 左侧分组：image 图片 / video 视频 / doc 文档（见 shell/registry.js 的 GROUPS）
  order: 50,
  styles: ['../tools/imghide/styles.css'], // 相对 src/shell/index.html
  mount,
  unmount,
  activate,
  deactivate
};