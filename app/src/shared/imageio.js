// 图片读写（共享能力 —— 骨架，尚未实现）
// 放在 shared/ 的原因：未来「图片压缩」等工具也会用到同一套解码/编码能力。
// 目标与规则见 spec/modules/imageio.md：
//  - 解码：PNG / JPG / WebP / BMP 等（走系统内核的图片解码能力）
//  - 编码：gilbert → JPEG 画质 95；其余模式 → PNG 无损（由调用方传入格式与画质）
//  - 尺寸：方块模式填充到 32 的倍数（补黑/透明），不裁剪回原尺寸（由调用方决定）
//  - 大图保护：解码前检查像素总量，超限给出明确提示

/**
 * 解码图片为 RGBA 像素缓冲（骨架阶段未实现）
 * @param {ArrayBuffer|Uint8Array} bytes 图片文件字节
 * @returns {Promise<{pixels: Uint8ClampedArray, width: number, height: number}>}
 */
export async function decodeImage(bytes) {
  void bytes;
  throw new Error('图片解码尚未实现（骨架阶段）');
}

/**
 * 编码像素缓冲为图片文件字节（骨架阶段未实现）
 * @param {Uint8ClampedArray} pixels
 * @param {number} width
 * @param {number} height
 * @param {{format: 'png'|'jpg', quality?: number}} options
 * @returns {Promise<Uint8Array>}
 */
export async function encodeImage(pixels, width, height, options) {
  void pixels; void width; void height; void options;
  throw new Error('图片编码尚未实现（骨架阶段）');
}