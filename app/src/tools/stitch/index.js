// 工具：长图拼接 —— 工具声明
// 目标与范围：把列表里的多张图片按顺序拼成一张长图（竖拼 / 横拼）。
import { mount, unmount } from './ui.js';

export default {
  id: 'stitch',
  name: '长图拼接',
  icon: '🧩',
  group: 'image', // 左侧分组：图片
  order: 46, // 组内排序：图片混淆 10 / 压缩 30 / 变清晰 35 / 格式转换 40 / 长图拼接 46
  styles: ['../tools/stitch/styles.css'],
  mount,
  unmount
};