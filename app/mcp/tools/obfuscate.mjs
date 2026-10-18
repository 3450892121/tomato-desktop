// MCP 工具：图片混淆 / 解混淆
// 直接复用 src/tools/obfuscate/core/engine.js 的六模式引擎；输入输出走 Node 版编解码。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { processPixels, outputSize, validateKey, BLOCK_SIZE } from '../../src/tools/obfuscate/core/engine.js';
import { decodeImageFile, encodeImageBytes } from '../lib/image-node.mjs';
import { assertFile, resolveOutputPath } from '../lib/paths.mjs';

const MODES = ['gilbert', 'b', 'c', 'c2', 'pe1', 'pe2'];

function autoFormat(mode) {
  // 与 GUI 一致：gilbert 存 JPG（手机版行为），其余存 PNG
  return mode === 'gilbert' ? 'jpg' : 'png';
}

export default {
  name: 'image_obfuscate',
  description:
    '对图片做番茄混淆/解混淆（六种模式，逐像素可逆，不改变像素值、只改位置）。'
    + ' gilbert 模式不需要密钥；b/c/c2 需要字符串密钥；pe1/pe2 需要 0~1 之间的小数密钥。'
    + ' 产物默认写到原图同目录，重名自动加序号，绝不覆盖已有文件。',
  inputSchema: {
    type: 'object',
    required: ['input', 'mode', 'direction'],
    properties: {
      input: { type: 'string', description: '输入图片路径（PNG / JPG / WebP）' },
      mode: { type: 'string', enum: MODES, description: '混淆模式' },
      direction: { type: 'string', enum: ['encrypt', 'decrypt'], description: 'encrypt=混淆；decrypt=解混淆' },
      key: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
        description: '密钥：b/c/c2 用字符串；pe1/pe2 用 0~1 小数；gilbert 不需要'
      },
      output: { type: 'string', description: '可选：指定输出文件路径（重名仍会自动加序号）' },
      output_dir: { type: 'string', description: '可选：输出目录（默认与原图同目录）' },
      base_name: { type: 'string', description: '可选：输出文件名（不含扩展名）' },
      format: { type: 'string', enum: ['auto', 'png', 'jpg', 'webp'], description: '输出格式；默认 auto' },
      quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPG / WebP 画质，默认 95' },
      block_size: { type: 'integer', minimum: 8, maximum: 256, description: 'b 模式的方块边长，默认 32' }
    },
    additionalProperties: false
  },

  async handler(args = {}) {
    const t0 = Date.now();
    const input = assertFile(args.input, '输入图片');
    const mode = String(args.mode || '');
    if (!MODES.includes(mode)) throw new Error(`未知模式：${mode}（只能是 ${MODES.join(' / ')}）`);
    const direction = args.direction === 'decrypt' ? 'decrypt' : 'encrypt';

    const check = validateKey(mode, args.key);
    if (!check.ok) throw new Error(check.message);

    const blockSize = Number.isInteger(args.block_size) ? args.block_size : BLOCK_SIZE;
    const { pixels, width, height } = await decodeImageFile(input);
    const out = processPixels({
      mode,
      key: args.key,
      direction,
      width,
      height,
      pixels,
      blockSize
    });

    const size = outputSize(mode, width, height, blockSize);
    const fmt = args.format && args.format !== 'auto' ? args.format : autoFormat(mode);
    if (!['png', 'jpg', 'webp'].includes(fmt)) throw new Error(`不支持的输出格式：${fmt}`);
    const quality = Number.isInteger(args.quality) ? args.quality : 95;

    const inputBase = path.basename(input, path.extname(input));
    const suffix = direction === 'encrypt' ? '_混淆' : '_解混淆';
    const target = resolveOutputPath({
      output: args.output,
      output_dir: args.output_dir,
      base_name: args.base_name || `${inputBase}${suffix}`,
      ext: `.${fmt}`,
      fallbackDir: path.dirname(input)
    });

    await fsp.writeFile(target.path, encodeImageBytes(out.pixels, out.width, out.height, fmt, quality));

    return {
      ok: true,
      output: target.path,
      width: out.width,
      height: out.height,
      mode,
      direction,
      format: fmt,
      padded: size.padded,
      block_size: blockSize,
      ms: Date.now() - t0
    };
  }
};
