// MCP 工具：语音转文字（FunASR SenseVoice，纯离线纯 CPU）
// 与 GUI 的 asr:transcribe 同一套链路：先 ffmpeg 转 16kHz 单声道 wav，再跑 SenseVoice 输出 SRT。
// 说明：模型/可执行文件都在 addons/asr；缺包时明确报错。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { portableRoot, assertFile, assertDir, uniqueTargetPath } from '../lib/paths.mjs';
import { findFfmpeg, runFfmpeg } from '../lib/ffmpeg-runner.mjs';
import { srtToText } from '../../src/tools/transcribe/core/plan.js';

const ASR_DIR = path.join(portableRoot(), 'addons', 'asr');
const ASR_EXE = path.join(ASR_DIR, 'llama-funasr-sensevoice.exe');
const ASR_MODEL = path.join(ASR_DIR, 'models', 'sensevoice-small-q8.gguf');
const ASR_VAD = path.join(ASR_DIR, 'models', 'fsmn-vad.gguf');

function findAsr() {
  return fs.existsSync(ASR_EXE) && fs.existsSync(ASR_MODEL) && fs.existsSync(ASR_VAD);
}

export const statusTool = {
  name: 'asr_status',
  description: '检查语音识别引擎是否就绪（FunASR 可执行文件、模型、VAD、ffmpeg）。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler() {
    return {
      ok: true,
      found: findAsr(),
      ffmpeg: !!findFfmpeg(),
      dir: ASR_DIR,
      files: {
        exe: fs.existsSync(ASR_EXE),
        model: fs.existsSync(ASR_MODEL),
        vad: fs.existsSync(ASR_VAD)
      }
    };
  }
};

export const transcribeTool = {
  name: 'asr_transcribe',
  description:
    '把音频/视频转成文字（中英日韩粤）。返回 SRT 字幕；可选保存 .srt / .txt 到输出目录。'
    + ' 纯离线、纯 CPU；首次调用会加载约 240MB 模型，稍慢。',
  inputSchema: {
    type: 'object',
    required: ['input'],
    properties: {
      input: { type: 'string', description: '音频或视频路径（视频自动提取音轨）' },
      format: { type: 'string', enum: ['srt', 'txt', 'both'], description: '返回/保存格式，默认 srt' },
      output_dir: { type: 'string', description: '可选：保存目录；不填则只返回文本不落盘' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const input = assertFile(args.input, '音频/视频');
    if (!findAsr()) throw new Error('未检测到语音识别加装包（把 addons/asr 放回软件目录）');
    if (!findFfmpeg()) throw new Error('未检测到 ffmpeg（识别前需要它把音频转成 16kHz 单声道）');

    const workRoot = path.join(portableRoot(), 'userdata', 'tmp');
    const workDir = path.join(workRoot, `asr-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(workDir, { recursive: true });
    const wavPath = path.join(workDir, 'in16k.wav');

    try {
      const conv = await runFfmpeg([
        '-hide_banner', '-nostdin', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', wavPath
      ], { timeoutMs: 30 * 60 * 1000 });
      if (conv.code !== 0 || !fs.existsSync(wavPath)) {
        const tail = String(conv.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ｜ ').slice(0, 200);
        throw new Error(`音频处理失败：${tail || '无法读取该文件'}`);
      }

      // 关键：模型/音频都传相对 ASCII 路径 + cwd=软件目录——含中文也安全
      const rel = (p) => path.relative(portableRoot(), p);
      const srtText = await new Promise((resolve, reject) => {
        const child = spawn(ASR_EXE, ['-m', rel(ASR_MODEL), '--vad', rel(ASR_VAD), '-a', rel(wavPath), '--srt'], {
          windowsHide: true,
          cwd: portableRoot()
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* ignore */ }
          reject(new Error('识别超时（超过 2 小时）'));
        }, 2 * 3600 * 1000);
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => {
          stderr += d.toString();
          if (stderr.length > 200000) stderr = stderr.slice(-100000);
        });
        child.on('error', (err) => { clearTimeout(timer); reject(new Error(String(err.message || err))); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            const tail = stderr.trim().split(/\r?\n/).slice(-2).join(' ｜ ').slice(0, 200);
            reject(new Error(`识别失败（退出码 ${code}）${tail ? `｜${tail}` : ''}`));
            return;
          }
          const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
          if (!text) { reject(new Error('未识别到语音内容（可能是纯音乐或没有人声）')); return; }
          resolve(text);
        });
      });

      const format = args.format === 'txt' ? 'txt' : args.format === 'both' ? 'both' : 'srt';
      const text = srtToText(srtText);
      const paths = [];
      if (args.output_dir) {
        const dir = assertDir(args.output_dir, '输出目录');
        const base = path.basename(input, path.extname(input));
        if (format === 'srt' || format === 'both') {
          const p = uniqueTargetPath(dir, base, '.srt');
          await fsp.writeFile(p, `\uFEFF${srtText}\n`, 'utf8');
          paths.push(p);
        }
        if (format === 'txt' || format === 'both') {
          const p = uniqueTargetPath(dir, base, '.txt');
          await fsp.writeFile(p, `\uFEFF${text}\n`, 'utf8');
          paths.push(p);
        }
      }

      return { ok: true, srt: srtText, text, format, paths };
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
};

export default [statusTool, transcribeTool];
