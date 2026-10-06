// 工具：加水印 —— 工具声明
import { mount, unmount } from './ui.js';

export default {
  id: 'watermark',
  name: '加水印',
  icon: '💧',
  group: 'image', // 左侧分组：图片
  order: 44, // 组内排序：图片压缩 30 / 变清晰 35 / 格式转换 40 / 加水印 44
  styles: ['../tools/watermark/styles.css'],
  mount,
  unmount
};
