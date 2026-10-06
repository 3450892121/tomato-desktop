// 工具声明：批量重命名
import { mount, unmount } from './ui.js';

export default {
  id: 'batch-rename',
  name: '批量重命名',
  icon: '🏷️',
  group: 'image', // 左侧分组：图片
  order: 42,
  styles: ['../tools/batch-rename/styles.css'],
  mount,
  unmount
};
