// 工具声明：图片格式转换
// 目标与范围见 spec/modules/image-convert.md；接入方式见 src/tools/_template/
import { mount, unmount } from './ui.js';

export default {
  id: 'img-convert',
  name: '图片格式转换',
  icon: '🔄',
  group: 'image', // 左侧分组：图片
  order: 40,
  styles: ['../tools/convert/styles.css'],
  mount,
  unmount
};