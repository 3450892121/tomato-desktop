// 兼容性样本验证（仅 `electron . --verify-samples <目录> --key <密钥>` 时运行）
// 用途：拿手机版 App 生成的「原图 + 混淆图」样本，自动判断它的六种模式与三处兼容性细节
//      （Gilbert 取整方式 / 方块映射写法 / PE1 链式衔接），从而把 variants.js 锁定为正确的值。
// 原理：对每对样本，用全部「模式 × 变体组合」尝试解密混淆图，与权威的原图比对，
//      误差最小的组合即为手机版所用的实现（正确组合的误差会显著低于其它组合）。
'use strict';

const path = require('path');
const fs = require('fs/promises');

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp)$/i;
/** 混淆图命名：兼容本软件（_混淆）与手机版（直接追加"混淆"）两种写法 */
const OBF_SUFFIX = /(?:[_\-\s]?)混淆(\.[^.]+)$/;
const stripExt = (f) => f.replace(/\.[^.]+$/, '');

/** 从目录里找出「原图 + 混淆图」配对 */
async function findPairs(dir) {
  const files = (await fs.readdir(dir)).filter((f) => IMAGE_EXT.test(f));
  const obfFiles = files.filter((f) => OBF_SUFFIX.test(f));
  const originals = files.filter((f) => !OBF_SUFFIX.test(f));
  const pairs = [];

  for (const obf of obfFiles) {
    const base = stripExt(obf.replace(OBF_SUFFIX, ''));
    let original = originals.find((f) => stripExt(f) === base);

    // 逐级去掉末尾的 _xxx 段再匹配（例如「原图_c_混淆」→「原图」）
    if (!original) {
      let b = base;
      while (!original && b.includes('_')) {
        b = b.slice(0, b.lastIndexOf('_'));
        original = originals.find((f) => stripExt(f) === b);
      }
    }
    // 兜底：目录里只有一张原图时直接配对
    if (!original && originals.length === 1) original = originals[0];

    if (original) {
      pairs.push({ name: base, original: path.join(dir, original), obfuscated: path.join(dir, obf) });
    }
  }
  return pairs;
}

async function runVerifySamples(win, dir, key) {
  const pairs = await findPairs(dir);
  if (pairs.length === 0) {
    return { ok: false, reason: `目录里没有找到「原图 + xxx_混淆.扩展名」的配对：${dir}` };
  }

  const script = `
    (async () => {
      const { decodeImageFromBytes } = await import('../shared/imageio.js');
      const { processPixels } = await import('../tools/obfuscate/core/engine.js');
      const pairs = ${JSON.stringify(pairs)};
      const rawKey = ${JSON.stringify(key === null || key === undefined ? null : String(key))};

      const combos = [];
      for (const v of [{ gilbertRounding: 'trunc' }, { gilbertRounding: 'floor' }]) combos.push({ mode: 'gilbert', variants: v, keyType: 'none' });
      for (const v of [{ blockVariant: 'py' }, { blockVariant: 'js' }]) combos.push({ mode: 'b', variants: v, keyType: 'string' });
      combos.push({ mode: 'c', variants: {}, keyType: 'string' });
      combos.push({ mode: 'c2', variants: {}, keyType: 'string' });
      for (const v of [{ pe1Chaining: 'single' }, { pe1Chaining: 'chained' }]) combos.push({ mode: 'pe1', variants: v, keyType: 'number' });
      combos.push({ mode: 'pe2', variants: {}, keyType: 'number' });

      const results = [];
      for (const pair of pairs) {
        const orig = await decodeImageFromBytes(await window.desktop.readFile(pair.original));
        const obf = await decodeImageFromBytes(await window.desktop.readFile(pair.obfuscated));
        const row = { pair: pair.name, originalSize: orig.width + 'x' + orig.height, obfuscatedSize: obf.width + 'x' + obf.height, attempts: [] };

        for (const combo of combos) {
          let key;
          if (combo.keyType === 'none') key = undefined;
          else if (combo.keyType === 'string') key = rawKey === null ? null : rawKey;
          else { const n = Number(rawKey); key = Number.isFinite(n) ? n : null; }
          if (combo.keyType !== 'none' && key === null) continue;

          try {
            const dec = processPixels({
              mode: combo.mode, key, direction: 'decrypt',
              width: obf.width, height: obf.height, pixels: obf.pixels, variants: combo.variants
            });
            // 误差统计（只比 RGB；只比两图共有的区域，容忍尺寸差异）
            const w = Math.min(dec.width, orig.width);
            const h = Math.min(dec.height, orig.height);
            let sum = 0; let max = 0; let n = 0;
            for (let y = 0; y < h; y++) {
              for (let x = 0; x < w; x++) {
                const a = (x + y * dec.width) * 4;
                const b = (x + y * orig.width) * 4;
                for (let c = 0; c < 3; c++) {
                  const d = Math.abs(dec.pixels[a + c] - orig.pixels[b + c]);
                  sum += d; n++; if (d > max) max = d;
                }
              }
            }
            row.attempts.push({ mode: combo.mode, variants: JSON.stringify(combo.variants), meanDiff: +(sum / n).toFixed(2), maxDiff: max });
          } catch (err) {
            row.attempts.push({ mode: combo.mode, variants: JSON.stringify(combo.variants), error: err.message });
          }
        }
        row.attempts.sort((a, b) => (a.meanDiff ?? 1e9) - (b.meanDiff ?? 1e9));
        results.push(row);
      }
      return JSON.stringify({ ok: true, key: rawKey, results });
    })()
  `;

  const raw = await win.webContents.executeJavaScript(script);
  const parsed = JSON.parse(raw);

  // 结论：每对样本给出「最佳匹配」（meanDiff 越小越像；接近 0 即为命中）
  const verdict = parsed.results.map((row) => ({
    pair: row.pair,
    size: `${row.originalSize} ← ${row.obfuscatedSize}`,
    best: row.attempts[0],
    runnerUp: row.attempts[1],
    solid: row.attempts[0] && typeof row.attempts[0].meanDiff === 'number' && row.attempts[0].meanDiff <= 2
  }));

  return {
    ok: true,
    key: parsed.key,
    pairs: parsed.results.length,
    verdict,
    detail: parsed.results
  };
}

module.exports = { runVerifySamples, findPairs };