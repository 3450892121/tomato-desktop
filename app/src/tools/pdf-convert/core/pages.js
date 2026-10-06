// 页码范围解析（纯函数，便于单元测试）
// 约定：页码从 1 开始；空字符串 = 全部页（返回 null）。
// 支持格式："1-3,5"、"1～3，5"、"1 2 3"；越界：起点越界报错，终点越界自动截到最后一页。

/**
 * @param {string} text 页码范围文本
 * @param {number} [totalPages] 总页数（用于越界检查；不传则不检查）
 * @returns {number[]|null} 升序去重的页码数组；空文本返回 null（表示全部）
 */
export function parsePageRange(text, totalPages) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const pages = new Set();
  for (const part of raw.split(/[,，;；\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d+)\s*[-~～]\s*(\d+)$/) || part.match(/^(\d+)$/);
    if (!m) throw new Error(`页码范围格式不对：「${part}」（示例：1-3,5）`);
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    if (start < 1 || end < start) throw new Error(`页码范围不合法：「${part}」`);
    if (totalPages && start > totalPages) {
      throw new Error(`页码超出范围：「${part}」（该 PDF 共 ${totalPages} 页）`);
    }
    const last = totalPages ? Math.min(end, totalPages) : end;
    for (let p = start; p <= last; p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/** 把页码数组压缩成好看的范围文本："1-3,5" */
export function formatPageRange(pages) {
  if (!pages || pages.length === 0) return '';
  const sorted = [...pages].sort((a, b) => a - b);
  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = cur;
    prev = cur;
  }
  return parts.join(',');
}