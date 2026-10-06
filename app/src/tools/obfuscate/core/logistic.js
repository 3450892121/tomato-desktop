// Logistic 混沌序列（PE1 / PE2 模式用）
// 与手机版/生态参考实现一致：x_{n+1} = 3.9999999 · x_n · (1 − x_n)，按键值排序得到错位表。
// 排序采用稳定排序（与参考实现一致）：值相同时保持原有先后顺序。

const MU = 3.9999999;

/**
 * 生成 Logistic 序列并按键值升序给出原始下标（错位表）
 * @param {number} seed 初值（0~1）
 * @param {number} n 长度
 * @returns {Int32Array} positions[i] = 排序后第 i 个位置对应的原下标
 */
export function logisticPositions(seed, n) {
  const values = new Float64Array(n);
  let x = seed;
  values[0] = x;
  for (let i = 1; i < n; i++) {
    x = MU * x * (1 - x);
    values[i] = x;
  }

  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  // 稳定排序：按值比较，值相等时按下标先后（JS 引擎的排序自 ES2019 起保证稳定）
  const sorted = Array.from(idx).sort((a, b) => values[a] - values[b]);
  return Int32Array.from(sorted);
}

/**
 * 递推出「长度 n 的序列的最后一个值」：f^(n-1)(seed)
 * 用于 PE 模式行/列之间的链式衔接（与参考实现一致）
 * @param {number} seed 初值
 * @param {number} n 序列长度
 * @returns {number}
 */
export function advanceSeed(seed, n) {
  let x = seed;
  for (let i = 1; i < n; i++) {
    x = MU * x * (1 - x);
  }
  return x;
}