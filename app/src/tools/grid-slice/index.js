// 工具：九宫格切图 —— 工具声明
// 目标：把一张图切成 3×3（或自定义 N×M）小块，用来发朋友圈 / 小红书的九宫格。
import { mount, unmount } from './ui.js';

export default {
  id: 'grid-slice',
  name: '九宫格切图',
  icon: '▦',
  group: 'image', // 左侧分组：图片
  order: 48, // 组内排序：图片压缩 30 / 变清晰 35 / 格式转换 40 / 加水印 44 / 九宫格切图 48
  styles: ['../tools/grid-slice/styles.css'],
  mount,
  unmount
};