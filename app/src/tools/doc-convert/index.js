// 工具声明：文档格式转换
// 目标与范围见 spec/modules/doc-convert.md
import { mount, unmount } from './ui.js';

export default {
  id: 'doc-convert',
  name: '文档格式转换',
  icon: '📄',
  group: 'doc', // 左侧分组：文档
  order: 26,
  styles: ['../tools/doc-convert/styles.css'],
  mount,
  unmount
};
