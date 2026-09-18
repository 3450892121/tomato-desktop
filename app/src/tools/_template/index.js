// 【新工具模板】工具声明
// 用法：把整个 _template 文件夹复制为 src/tools/<你的工具标识>/，然后按 ★ 处修改。
import { mount, unmount } from './ui.js';

export default {
  id: 'example',        // ★ 唯一标识：英文小写（如 compress、pdf-convert）
  name: '示例工具',      // ★ 左侧列表显示名（给用户看的中文名）
  icon: '🧩',           // ★ 列表图标（emoji 即可）
  order: 99,            // ★ 排序：数字小的排前面（图片混淆是 10）
  styles: ['../tools/example/styles.css'], // ★ 改成你自己的路径；没有样式文件就删掉这行
  mount,
  unmount
};