// MCP 工具结果的标准形状
// 约定：成功也返回结构化 JSON（content 里放一份可读文本，structuredContent 放原对象），
//       失败用 isError=true，但仍然是正常 JSON-RPC 响应（不抛协议错误）。
export function jsonResult(value) {
  const obj = value == null ? {} : value;
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj,
    isError: false
  };
}

export function errorResult(message, extra = {}) {
  const text = String(message || '工具执行失败');
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ok: false, message: text, ...extra },
    isError: true
  };
}
