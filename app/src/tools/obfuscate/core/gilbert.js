// Gilbert 空间填充曲线（「空间曲线混淆 (番茄图)」模式用）
// 把二维像素按蛇形曲线拉成一维序列；曲线访问顺序与开源实现 gilbert2d 完全一致。
//
// 说明（重要）：不同实现对坐标取整的细节有两种做法——
//   'trunc'：向零取整，与 C++/Rust 的整数除法一致（手机版 native 库、pyscramble 库）
//   'floor'：向下取整，与网页版「小番茄」的 JS 实现一致
// 两者只在个别奇数尺寸下可能产生差异；最终以与安卓版互通的真机样本实测为准。

const HALF = {
  trunc: (v) => (v / 2) | 0,
  floor: (v) => Math.floor(v / 2)
};

/**
 * 生成 Gilbert 曲线的像素访问顺序
 * @param {number} width
 * @param {number} height
 * @param {'trunc'|'floor'} rounding 取整方式
 * @returns {Int32Array} 长度为 width*height，元素为像素线性下标（x + y*width）
 */
export function gilbert2d(width, height, rounding = 'trunc') {
  const half = HALF[rounding];
  const points = [];

  function gen(x, y, ax, ay, bx, by) {
    const w = Math.abs(ax + ay);
    const h = Math.abs(bx + by);
    const dax = Math.sign(ax);
    const day = Math.sign(ay);
    const dbx = Math.sign(bx);
    const dby = Math.sign(by);

    if (h === 1) {
      for (let i = 0; i < w; i++) {
        points.push(x + y * width);
        x += dax;
        y += day;
      }
      return;
    }
    if (w === 1) {
      for (let i = 0; i < h; i++) {
        points.push(x + y * width);
        x += dbx;
        y += dby;
      }
      return;
    }

    let ax2 = half(ax);
    let ay2 = half(ay);
    let bx2 = half(bx);
    let by2 = half(by);
    const w2 = Math.abs(ax2 + ay2);
    const h2 = Math.abs(bx2 + by2);

    if (2 * w > 3 * h) {
      if ((w2 & 1) === 1 && w > 2) {
        ax2 += dax;
        ay2 += day;
      }
      gen(x, y, ax2, ay2, bx, by);
      gen(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by);
    } else {
      if ((h2 & 1) === 1 && h > 2) {
        bx2 += dbx;
        by2 += dby;
      }
      gen(x, y, bx2, by2, ax2, ay2);
      gen(x + bx2, y + by2, ax, ay, bx - bx2, by - by2);
      gen(
        x + (ax - dax) + (bx2 - dbx),
        y + (ay - day) + (by2 - dby),
        -bx2,
        -by2,
        -(ax - ax2),
        -(ay - ay2)
      );
    }
  }

  if (width >= height) {
    gen(0, 0, width, 0, 0, height);
  } else {
    gen(0, 0, 0, height, width, 0);
  }

  return Int32Array.from(points);
}