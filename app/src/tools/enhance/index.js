// 工具声明：图片变清晰
// 目标与范围见 spec/modules/image-enhance.md；接入方式见 src/tools/_template/
import { mount, unmount } from './ui.js';

export default {
  id: 'enhance',
  name: '图片变清晰',
  icon: '✨',
  group: 'image', // 左侧分组：图片
  order: 35,
  styles: ['../tools/enhance/styles.css'],
  mount,
  unmount
};