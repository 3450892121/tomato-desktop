// 打包产物 MCP 冒烟（开发树运行，针对 release 里的 resources/app/mcp）
// 目的：验证打包后 addons 路径（<软件目录>/addons）、pdfjs legacy、@napi-rs/canvas、
//       heic-decode、ppu-paddle-ocr、ImageMagick... 不是，是 OCR 运行时，是否都能从产物里加载。
//
// 运行：cd app && node tests/pack-mcp-smoke.mjs [release目录]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');

function findRelease() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const dir = path.join(APP_DIR, 'release');
  const names = fs.readdirSync(dir).filter((n) => /^番茄图片混淆-桌面版-v.*-win64$/.test(n));
  if (names.length === 0) throw new Error('release 目录里没有打包产物');
  names.sort();
  return path.join(dir, names[names.length - 1]);
}

const RELEASE = findRelease();
const SERVER = path.join(RELEASE, 'resources', 'app', 'mcp', 'server.mjs');
const USERDATA = path.join(os.tmpdir(), `tomato-pack-mcp-${process.pid}`);

class Client {
  constructor(extraEnv = {}) {
    this.child = spawn(process.execPath, [SERVER], {
      cwd: path.join(RELEASE, 'resources', 'app'),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, TOMATO_USERDATA_DIR: USERDATA, ...extraEnv }
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
        reject(new Error(`超时：${method}`));
      }, 120000);
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
    return r && r.structuredContent ? r.structuredContent : JSON.parse(r.content[0].text);
  }

  close() {
    try { this.child.stdin.end(); } catch { /* ignore */ }
    try { this.child.kill(); } catch { /* ignore */ }
  }
}

async function makePng(file, w = 80, h = 60) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (i * 7) % 256;
    img.data[i + 1] = (i * 11) % 256;
    img.data[i + 2] = (i * 13) % 256;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  await fsp.writeFile(file, canvas.toBuffer('image/png'));
}

let pass = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    results.push(`  ✅ ${name}`);
  } catch (err) {
    results.push(`  ❌ ${name}\n       ${(err && err.message) || err}`);
    throw err;
  }
}

async function main() {
  console.log(`打包 MCP 冒烟：${RELEASE}\n`);
  const client = new Client();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tomato-pack-mcp-data-'));
  try {
    await test('initialize', async () => {
      const r = await client.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pack-smoke', version: '1' }
      });
      assert.equal(r.serverInfo.name, 'tomato-toolbox');
    });
    client.notify('notifications/initialized');

    await test('tools/list：产物里 41 个工具', async () => {
      const r = await client.request('tools/list', {});
      assert.equal(r.tools.length, 41);
    });

    await test('image_obfuscate：产物内 @napi-rs/canvas 可加载', async () => {
      const src = path.join(root, 'src.png');
      await makePng(src);
      const enc = await client.call('image_obfuscate', {
        input: src, mode: 'b', key: 'pack', direction: 'encrypt',
        output: path.join(root, 'enc.png')
      });
      assert.ok(fs.existsSync(enc.output));
    });

    await test('路径白名单 + 审计日志：产物内也生效', async () => {
      await assert.rejects(
        () => client.call('image_obfuscate', {
          input: path.join('C:\\Windows', 'win.ini'), mode: 'b', direction: 'encrypt', key: 'x'
        }),
        /不在允许范围/
      );
      const audit = path.join(USERDATA, 'mcp-audit.jsonl');
      assert.ok(fs.existsSync(audit), '产物内没有生成 mcp-audit.jsonl');
      const lines = fs.readFileSync(audit, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(lines.some((l) => l.tool === 'image_obfuscate' && l.ok === true));
    });

    await test('archive_create/list：产物内 addons/7zip 路径正确', async () => {
      const txt = path.join(root, 'a.txt');
      await fsp.writeFile(txt, 'pack', 'utf8');
      const outDir = path.join(root, 'arch');
      const created = await client.call('archive_create', {
        inputs: [txt], format: 'zip', output_dir: outDir, base_name: 'pack'
      });
      assert.ok(fs.existsSync(created.output[0]));
      const listed = await client.call('archive_list', { archive: created.output[0] });
      assert.ok(listed.summary.files >= 1);
    });

    await test('pdf_images_to_pdf / pdf_to_images：产物内 pdfjs legacy 可加载', async () => {
      const img = path.join(root, 'pdf.png');
      await makePng(img, 100, 50);
      const pdf = path.join(root, 'pack.pdf');
      await client.call('pdf_images_to_pdf', { images: [img], output: pdf });
      const imgs = await client.call('pdf_to_images', {
        input: pdf, scale: 1, format: 'png', output_dir: path.join(root, 'pdf-out')
      });
      assert.ok(fs.existsSync(imgs.outputs[0].output));
    });

    await test('image_convert：产物内 heic-decode 可加载', async () => {
      const heic = path.join(RELEASE, 'resources', 'app', 'tests', 'assets', 'heic-sample.heic');
      const out = await client.call('image_convert', {
        inputs: [heic], target: 'png', output_dir: path.join(root, 'heic')
      });
      assert.ok(fs.existsSync(out.outputs[0].output));
    });

    await test('ocr_status / ocr_recognize：产物内 addons/ocr 路径正确', async () => {
      const st = await client.call('ocr_status', {});
      assert.equal(st.found, true);
      const img = path.join(root, 'ocr.png');
      await makePng(img, 100, 40);
      const r = await client.call('ocr_recognize', { input: img });
      assert.equal(r.ok, true);
    });

    await test('libreoffice_status / asr_status：产物内 addons 路径正确', async () => {
      const lo = await client.call('libreoffice_status', {});
      assert.equal(lo.found, true);
      const asr = await client.call('asr_status', {});
      assert.equal(asr.found, true);
      assert.equal(asr.ffmpeg, true);
    });
  } finally {
    client.close();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(USERDATA, { recursive: true, force: true }).catch(() => {});
  }
  console.log(results.join('\n'));
  console.log(`\n结果：通过 ${pass} 项`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
