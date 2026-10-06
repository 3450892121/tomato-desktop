// 三类 MD5 洗牌模式的像素重排实现：方块混淆(B) / 像素混淆(C) / 行像素混淆(C2)
// 方向语义：encrypt = 按映射取源像素写入目标（gather）；decrypt = 反向写回（scatter）。
// 具体规则与手机版一致，详见 spec/modules/engine.md。
import { shuffleWithKey } from './shuffle.js';
import { VARIANTS } from './variants.js';

const BLOCK_SIZE = 32;

/** 把小块像素从 src 拷到 dst（4 字节 RGBA） */
function copyPixel(src, srcIdx, dst, dstIdx) {
  dst[dstIdx] = src[srcIdx];
  dst[dstIdx + 1] = src[srcIdx + 1];
  dst[dstIdx + 2] = src[srcIdx + 2];
  dst[dstIdx + 3] = src[srcIdx + 3];
}

/**
 * 像素混淆 (C)：行、列各生成一条 MD5 错位表，做两级错位
 */
export function pixelScramble({ pixels, width, height, key, direction }) {
  const w = width;
  const h = height;
  const xArr = shuffleWithKey(w, key);
  const yArr = shuffleWithKey(h, key);
  const out = new Uint8ClampedArray(pixels.length);

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const m = xArr[(xArr[j % w] + i) % w];
      const n = yArr[(yArr[m % h] + j) % h];
      const idxA = (i + j * w) * 4; // (i, j)
      const idxB = (m + n * w) * 4; // (m, n)
      if (direction === 'encrypt') {
        copyPixel(pixels, idxB, out, idxA);
      } else {
        copyPixel(pixels, idxA, out, idxB);
      }
    }
  }
  return { pixels: out, width: w, height: h };
}

/**
 * 行像素混淆 (C2)：只在每一行内部横向错位
 */
export function rowPixelScramble({ pixels, width, height, key, direction }) {
  const w = width;
  const h = height;
  const xArr = shuffleWithKey(w, key);
  const out = new Uint8ClampedArray(pixels.length);

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const m = xArr[(xArr[j % w] + i) % w];
      const idxA = (i + j * w) * 4; // (i, j)
      const idxB = (m + j * w) * 4; // (m, j)
      if (direction === 'encrypt') {
        copyPixel(pixels, idxB, out, idxA);
      } else {
        copyPixel(pixels, idxA, out, idxB);
      }
    }
  }
  return { pixels: out, width: w, height: h };
}

/**
 * 方块混淆 (B)：先填充到 32 的整数倍（补透明黑，与手机版一致），再做 32×32 方块级 MD5 洗牌
 */
export function blockScramble({
  pixels,
  width,
  height,
  key,
  direction,
  blockSize = BLOCK_SIZE,
  variant = VARIANTS.blockVariant
}) {
  const xbc = blockSize;
  const ybc = blockSize;
  const padW = Math.ceil(width / xbc) * xbc;
  const padH = Math.ceil(height / ybc) * ybc;
  const blockW = padW / xbc;
  const blockH = padH / ybc;

  // 输入缓冲：尺寸不足时补透明黑（与手机版 Java 层 createBitmap + drawBitmap 行为一致）
  let src = pixels;
  if (padW !== width || padH !== height) {
    src = new Uint8ClampedArray(padW * padH * 4);
    for (let j = 0; j < height; j++) {
      src.set(pixels.subarray(j * width * 4, (j + 1) * width * 4), j * padW * 4);
    }
  }

  const xArr = shuffleWithKey(xbc, key);
  const yArr = shuffleWithKey(ybc, key);
  const out = new Uint8ClampedArray(padW * padH * 4);

  for (let j = 0; j < padH; j++) {
    for (let i = 0; i < padW; i++) {
      let m;
      let n;
      if (variant === 'js') {
        // 网页版 ImageMixer 的写法
        let r = j; // 行
        let o = i; // 列
        r = (xArr[((o / blockH) | 0) % xbc] * blockW + r) % padW;
        r = xArr[(r / blockW) | 0] * blockW + (r % blockW);
        o = (yArr[((r / blockW) | 0) % ybc] * blockH + o) % padH;
        o = yArr[(o / blockH) | 0] * blockH + (o % blockH);
        m = r;
        n = o;
      } else {
        // Python 参考实现 / pyscramble 的写法
        n = j;
        m = (xArr[((n / blockH) | 0) % xbc] * blockW + i) % padW;
        m = xArr[(m / blockW) | 0] * blockW + (m % blockW);
        n = (yArr[((m / blockW) | 0) % ybc] * blockH + n) % padH;
        n = yArr[(n / blockH) | 0] * blockH + (n % blockH);
      }
      const idxA = (i + j * padW) * 4;
      const idxB = (m + n * padW) * 4;
      if (direction === 'encrypt') {
        copyPixel(src, idxB, out, idxA);
      } else {
        copyPixel(src, idxA, out, idxB);
      }
    }
  }

  return { pixels: out, width: padW, height: padH };
}