// 工具注册表 —— 全软件唯一的工具清单
// ★ 新增工具时，只需：① 复制 src/tools/_template/ 改名为新工具；② 在这里加两行（import + 数组）。
// 详见 docs/新增工具指南.md
import obfuscate from '../tools/obfuscate/index.js';

/** 所有工具（按 order 升序显示在左侧列表） */
export const TOOLS = [
  obfuscate
];