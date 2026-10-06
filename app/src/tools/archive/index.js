// 工具声明：文件压缩与解压
// 规格见 spec/modules/archive.md；核心逻辑在 core/（formats / params / plan / engine）。
import { mount, unmount, activate, deactivate } from './ui.js';

export default {
  id: 'archive',
  name: '压缩与解压',
  icon: '🗜️',
  group: 'archive',
  order: 10,
  styles: ['../tools/archive/styles.css'],
  mount,
  unmount,
  activate,
  deactivate
};