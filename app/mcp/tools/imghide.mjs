// MCP 工具：文件藏图（图夹）打包 / 解包
// 直接复用 src/tools/imghide/core/engine.mjs（纯 Node：fs + zlib + crypto）。
//
// 两种容器：
//   fast = 动态混淆（图片尾部追加，任意图片格式都能当表图；不加密）
//   pro  = 图夹 PRO（PNG/GIF 的 V6 容器；可加密码；与官方图夹双向互通）
import { packImage, unpackImage } from '../../src/tools/imghide/core/engine.mjs';
import { assertFile, assertDir } from '../lib/paths.mjs';

export const hideTool = {
  name: 'image_hide_files',
  description:
    '把任意文件藏进一张图片（图夹）。fast 模式支持任意图片当表图、不加密；'
    + 'pro 模式只支持 PNG/GIF 表图、可加密码，与网上「图夹」双向互通。'
    + '产物默认叫「<表图名>_图夹.png|gif」，重名自动加序号。',
  inputSchema: {
    type: 'object',
    required: ['cover', 'items'],
    properties: {
      cover: { type: 'string', description: '表图路径（封面图片）' },
      items: { type: 'array', items: { type: 'string' }, minItems: 1, description: '要藏进去的文件路径列表' },
      mode: { type: 'string', enum: ['fast', 'pro'], description: 'fast=动态混淆；pro=图夹 PRO；默认 fast' },
      password: { type: 'string', description: '可选：pro 模式的密码（fast 模式忽略）' },
      output_dir: { type: 'string', description: '可选：输出目录（默认表图同目录）' },
      base_name: { type: 'string', description: '可选：输出文件名（不含扩展名）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const cover = assertFile(args.cover, '表图');
    const items = (Array.isArray(args.items) ? args.items : []).map((p) => assertFile(p, '要藏的文件'));
    if (items.length === 0) throw new Error('items 不能为空');
    const mode = args.mode === 'pro' ? 'pro' : 'fast';

    const res = await packImage({
      mode,
      coverPath: cover,
      items: items.map((p) => ({ path: p })),
      password: mode === 'pro' ? String(args.password || '') : '',
      outputDir: args.output_dir ? assertDir(args.output_dir, '输出目录') : undefined,
      baseName: args.base_name || undefined
    });

    return {
      ok: true,
      output: res.path,
      size: res.size,
      kind: res.kind,
      files: res.files,
      mode,
      encrypted: mode === 'pro' && !!args.password,
      ms: res.ms
    };
  }
};

export const unhideTool = {
  name: 'image_unhide_files',
  description:
    '从图夹图片里取出文件。先按「动态混淆」找；找不到再按图夹 PRO 的 PNG/GIF 容器找。'
    + '解出的文件默认落在图片旁边的「<图片名>_解出」目录，重名自动加序号，不会覆盖已有文件。',
  inputSchema: {
    type: 'object',
    required: ['image'],
    properties: {
      image: { type: 'string', description: '图夹图片路径' },
      password: { type: 'string', description: '可选：图夹 PRO 的密码' },
      output_dir: { type: 'string', description: '可选：解出目录（默认图片旁边的 <图片名>_解出）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const image = assertFile(args.image, '图夹图片');
    const res = await unpackImage({
      imagePath: image,
      password: String(args.password || ''),
      outputDir: args.output_dir ? assertDir(args.output_dir, '输出目录') : undefined
    });
    return {
      ok: true,
      output_dir: res.dir,
      files: res.files,
      encrypted: res.encrypted,
      ms: res.ms
    };
  }
};

export default [hideTool, unhideTool];
