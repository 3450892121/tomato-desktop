// 工具声明：音频剪辑
// 目标与范围见 spec/modules/audio-edit.md
import { mount, unmount } from './ui.js';

export default {
  id: 'audio-edit',
  name: '音频剪辑',
  icon: '✂️',
  group: 'audio',   // 左侧分组：音频
  order: 72,
  styles: ['../tools/audio-edit/styles.css'],
  mount,
  unmount
};