// 工具声明：PDF 编辑整理
// 定位：补齐「整理类」PDF 操作（压缩瘦身 / 文字水印 / 页码 / 页面旋转 / 页面重排 / 加密 / 解密），
//       与「PDF 转格式」互补——那边只管格式转换。核心逻辑在 core/ops.js（与界面解耦）。
import { mount, unmount } from './ui.js';

export default {
  id: 'pdf-edit',
  name: 'PDF 编辑整理',
  icon: '📝',
  group: 'doc', // 左侧分组：文档
  order: 22,
  styles: ['../tools/pdf-edit/styles.css'],
  mount,
  unmount
};