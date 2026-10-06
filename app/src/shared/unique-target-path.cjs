// 主进程用的输出文件名分配器（CommonJS：main.js 与 Node 单测都能直接 require）。
// 单独成文件的原因：这段逻辑是 main.js 里少数「不依赖 Electron、但错了会静默丢用户产物」
// 的部分，抽出来才能用 `node tests/uniquepath.test.mjs` 直接钉住它的并发语义。
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 在目标目录里挑一个不重名的文件名（原名 → 原名(1) → 原名(2)…），绝不覆盖已有文件。
 *
 * 「挑名字」和「占住名字」必须是同一步。只靠 existsSync 探测的话，任务队列 io 通道
 * 并发 2 时两个任务会拿到同一个名字（A 还没落盘、B 就已经探测完了），后写的静默覆盖
 * 先写的，而两条都报成功——用户只会发现少了一个产物。
 * 所以这里用 openSync(.., 'wx') 原子占位：名字已被占就直接 EEXIST，换下一个序号。
 *
 * 占位留下的是 0 字节文件，随后被真正的写入覆盖；写入失败时由调用方删掉
 * （main.js 里 ffmpeg 三条通道的失败分支本来就会 rmSync(target)）。
 * 目录不存在时先建出来——openSync 不会替你建目录，调用方随后那句 mkdir 因此变成
 * 幂等空操作。
 *
 * @param {string} dir 目标目录
 * @param {string} baseName 不含扩展名的文件名
 * @param {string} ext 扩展名（带不带前导点都行）
 * @returns {string} 已占位的绝对路径
 */
function uniqueTargetPath(dir, baseName, ext) {
  const suffix = String(ext || '').startsWith('.') ? String(ext || '') : `.${ext || ''}`;
  fs.mkdirSync(dir, { recursive: true });
  let i = 0;
  for (;;) {
    const target = path.join(dir, i === 0 ? `${baseName}${suffix}` : `${baseName}(${i})${suffix}`);
    try {
      fs.closeSync(fs.openSync(target, 'wx'));
      return target;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      i += 1;
    }
  }
}

module.exports = { uniqueTargetPath };
