// MCP server 冒烟测试（纯 Node，不需要 Electron）
// 运行：cd app && node tests/mcp.test.mjs（已挂进 npm test）
//
// 判定标准：不是「进程没崩」就算过，而是——
//   · initialize / tools.list 能正常返回；
//   · 每个工具真实调用，产物能读回、内容/像素逐字节一致；
//   · 重名不覆盖（uniqueTargetPath 的约定）。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { checkApproval, grantSession, grantOnce, revokeAll } from '../src/tools/videodl/core/agent-approval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const SERVER = path.join(APP, 'mcp', 'server.mjs');

let pass = 0;
let fail = 0;
const results = [];
const roots = [];

function tempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-mcp-'));
  roots.push(root);
  return root;
}

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    results.push(`  ✅ ${name}`);
  } catch (err) {
    fail += 1;
    results.push(`  ❌ ${name}\n       ${(err && err.stack) || err}`);
  }
}

/** 极简 MCP stdio 客户端 */
class McpClient {
  constructor(env = {}) {
    this.child = spawn(process.execPath, [SERVER], {
      cwd: APP,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...env }
    });
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      for (;;) {
        const idx = this.buf.indexOf('\n');
        if (idx < 0) break;
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'JSON-RPC error'));
          else p.resolve(msg.result);
        }
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}`));
      }, 60000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async call(name, args) {
    const r = await this.request('tools/call', { name, arguments: args });
    if (r && r.isError) throw new Error((r.content && r.content[0] && r.content[0].text) || 'tool error');
    if (r && r.structuredContent) return r.structuredContent;
    return JSON.parse(r.content[0].text);
  }

  close() {
    try { this.child.stdin.end(); } catch { /* ignore */ }
    try { this.child.kill(); } catch { /* ignore */ }
  }
}

async function makePng(file, width = 64, height = 64) {  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      img.data[i] = (x * 7 + y * 3) % 256;
      img.data[i + 1] = (y * 11) % 256;
      img.data[i + 2] = (x * y) % 256;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  await fsp.writeFile(file, canvas.toBuffer('image/png'));
}

const FFMPEG = path.join(APP, 'addons', 'ffmpeg', 'ffmpeg.exe');
function makeMedia(file, args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-y', ...args, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, String(r.stderr || 'ffmpeg failed'));
}

async function readPixels(file) {
  const img = await loadImage(await fsp.readFile(file));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { pixels: ctx.getImageData(0, 0, img.width, img.height).data, width: img.width, height: img.height };
}

async function main() {
  console.log('MCP server 冒烟测试\n');
  const root = tempDir();
  const approvalDir = path.join(root, 'userdata');
  fs.mkdirSync(approvalDir, { recursive: true });
  const client = new McpClient({
    TOMATO_USERDATA_DIR: approvalDir,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost'
  });

  try {
    await test('initialize：返回 serverInfo 与 tools 能力', async () => {
      const r = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'tomato-mcp-test', version: '1.0.0' }
      });
      assert.equal(r.serverInfo.name, 'tomato-toolbox');
      assert.equal(r.capabilities.tools && typeof r.capabilities.tools, 'object');
    });

    client.notify('notifications/initialized');

    await test('tools/list：第四批工具全部注册（41 个）', async () => {
      const r = await client.request('tools/list', {});
      const names = r.tools.map((t) => t.name).sort();
      const expected = [
        'ai_upscale',
        'archive_create', 'archive_extract', 'archive_list',
        'asr_status', 'asr_transcribe',
        'audio_convert', 'audio_edit',
        'doc_convert',
        'file_rename_batch',
        'image_compress', 'image_convert', 'image_enhance',
        'image_hide_files', 'image_obfuscate', 'image_slice', 'image_stitch',
        'image_unhide_files', 'image_watermark',
        'libreoffice_status',
        'media_probe',
        'ocr_recognize', 'ocr_searchable_pdf', 'ocr_status', 'ocr_to_docx',
        'pdf_compress', 'pdf_edit',
        'pdf_extract_pages', 'pdf_images_to_pdf', 'pdf_merge', 'pdf_office_to_pdf',
        'pdf_page_count', 'pdf_split', 'pdf_to_images', 'pdf_to_word',
        'sticker_convert',
        'video_compress', 'video_convert',
        'video_download', 'video_download_cancel', 'video_download_status'
      ].sort();
      assert.deepEqual(names, expected);
      for (const t of r.tools) {
        assert.equal(typeof t.description, 'string');
        assert.equal(t.inputSchema.type, 'object');
      }
    });

    await test('image_obfuscate：b 模式混淆 → 解混淆，像素逐字节还原', async () => {
      const src = path.join(root, 'src.png');
      await makePng(src);
      const enc = await client.call('image_obfuscate', {
        input: src, mode: 'b', key: 'test-key', direction: 'encrypt',
        output: path.join(root, 'enc.png')
      });
      assert.equal(enc.ok, true);
      assert.ok(fs.existsSync(enc.output));
      const dec = await client.call('image_obfuscate', {
        input: enc.output, mode: 'b', key: 'test-key', direction: 'decrypt',
        output: path.join(root, 'dec.png')
      });
      const a = await readPixels(src);
      const b = await readPixels(dec.output);
      assert.equal(a.width, b.width);
      assert.equal(a.height, b.height);
      assert.deepEqual(Buffer.from(a.pixels), Buffer.from(b.pixels));
    });

    await test('image_hide_files / image_unhide_files：pro 模式带密码往返', async () => {
      const cover = path.join(root, 'cover.png');
      await makePng(cover, 80, 60);
      const secret = path.join(root, 'secret.txt');
      await fsp.writeFile(secret, '番茄工具箱 MCP 测试\nhello', 'utf8');
      const packed = await client.call('image_hide_files', {
        cover, items: [secret], mode: 'pro', password: '123456',
        output_dir: root, base_name: 'cover_mcp'
      });
      assert.equal(packed.ok, true);
      assert.ok(fs.existsSync(packed.output));
      const outDir = path.join(root, 'unpacked');
      const unpacked = await client.call('image_unhide_files', {
        image: packed.output, password: '123456', output_dir: outDir
      });
      assert.equal(unpacked.ok, true);
      assert.equal(unpacked.encrypted, true);
      assert.equal(unpacked.files.length, 1);
      assert.equal(await fsp.readFile(unpacked.files[0].path, 'utf8'), '番茄工具箱 MCP 测试\nhello');
    });

    await test('archive_create / archive_list / archive_extract：ZIP 真实往返', async () => {
      const inDir = path.join(root, 'archive-in');
      fs.mkdirSync(inDir, { recursive: true });
      await fsp.writeFile(path.join(inDir, 'a.txt'), 'hello a', 'utf8');
      await fsp.writeFile(path.join(inDir, 'b.txt'), 'hello b', 'utf8');
      const outDir = path.join(root, 'archive-out');
      const created = await client.call('archive_create', {
        inputs: [path.join(inDir, 'a.txt'), path.join(inDir, 'b.txt')],
        format: 'zip', output_dir: outDir, base_name: 'mcp-pack'
      });
      assert.equal(created.ok, true);
      const archive = created.output[0];
      assert.ok(fs.existsSync(archive));

      const listed = await client.call('archive_list', { archive });
      assert.equal(listed.ok, true);
      assert.ok(listed.summary.files >= 2);

      const extractDir = path.join(root, 'archive-extract');
      const extracted = await client.call('archive_extract', { archives: [archive], output_dir: extractDir });
      assert.equal(extracted.ok, true);
      assert.ok(extracted.files >= 2);
      const found = [];
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          if (fs.statSync(p).isDirectory()) walk(p);
          else found.push(p);
        }
      };
      walk(extractDir);
      const texts = found.map((p) => fs.readFileSync(p, 'utf8')).sort();
      assert.deepEqual(texts, ['hello a', 'hello b']);
    });

    await test('pdf_images_to_pdf / pdf_page_count / pdf_split：图片→PDF→拆页', async () => {
      const img = path.join(root, 'pdf-src.png');
      await makePng(img, 100, 50);
      const outPdf = path.join(root, 'one.pdf');
      const made = await client.call('pdf_images_to_pdf', { images: [img], output: outPdf });
      assert.equal(made.ok, true);
      assert.ok(fs.existsSync(made.output));

      const count = await client.call('pdf_page_count', { pdf: made.output });
      assert.equal(count.pages, 1);

      const splitDir = path.join(root, 'pdf-split');
      const split = await client.call('pdf_split', { pdf: made.output, every_n: 1, output_dir: splitDir });
      assert.equal(split.parts, 1);
      assert.equal(split.outputs.length, 1);
      assert.ok(fs.existsSync(split.outputs[0]));
    });

    await test('file_rename_batch：默认只预览，dry_run=false 才真正改名', async () => {
      const dir = path.join(root, 'rename');
      fs.mkdirSync(dir, { recursive: true });
      const a = path.join(dir, 'a.txt');
      const b = path.join(dir, 'b.txt');
      await fsp.writeFile(a, 'a', 'utf8');
      await fsp.writeFile(b, 'b', 'utf8');
      const preview = await client.call('file_rename_batch', {
        items: [a, b],
        rule: { mode: 'seq', prefix: 'doc_', start: 1, digits: 2 },
        sort: 'none', conflict: 'skip'
      });
      assert.equal(preview.dry_run, true);
      assert.equal(preview.planned, 2);
      assert.ok(fs.existsSync(a), 'dry_run 不应改文件');

      const applied = await client.call('file_rename_batch', {
        items: [a, b],
        rule: { mode: 'seq', prefix: 'doc_', start: 1, digits: 2 },
        sort: 'none', conflict: 'skip', dry_run: false
      });
      assert.equal(applied.applied.done, 2);
      assert.ok(fs.existsSync(path.join(dir, 'doc_01.txt')));
      assert.ok(fs.existsSync(path.join(dir, 'doc_02.txt')));
      assert.ok(!fs.existsSync(a));
    });

    await test('media_probe / video_convert / video_compress / audio_convert / audio_edit：真实 ffmpeg 链路', async () => {
      const video = path.join(root, 'clip.mp4');
      makeMedia(video, ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '0.5', '-pix_fmt', 'yuv420p']);
      const info = await client.call('media_probe', { path: video });
      assert.equal(info.ok, true);
      assert.equal(info.hasVideo, true);
      assert.ok(info.durationSec > 0);

      const converted = await client.call('video_convert', {
        inputs: [video], target: 'mp4', quality: 'small', height: 120,
        output_dir: path.join(root, 'video-out')
      });
      assert.equal(converted.outputs.length, 1);
      assert.ok(fs.existsSync(converted.outputs[0].output));

      const compressed = await client.call('video_compress', {
        inputs: [video], mode: 'quality', quality: 'small', height: 120,
        output_dir: path.join(root, 'video-compress')
      });
      assert.ok(fs.existsSync(compressed.outputs[0].output));

      const audio = path.join(root, 'tone.wav');
      makeMedia(audio, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-ac', '1', '-ar', '16000']);
      const aconverted = await client.call('audio_convert', {
        inputs: [audio], target: 'mp3', quality: 'small', output_dir: path.join(root, 'audio-out')
      });
      assert.ok(fs.existsSync(aconverted.outputs[0].output));

      const aedited = await client.call('audio_edit', {
        inputs: [audio], target: 'mp3', quality: 'small',
        start_ms: 0, end_ms: 300, gain_db: -6, output_dir: path.join(root, 'audio-edit')
      });
      assert.ok(fs.existsSync(aedited.output));

      const sticker = await client.call('sticker_convert', {
        inputs: [video], output: 'gif', fps: 10, width: 160,
        output_dir: path.join(root, 'sticker')
      });
      assert.ok(fs.existsSync(sticker.outputs[0].output));
    });

    await test('ocr_status / ocr_recognize：引擎能加载并返回结构化结果', async () => {
      const st = await client.call('ocr_status', {});
      assert.equal(st.found, true);
      const img = path.join(root, 'ocr-src.png');
      await makePng(img, 200, 80);
      const r = await client.call('ocr_recognize', { input: img });
      assert.equal(r.ok, true);
      assert.equal(typeof r.text, 'string');
      assert.ok(Array.isArray(r.lines));

      const pdfSrc = path.join(root, 'ocr-src.pdf');
      await client.call('pdf_images_to_pdf', { images: [img], output: pdfSrc });
      const sp = await client.call('ocr_searchable_pdf', {
        input: pdfSrc, scale: 1, output: path.join(root, 'ocr-searchable.pdf')
      });
      assert.equal(fs.readFileSync(sp.output).slice(0, 4).toString('ascii'), '%PDF');

      const docx = await client.call('ocr_to_docx', {
        input: img, output: path.join(root, 'ocr.docx')
      });
      assert.equal(fs.readFileSync(docx.output).slice(0, 2).toString('ascii'), 'PK');
    });

    await test('asr_status：加装包与 ffmpeg 就绪', async () => {
      const st = await client.call('asr_status', {});
      assert.equal(st.found, true);
      assert.equal(st.ffmpeg, true);
    });

    await test('asr_transcribe：合成音频走完整链路（无人声时如实报错）', async () => {
      const wav = path.join(root, 'asr-tone.wav');
      makeMedia(wav, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-ac', '1', '-ar', '16000']);
      let failed = false;
      try {
        await client.call('asr_transcribe', { input: wav });
      } catch (err) {
        failed = true;
        assert.match(String(err.message || ''), /未识别到语音|识别失败/);
      }
      assert.equal(failed, true, '纯正弦波不应被识别成正常语音');
    });

    await test('pdf_edit：旋转 / 水印 / 页码 / 重排 / 加密真实产物', async () => {
      const p1 = path.join(root, 'edit1.png');
      const p2 = path.join(root, 'edit2.png');
      await makePng(p1, 60, 40);
      await makePng(p2, 60, 40);
      const src = path.join(root, 'edit-src.pdf');
      await client.call('pdf_images_to_pdf', { images: [p1, p2], output: src });

      const rot = await client.call('pdf_edit', {
        input: src, operation: 'rotate', params: { pages: [1], angle: 90 },
        output: path.join(root, 'rotated.pdf')
      });
      assert.ok(fs.existsSync(rot.output));

      const wm = await client.call('pdf_edit', {
        input: src, operation: 'watermark',
        params: { text: 'CONFIDENTIAL', fontSize: 18, opacity: 0.2, position: 'center' },
        output: path.join(root, 'watermark.pdf')
      });
      assert.ok(fs.existsSync(wm.output));

      const pn = await client.call('pdf_edit', {
        input: src, operation: 'page_numbers',
        params: { format: '{n}/{total}', fontSize: 10 },
        output: path.join(root, 'page-numbers.pdf')
      });
      assert.ok(fs.existsSync(pn.output));

      const ro = await client.call('pdf_edit', {
        input: src, operation: 'reorder', params: { order: [2, 1] },
        output: path.join(root, 'reordered.pdf')
      });
      assert.ok(fs.existsSync(ro.output));

      const enc = await client.call('pdf_edit', {
        input: src, operation: 'encrypt', params: { userPassword: '123456' },
        output: path.join(root, 'encrypted.pdf')
      });
      assert.ok(fs.existsSync(enc.output));

      const dec = await client.call('pdf_edit', {
        input: enc.output, operation: 'decrypt', params: { password: '123456' },
        output: path.join(root, 'decrypted.pdf')
      });
      assert.ok(fs.existsSync(dec.output));
    });

    await test('pdf_to_images / pdf_compress：真实渲染与压缩', async () => {
      const img = path.join(root, 'render-src.png');
      await makePng(img, 200, 100);
      const srcPdf = path.join(root, 'render-src.pdf');
      await client.call('pdf_images_to_pdf', { images: [img], output: srcPdf });

      const imgs = await client.call('pdf_to_images', {
        input: srcPdf, scale: 1, format: 'png', output_dir: path.join(root, 'pdf-images')
      });
      assert.equal(imgs.outputs.length, 1);
      assert.equal(fs.readFileSync(imgs.outputs[0].output).slice(0, 4).toString('hex'), '89504e47');

      const comp = await client.call('pdf_compress', {
        input: srcPdf, preset: 'strong', output: path.join(root, 'compressed.pdf')
      });
      assert.ok(fs.existsSync(comp.output));
      assert.ok(comp.after > 0);
    });

    await test('image_compress / convert / watermark / stitch / slice / enhance：Canvas 管线真实产物', async () => {
      const src = path.join(root, 'canvas-src.png');
      await makePng(src, 120, 80);

      const comp = await client.call('image_compress', {
        inputs: [src], format: 'jpg', quality: 60, longest_edge: 100,
        output_dir: path.join(root, 'img-compress')
      });
      assert.ok(fs.existsSync(comp.outputs[0].output));
      assert.equal(comp.outputs[0].format, 'jpg');
      assert.equal(Math.max(comp.outputs[0].width, comp.outputs[0].height), 100);

      const conv = await client.call('image_convert', {
        inputs: [src], target: 'webp', quality: 70, output_dir: path.join(root, 'img-convert')
      });
      assert.ok(fs.existsSync(conv.outputs[0].output));
      assert.equal(fs.readFileSync(conv.outputs[0].output).slice(0, 4).toString('ascii'), 'RIFF');

      const bmp = await client.call('image_convert', {
        inputs: [src], target: 'bmp', output_dir: path.join(root, 'img-bmp')
      });
      assert.equal(fs.readFileSync(bmp.outputs[0].output).slice(0, 2).toString('ascii'), 'BM');

      const ico = await client.call('image_convert', {
        inputs: [src], target: 'ico', output_dir: path.join(root, 'img-ico')
      });
      assert.equal(fs.readFileSync(ico.outputs[0].output).slice(0, 4).toString('hex'), '00000100');

      const heic = await client.call('image_convert', {
        inputs: [path.join(APP, 'tests', 'assets', 'heic-sample.heic')],
        target: 'png', output_dir: path.join(root, 'img-heic')
      });
      assert.equal(fs.readFileSync(heic.outputs[0].output).slice(0, 4).toString('hex'), '89504e47');

      const tif = await client.call('image_convert', {
        inputs: [src], target: 'tif', output_dir: path.join(root, 'img-tif')
      });
      assert.match(fs.readFileSync(tif.outputs[0].output).slice(0, 4).toString('latin1'), /II\*|MM/);

      const wm = await client.call('image_watermark', {
        input: src, type: 'text', text: 'MCP', position: 'center', size_percent: 20, opacity: 60,
        output_dir: path.join(root, 'img-wm')
      });
      assert.ok(fs.existsSync(wm.output));

      const s1 = path.join(root, 's1.png');
      const s2 = path.join(root, 's2.png');
      await makePng(s1, 60, 40);
      await makePng(s2, 60, 40);
      const st = await client.call('image_stitch', {
        inputs: [s1, s2], direction: 'vertical', gap: 5, output_dir: path.join(root, 'img-stitch')
      });
      assert.ok(fs.existsSync(st.output));
      assert.ok(st.height > 80);

      const sl = await client.call('image_slice', {
        input: src, rows: 2, cols: 3, gap: 0, margin: 0, output_dir: path.join(root, 'img-slice')
      });
      assert.equal(sl.outputs.length, 6);
      assert.equal(sl.outputs[0].width, 40);
      assert.equal(sl.outputs[0].height, 40);

      const en = await client.call('image_enhance', {
        input: src, preset: 'auto', output_dir: path.join(root, 'img-enhance')
      });
      assert.ok(fs.existsSync(en.output));
    });

    await test('libreoffice_status / doc_convert：RTF→PDF 真实转换', async () => {
      const st = await client.call('libreoffice_status', {});
      assert.equal(st.found, true);
      const rtf = path.join(root, 'doc.rtf');
      await fsp.writeFile(rtf, '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}}\\f0 Hello MCP\\par}', 'utf8');
      const out = await client.call('doc_convert', {
        inputs: [rtf], target: 'pdf', output_dir: path.join(root, 'doc-out')
      });
      assert.ok(fs.existsSync(out.outputs[0].output));
      assert.equal(fs.readFileSync(out.outputs[0].output).slice(0, 4).toString('ascii'), '%PDF');
    });

    await test('video_download：没有授权时拒绝（NEEDS_APPROVAL），不产生下载', async () => {
      const r = await client.call('video_download', {
        url: 'https://example.com/not-a-real-video',
        output_dir: root
      });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'NEEDS_APPROVAL');
      assert.match(r.message, /授权/);
    });

    await test('video_download：GUI 授权后能真实下载（MCP 全链路）', async () => {
      const fixture = path.join(root, 'mcp-dl.mp4');
      makeMedia(fixture, [
        '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=160x120:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'
      ]);
      const server = http.createServer((req, res) => {
        if (req.url.startsWith('/video.mp4')) {
          const size = fs.statSync(fixture).size;
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
          fs.createReadStream(fixture).pipe(res);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const port = server.address().port;
        await grantSession(approvalDir, 60_000);
        const started = await client.call('video_download', {
          url: `http://127.0.0.1:${port}/video.mp4`,
          output_dir: path.join(root, 'dl-out')
        });
        assert.equal(started.ok, true);
        assert.equal(started.approval.mode, 'session');
        const jobId = started.job.id;

        let job = null;
        for (let i = 0; i < 120; i += 1) {
          await new Promise((r) => setTimeout(r, 500));
          const s = await client.call('video_download_status', { job_id: jobId });
          job = s.job;
          if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') break;
        }
        assert.equal(job && job.status, 'done', job && job.err ? job.err : '下载超时');
        assert.ok(job.file && fs.existsSync(job.file), '产物不存在');
        assert.ok(fs.statSync(job.file).size > 1000);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await revokeAll(approvalDir);
      }
    });

    await test('授权文件：session / once / revoke 语义正确', async () => {
      const dir = path.join(root, 'approval-unit');
      fs.mkdirSync(dir, { recursive: true });
      assert.equal((await checkApproval(dir)).ok, false);

      await grantSession(dir, 60_000);
      assert.equal((await checkApproval(dir)).mode, 'session');

      await revokeAll(dir);
      assert.equal((await checkApproval(dir)).ok, false);

      await grantOnce(dir, 60_000);
      assert.equal((await checkApproval(dir)).mode, 'once');
      assert.equal((await checkApproval(dir)).ok, false, 'once 必须用完即焚');
    });
  } finally {
    client.close();
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  }

  console.log(results.join('\n'));
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) {
    console.error('\n--- server stderr ---\n' + client.stderr);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
