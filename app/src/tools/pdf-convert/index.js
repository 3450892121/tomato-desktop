// 工具声明：PDF 转格式
// 目标与范围见 spec/modules/pdf-convert.md；接入方式见 src/tools/_template/
import { mount, unmount } from './ui.js';

export default {
  id: 'pdf-convert',
  name: 'PDF 转格式',
  icon: '📄',
  group: 'doc', // 左侧分组：文档
  order: 20,
  styles: ['../tools/pdf-convert/styles.css'],
  mount,
  unmount
};