// 兼容PE 模式实现：行模式 (PE1) 与 行+列 (PE2)
// 规则依据生态参考实现（网页版 JS 与 Python 实现一致），PE2 的先后顺序与 PicEncrypt 原版一致。
// 方向：encrypt = 混淆；decrypt = 解混淆。
import { logisticPositions, advanceSeed } from './logistic.js';
import { VARIANTS } from './variants.js';

function copyPixel(src, srcIdx, dst, dstIdx) {
  dst[dstIdx] = src[srcIdx];
  dst[dstIdx + 1] = src[srcIdx + 1];
  dst[dstIdx + 2] = src[srcIdx + 2];
  dst[dstIdx + 3] = src[srcIdx + 3];
}

/**
 * 兼容PE: 行模式 (PE1)：生成每行的错位表后逐行横向重排
 * chaining='single' 全图共用一条序列；'chained' 每行用上一行序列的最后一个值作初值
 */
export function rowLogistic({ pixels, width, height, key, direction, chaining = VARIANTS.pe1Chaining }) {
  const w = width;
  const h = height;

  const tables = new Array(h);
  let seed = key;
  for (let j = 0; j < h; j++) {
    tables[j] = logisticPositions(seed, w);
    if (chaining === 'chained') seed = advanceSeed(seed, w);
  }

  const out = new Uint8ClampedArray(pixels.length);
  for (let j = 0; j < h; j++) {
    const pos = tables[j];
    for (let i = 0; i < w; i++) {
      const idxA = (i + j * w) * 4;
      const idxB = (pos[i] + j * w) * 4;
      if (direction === 'encrypt') {
        copyPixel(pixels, idxB, out, idxA); // dst[i,j] = src[pos[i], j]
      } else {
        copyPixel(pixels, idxA, out, idxB); // dst[pos[i], j] = src[i, j]
      }
    }
  }
  return { pixels: out, width: w, height: h };
}

/**
 * 兼容PE: 行+列 (PE2)：行、列分别链式生成错位表；加密先行后列，解密先列后行
 */
export function rowColumnLogistic({ pixels, width, height, key, direction }) {
  const w = width;
  const h = height;

  // 行错位表（初值按行链式推进）
  const rowTables = new Array(h);
  let seed = key;
  for (let j = 0; j < h; j++) {
    rowTables[j] = logisticPositions(seed, w);
    seed = advanceSeed(seed, w);
  }

  // 列错位表（初值按列链式推进）
  const colTables = new Array(w);
  seed = key;
  for (let i = 0; i < w; i++) {
    colTables[i] = logisticPositions(seed, h);
    seed = advanceSeed(seed, h);
  }

  /** 行方向：encrypt: dst[i,j]=src[pos[i],j]；decrypt: dst[pos[i],j]=src[i,j] */
  function rowPass(src, dir) {
    const buf = new Uint8ClampedArray(src.length);
    for (let j = 0; j < h; j++) {
      const pos = rowTables[j];
      for (let i = 0; i < w; i++) {
        const idxA = (i + j * w) * 4;
        const idxB = (pos[i] + j * w) * 4;
        if (dir === 'encrypt') copyPixel(src, idxB, buf, idxA);
        else copyPixel(src, idxA, buf, idxB);
      }
    }
    return buf;
  }

  /** 列方向：encrypt: dst[i,j]=src[i,pos[j]]；decrypt: dst[i,pos[j]]=src[i,j] */
  function colPass(src, dir) {
    const buf = new Uint8ClampedArray(src.length);
    for (let j = 0; j < h; j++) {
      const pos = colTables; // 每列一张表：pos[row]
      for (let i = 0; i < w; i++) {
        const idxA = (i + j * w) * 4;
        const table = pos[i];
        const idxB = (i + table[j] * w) * 4;
        if (dir === 'encrypt') copyPixel(src, idxB, buf, idxA);
        else copyPixel(src, idxA, buf, idxB);
      }
    }
    return buf;
  }

  if (direction === 'encrypt') {
    const t1 = rowPass(pixels, 'encrypt');
    return { pixels: colPass(t1, 'encrypt'), width: w, height: h };
  }
  const t1 = colPass(pixels, 'decrypt');
  return { pixels: rowPass(t1, 'decrypt'), width: w, height: h };
}