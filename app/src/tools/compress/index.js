// 工具：图片压缩 —— 工具声明（见 spec/modules/image-compress.md）
import { mount, unmount } from './ui.js';

export default {
  id: 'compress',
  name: '图片压缩',
  icon: '🗜️',
  order: 30, // 图片混淆 10 / PDF 20 / 压缩 30 / 变清晰 35 / 格式转换 40 / 视频 60 / 动图 65
  styles: ['../tools/compress/styles.css'],
  mount,
  unmount
};