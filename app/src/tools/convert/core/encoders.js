// 工具：图片格式转换 —— 自研编码器（BMP / ICO）
// 为什么自研：内核（OffscreenCanvas）只能编码 PNG/JPG/WebP，BMP 与 ICO 需要自己拼容器结构。
// BMP：32 位 BGRA + BITMAPV4HEADER + BI_BITFIELDS（含 alpha 掩码），自下而上行序，
//      结构依据 Microsoft Windows 文档（BITMAPFILEHEADER / BITMAPV4HEADER / BITFIELDS）。
// ICO：ICONDIR + ICONDIRENTRY 列表 + 各尺寸 PNG 数据（Windows Vista 起支持 PNG 压缩的图标项）。
// 本文件是纯函数，可在 node 里直接单测字节结构。

/** BMP 文件头长度（BITMAPFILEHEADER = 14 字节） */
const BMP_FILE_HEADER_SIZE = 14;
/** BITMAPV4HEADER 长度（固定 108 字节） */
const BMP_V4_HEADER_SIZE = 108;
/** 像素数据偏移 = 14 + 108 = 122 */
const BMP_PIXELS_OFFSET = BMP_FILE_HEADER_SIZE + BMP_V4_HEADER_SIZE;
/** 标准图标尺寸集（不超过原图时取用；至少取 1 个） */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/**
 * 编码 32 位 BGRA BMP（保留透明通道）
 * @param {Uint8ClampedArray|Uint8Array} pixels RGBA 像素
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} 完整 BMP 文件字节
 */
export function encodeBmp(pixels, width, height) {
  if (!(width > 0) || !(height > 0)) throw new Error('BMP 尺寸无效');
  const rowBytes = width * 4;               // 32 位像素无需行尾补齐
  const imageSize = rowBytes * height;
  const buf = new Uint8Array(BMP_PIXELS_OFFSET + imageSize);
  const view = new DataView(buf.buffer);

  // —— BITMAPFILEHEADER（14 字节） ——
  buf[0] = 0x42; // 'B'
  buf[1] = 0x4d; // 'M'
  view.setUint32(2, buf.length, true);            // 整个文件大小
  view.setUint32(6, 0, true);                     // 保留
  view.setUint32(10, BMP_PIXELS_OFFSET, true);    // 像素数据偏移

  // —— BITMAPV4HEADER（108 字节） ——
  let p = BMP_FILE_HEADER_SIZE;
  view.setUint32(p, BMP_V4_HEADER_SIZE, true); p += 4;
  view.setInt32(p, width, true); p += 4;
  view.setInt32(p, height, true); p += 4;         // 正数 = 自下而上（BMP 惯例）
  view.setUint16(p, 1, true); p += 2;             // 色彩平面
  view.setUint16(p, 32, true); p += 2;            // 位深
  view.setUint32(p, 3, true); p += 4;             // BI_BITFIELDS
  view.setUint32(p, imageSize, true); p += 4;     // 像素数据大小
  view.setInt32(p, 2835, true); p += 4;           // X 像素/米 ≈ 72 DPI
  view.setInt32(p, 2835, true); p += 4;           // Y 像素/米
  view.setUint32(p, 0, true); p += 4;             // 调色板颜色数（无）
  view.setUint32(p, 0, true); p += 4;             // 重要颜色数（全部）
  view.setUint32(p, 0x00ff0000, true); p += 4;    // 红掩码
  view.setUint32(p, 0x0000ff00, true); p += 4;    // 绿掩码
  view.setUint32(p, 0x000000ff, true); p += 4;    // 蓝掩码
  view.setUint32(p, 0xff000000, true); p += 4;    // alpha 掩码
  view.setUint32(p, 0x73524742, true); p += 4;    // CSType = 'BGRs'（sRGB）
  // 余下 36 字节端点 + 12 字节 gamma 保持 0（DataView 初始化即 0），p 走到 122 正好接像素

  // —— 像素数据（BGRA，自下而上） ——
  for (let y = 0; y < height; y += 1) {
    const srcRow = (height - 1 - y) * rowBytes;
    const dstRow = BMP_PIXELS_OFFSET + y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      buf[d] = pixels[s + 2];      // B
      buf[d + 1] = pixels[s + 1];  // G
      buf[d + 2] = pixels[s];      // R
      buf[d + 3] = pixels[s + 3];  // A
    }
  }
  return buf;
}

/**
 * 从原始尺寸挑出可用的图标尺寸（不超过原图最长边；一个都没有时退化为原图边长，上限 16）
 * @param {number} width
 * @param {number} height
 * @returns {number[]} 升序尺寸列表
 */
export function pickIcoSizes(width, height) {
  const maxSide = Math.max(Number(width) || 0, Number(height) || 0);
  const sizes = ICO_SIZES.filter((size) => size <= maxSide);
  if (sizes.length > 0) return sizes;
  return [Math.max(1, Math.min(ICO_SIZES[0], maxSide || ICO_SIZES[0]))];
}

/**
 * 封装 ICO 文件（每个尺寸一项，项内数据为 PNG）
 * @param {Array<{width: number, height: number, bytes: Uint8Array}>} pngList 各尺寸的 PNG 字节
 * @returns {Uint8Array} 完整 ICO 文件字节
 */
export function encodeIco(pngList) {
  if (!Array.isArray(pngList) || pngList.length === 0) throw new Error('ICO 至少需要 1 个尺寸的图片');
  const count = pngList.length;
  const dirSize = 6 + count * 16;

  let total = dirSize;
  for (const item of pngList) total += item.bytes.byteLength;

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  // —— ICONDIR（6 字节） ——
  view.setUint16(0, 0, true);        // 保留，必须为 0
  view.setUint16(2, 1, true);        // 类型：1 = 图标
  view.setUint16(4, count, true);    // 图像数量

  // —— ICONDIRENTRY（每个 16 字节）+ PNG 数据 ——
  let offset = dirSize;
  pngList.forEach((item, i) => {
    const p = 6 + i * 16;
    buf[p] = item.width >= 256 ? 0 : item.width & 0xff;    // 256 记为 0（ICO 约定）
    buf[p + 1] = item.height >= 256 ? 0 : item.height & 0xff;
    buf[p + 2] = 0;                    // 颜色数（真彩色为 0）
    buf[p + 3] = 0;                    // 保留
    view.setUint16(p + 4, 1, true);    // 色彩平面
    view.setUint16(p + 6, 32, true);   // 位深
    view.setUint32(p + 8, item.bytes.byteLength, true);
    view.setUint32(p + 12, offset, true);
    buf.set(item.bytes, offset);
    offset += item.bytes.byteLength;
  });

  return buf;
}