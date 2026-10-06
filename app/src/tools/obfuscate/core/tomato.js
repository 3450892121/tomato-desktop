// 空间曲线混淆 (番茄图 / gilbert)：Gilbert 曲线线性化 + 固定偏移循环移位
// 与网页版「小番茄图片混淆」及 pyscramble 的 tomato 算法一致；该模式不使用密钥。
import { gilbert2d } from './gilbert.js';
import { VARIANTS } from './variants.js';

const GOLDEN = (Math.sqrt(5) - 1) / 2; // 黄金分割比 0.6180339887498949

/**
 * @param {object} opts
 * @param {Uint8ClampedArray} opts.pixels RGBA 缓冲
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {'encrypt'|'decrypt'} opts.direction
 * @param {'trunc'|'floor'} [opts.rounding] Gilbert 曲线取整方式（见 variants.js）
 */
export function tomatoScramble({ pixels, width, height, direction, rounding = VARIANTS.gilbertRounding }) {
  const n = width * height;
  const positions = gilbert2d(width, height, rounding);
  if (positions.length !== n) {
    throw new Error(`Gilbert 曲线覆盖异常：访问 ${positions.length} 个点，应为 ${n} 个（${width}x${height}）`);
  }

  const offset = Math.round(GOLDEN * n) % n;
  const out = new Uint8ClampedArray(pixels.length);

  for (let c = 0; c < n; c++) {
    const srcIdx = positions[c] * 4;
    const dstIdx = positions[(c + offset) % n] * 4;
    if (direction === 'encrypt') {
      // 按偏移错位：positions[(c+offset)] 处写入 positions[c] 的像素
      out[dstIdx] = pixels[srcIdx];
      out[dstIdx + 1] = pixels[srcIdx + 1];
      out[dstIdx + 2] = pixels[srcIdx + 2];
      out[dstIdx + 3] = pixels[srcIdx + 3];
    } else {
      out[srcIdx] = pixels[dstIdx];
      out[srcIdx + 1] = pixels[dstIdx + 1];
      out[srcIdx + 2] = pixels[dstIdx + 2];
      out[srcIdx + 3] = pixels[dstIdx + 3];
    }
  }

  return { pixels: out, width, height };
}