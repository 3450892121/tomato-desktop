// 密钥洗牌（B/C/C2 模式共用）
// 规则与手机版/生态参考实现完全一致：
//   对 i 从 N-1 递减到 1：取 MD5(密钥 + i) 的前 7 位十六进制 → 对 (i+1) 取模 → 与位置 i 交换（Fisher-Yates）
import { md5Hex } from './md5.js';

/**
 * 生成 0..length-1 的洗牌序列
 * @param {number} length
 * @param {string} key 字符串密钥
 * @returns {Int32Array} 洗牌后的索引表
 */
export function shuffleWithKey(length, key) {
  const arr = new Int32Array(length);
  for (let i = 0; i < length; i++) arr[i] = i;

  const prefix = String(key);
  for (let i = length - 1; i > 0; i--) {
    const hex = md5Hex(prefix + i);
    const rand = parseInt(hex.slice(0, 7), 16) % (i + 1);
    const tmp = arr[rand];
    arr[rand] = arr[i];
    arr[i] = tmp;
  }
  return arr;
}