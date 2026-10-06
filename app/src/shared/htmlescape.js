// HTML 转义（共享能力）：把用户可控的值（输出目录、密钥、错误消息、文件名等）
// 安全地嵌进 innerHTML 模板。放在 shared/ 供 shell 与各工具复用，纯函数可单测。
// 注意：转义只防「值破坏 HTML 结构」；需要展示纯文本时优先 textContent（更简单直接）。
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
