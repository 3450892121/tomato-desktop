// 【新工具模板】工具声明
// 用法：把整个 _template 文件夹复制为 src/tools/<你的工具标识>/，然后按 ★ 处修改。
import { mount, unmount, activate, deactivate } from './ui.js';

export default {
  id: 'example',        // ★ 唯一标识：英文小写（如 compress、pdf-convert）
  name: '示例工具',      // ★ 左侧列表显示名（给用户看的中文名）
  icon: '🧩',           // ★ 列表图标（emoji 即可）
  group: 'other',       // ★ 左侧分组：image（图片）/ video（视频）/ doc（文档）；未声明会归入「其它」
  order: 99,            // ★ 组内排序：数字小的排前面（图片混淆是 10）
  styles: ['../tools/example/styles.css'], // ★ 改成你自己的路径；没有样式文件就删掉这行
  mount,
  unmount,              // 页面被销毁时清理（可留空实现）
  activate,             // 可选：每次切回本工具时调用
  deactivate            // 可选：每次切走本工具时调用（全局快捷键/定时器要让位）
};