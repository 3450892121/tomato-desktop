// 算法引擎：统一入口
// 目标与规则见 spec/modules/engine.md。纯像素重排：不改像素值，只改位置；正向混淆、反向解混淆。
import { tomatoScramble } from './tomato.js';
import { blockScramble, pixelScramble, rowPixelScramble } from './scramble_md5.js';
import { rowLogistic, rowColumnLogistic } from './scramble_logistic.js';
import { VARIANTS } from './variants.js';

/** 方块混淆的方块边长（与手机版一致：32×32） */
export const BLOCK_SIZE = 32;

/**
 * 处理像素（混淆 / 解混淆）
 * @param {object} opts
 * @param {string} opts.mode      模式标识：gilbert | b | c | c2 | pe1 | pe2
 * @param {string|number} [opts.key] 密钥（gilbert 不需要；b/c/c2 字符串；pe1/pe2 为 0~1 小数）
 * @param {'encrypt'|'decrypt'} opts.direction 方向
 * @param {number} opts.width     宽（像素）
 * @param {number} opts.height    高（像素）
 * @param {Uint8ClampedArray} opts.pixels RGBA 缓冲（长度 = width*height*4）
 * @param {object} [opts.variants] 兼容性变体（见 variants.js，默认用当前默认值）
 * @returns {{pixels: Uint8ClampedArray, width: number, height: number}}
 */
export function processPixels({
  mode,
  key,
  direction,
  width,
  height,
  pixels,
  variants = VARIANTS,
  blockSize = BLOCK_SIZE
}) {
  if (!pixels || pixels.length !== width * height * 4) {
    throw new Error('像素缓冲长度与尺寸不匹配');
  }
  if (direction !== 'encrypt' && direction !== 'decrypt') {
    throw new Error(`未知方向：${direction}`);
  }

  switch (mode) {
    case 'gilbert':
      return tomatoScramble({ pixels, width, height, direction, rounding: variants.gilbertRounding });
    case 'b':
      return blockScramble({
        pixels,
        width,
        height,
        key,
        direction,
        blockSize,
        variant: variants.blockVariant
      });
    case 'c':
      return pixelScramble({ pixels, width, height, key, direction });
    case 'c2':
      return rowPixelScramble({ pixels, width, height, key, direction });
    case 'pe1':
      return rowLogistic({ pixels, width, height, key, direction, chaining: variants.pe1Chaining });
    case 'pe2':
      return rowColumnLogistic({ pixels, width, height, key, direction });
    default:
      throw new Error(`未知模式：${mode}`);
  }
}

/**
 * 计算处理后的输出尺寸（仅方块模式会填充到 32 的倍数，且不裁剪回原尺寸 —— 与手机版一致）
 * @returns {{width: number, height: number, padded: boolean}}
 */
export function outputSize(mode, width, height, blockSize = BLOCK_SIZE) {
  if (mode === 'b') {
    const w = Math.ceil(width / blockSize) * blockSize;
    const h = Math.ceil(height / blockSize) * blockSize;
    return { width: w, height: h, padded: w !== width || h !== height };
  }
  return { width, height, padded: false };
}

/**
 * 校验密钥是否符合该模式要求（规则与手机版一致）
 * @returns {{ok: boolean, message: string}}
 */
export function validateKey(mode, key) {
  switch (mode) {
    case 'gilbert':
      return { ok: true, message: '该模式不需要密钥' };
    case 'b':
    case 'c':
    case 'c2':
      return { ok: typeof key === 'string', message: '请输入字符串密钥' };
    case 'pe1':
    case 'pe2': {
      const v = Number(key);
      if (!Number.isFinite(v) || v <= 0 || v >= 1) {
        return { ok: false, message: '密钥无效或格式错误：请输入 0 到 1 之间的小数' };
      }
      return { ok: true, message: '请输入 0 到 1 之间的小数' };
    }
    default:
      return { ok: false, message: `未知处理模式：${mode}` };
  }
}