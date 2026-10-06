// 生成兼容性测试样本（仅 `electron . --make-samples <目录> --mode <模式> [--key <密钥>]` 时运行）
// 用途：给自己人验证「verify-samples」工具是否正常，也可用于给对方演示样本命名规范。
'use strict';

async function runMakeSamples(win, { dir, mode, key }) {
  const script = `
    (async () => {
      const { encodeImageToBytes } = await import('../shared/imageio.js');
      const { processPixels } = await import('../tools/obfuscate/core/engine.js');
      const dir = ${JSON.stringify(dir)};
      const mode = ${JSON.stringify(mode)};
      const rawKey = ${JSON.stringify(key === null || key === undefined ? null : String(key))};

      // 生成一张渐变测试原图
      const w = 160, h = 96;
      const px = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = (x + y * w) * 4;
        px[p] = Math.round((x / (w - 1)) * 255);
        px[p + 1] = Math.round((y / (h - 1)) * 255);
        px[p + 2] = ((x >> 4) + (y >> 4)) % 2 ? 200 : 80;
        px[p + 3] = 255;
      }
      const png = await encodeImageToBytes(px, w, h, { format: 'png' });
      const savedOriginal = await window.desktop.saveImageNextTo({
        sourcePath: dir + '/seed.png', baseName: '样本原图', ext: '.png', bytes: png
      });

      const key = mode === 'gilbert' ? undefined : (${JSON.stringify(mode)} === 'pe1' || mode === 'pe2' ? Number(rawKey) : rawKey);
      const enc = processPixels({ mode, key, direction: 'encrypt', width: w, height: h, pixels: px });
      const encPng = await encodeImageToBytes(enc.pixels, enc.width, enc.height, { format: 'png' });
      const savedObf = await window.desktop.saveImageNextTo({
        sourcePath: dir + '/seed.png', baseName: '样本原图_' + mode + '_混淆', ext: '.png', bytes: encPng
      });

      return JSON.stringify({ mode, key: key === undefined ? null : String(key), original: savedOriginal, obfuscated: savedObf });
    })()
  `;
  const raw = await win.webContents.executeJavaScript(script);
  return JSON.parse(raw);
}

module.exports = { runMakeSamples };