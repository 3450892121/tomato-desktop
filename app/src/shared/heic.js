// HEIC/HEIF 解码（共享能力，放 shared/）
// 使用方：图片格式转换（src/tools/convert）的手机拍照格式输入。
// 说明：Chromium 内核不解码 HEIC（实测见 spec/modules/image-convert.md），真正的解码在
//       主进程 worker 线程里的 libheif WASM 引擎（main.js 的 heic:decode IPC）；本文件只做
//       界面侧统一封装，返回结构与 shared/imageio.js 的 decodeImageFromBytes 同构
//       （{pixels, width, height}），工具代码拿到后可直接进同一条转换管线。
// 引擎会正确应用 HEIF 容器的 irot/imir 旋转属性（竖拍照片方向正确，与 Windows 解码一致）。

/** 解码引擎状态：{found, version}（npm 依赖随包分发，正常恒为 found） */
export function heicStatus() {
  return window.desktop.heicStatus();
}

/**
 * HEIC/HEIF/HIF 字节 → RGBA 像素（失败抛带原因的 Error）
 * @param {ArrayBuffer|Uint8Array} bytes HEIC 文件字节
 * @returns {Promise<{pixels: Uint8ClampedArray, width: number, height: number}>}
 */
export async function decodeHeicFromBytes(bytes) {
  const res = await window.desktop.heicDecode(bytes);
  if (!res || !res.ok) throw new Error((res && res.message) || 'HEIC 解码失败');
  return { pixels: res.pixels, width: res.width, height: res.height };
}
