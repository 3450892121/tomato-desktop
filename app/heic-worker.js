// HEIC/HEIF 解码 worker（跑在主进程的 worker_threads 线程里）
// 为什么放 worker：heic-decode 的 WASM 解码是同步计算（本机实测 140 万像素约 80ms，
// 1200 万像素约 1 秒），直接在主进程事件循环里跑会把整个应用的 IPC 卡住（对话框、
// 文件读写全部排队）；批量转换手机照片时会整窗发顿。协议：收 {id, bytes}，回
// {id, ok, width, height, pixels}（pixels 为 RGBA，transfer 零拷贝）或 {id, ok:false, message}。
// 引擎与选型依据见 spec/modules/image-convert.md（heic-decode ISC + libheif-js LGPL-3.0）。
'use strict';

const { parentPort } = require('worker_threads');
const decode = require('heic-decode');

parentPort.on('message', async ({ id, bytes }) => {
  try {
    const r = await decode({ buffer: bytes });
    // r.data 是 heic-decode 为本次解码新分配的精确尺寸 Uint8ClampedArray，可安全 transfer
    parentPort.postMessage(
      { id, ok: true, width: r.width, height: r.height, pixels: r.data },
      [r.data.buffer]
    );
  } catch (err) {
    parentPort.postMessage({ id, ok: false, message: String((err && err.message) || err) });
  }
});
