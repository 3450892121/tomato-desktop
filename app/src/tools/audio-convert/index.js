// 工具声明：音频格式转换
// 目标与范围见 spec/modules/audio-convert.md
import { mount, unmount } from './ui.js';

export default {
  id: 'audio-convert',
  name: '音频格式转换',
  icon: '🎵',
  group: 'audio', // 左侧分组：音频
  order: 70,
  styles: ['../tools/audio-convert/styles.css'],
  mount,
  unmount
};