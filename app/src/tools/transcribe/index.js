// 工具声明：语音转文字
// 目标与范围见 spec/modules/transcribe.md
import { mount, unmount } from './ui.js';

export default {
  id: 'transcribe',
  name: '语音转文字',
  icon: '🎙️',
  group: 'audio', // 左侧分组：音频
  order: 75,
  styles: ['../tools/transcribe/styles.css'],
  mount,
  unmount
};