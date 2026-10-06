// 工具声明：文字识别（OCR）
// 目标与范围：扫描版 PDF / 图片 → 可搜索 PDF、纯文本、Word；含扫描件增强与瘦身。
import { mount, unmount } from './ui.js';

export default {
  id: 'ocr',
  name: '文字识别',
  icon: '🔍',
  group: 'doc',   // 左侧分组：文档
  order: 24,
  styles: ['../tools/ocr/styles.css'],
  mount,
  unmount
};