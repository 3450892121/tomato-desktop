// 算法引擎（骨架 —— 尚未实现）
// 目标与规则见 spec/modules/engine.md：
//  - 6 种模式：gilbert / b / c / c2 / pe1 / pe2，与手机版 APK 完全一致
//  - 纯像素重排（不改像素值），正向=混淆，反向=解混淆
//  - 输入输出均为 RGBA 缓冲（Uint8ClampedArray），不碰文件系统与界面
//
// 计划实现顺序（按 spec）：
//  1) md5.js      —— MD5(密钥 + i) 取前 7 位十六进制（B/C/C2 洗牌用）
//  2) shuffle.js  —— Fisher-Yates 洗牌生成错位表
//  3) gilbert.js  —— Gilbert 空间填充曲线 + 固定偏移循环移位
//  4) logistic.js —— Logistic 混沌序列（3.9999999）排序错位表
//  5) scramble.js —— b/c/c2/pe1/pe2 正向与反向映射（含 PE 链式细节开关）
//  6) engine.js   —— 统一入口 processPixels()

/**
 * 统一入口（骨架阶段直接抛错，避免被误当成已实现）
 * @param {object} opts
 * @param {string} opts.mode      模式标识：gilbert | b | c | c2 | pe1 | pe2
 * @param {string|number} [opts.key] 密钥（按模式）
 * @param {'encrypt'|'decrypt'} opts.direction 方向
 * @param {number} opts.width     宽（像素）
 * @param {number} opts.height    高（像素）
 * @param {Uint8ClampedArray} opts.pixels RGBA 缓冲
 * @returns {{pixels: Uint8ClampedArray, width: number, height: number}}
 */
export function processPixels(opts) {
  void opts;
  throw new Error('算法引擎尚未实现（骨架阶段）');
}

/**
 * 计算某模式处理后的输出尺寸（方块模式会填充到 32 的倍数）
 * @param {string} mode
 * @param {number} width
 * @param {number} height
 * @returns {{width: number, height: number, padded: boolean}}
 */
export function outputSize(mode, width, height) {
  void mode;
  return { width, height, padded: false };
}