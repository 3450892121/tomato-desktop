// 工具：图片压缩 —— 工具声明（见 spec/modules/image-compress.md）
import { mount, unmount } from './ui.js';

export default {
  id: 'compress',
  name: '图片压缩',
  icon: '🗜️',
  group: 'image', // 左侧分组：图片
  order: 30, // 组内排序：图片压缩 30 / 变清晰 35 / 格式转换 40
  styles: ['../tools/compress/styles.css'],
  mount,
  unmount
};