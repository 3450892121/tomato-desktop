// MCP 工具：媒体（探测 / 视频转换 / 视频压缩 / 动图互转 / 音频转换 / 音频剪辑）
// 参数拼装全部复用 src/shared/ffmpeg.js 与各工具 core/plan.js；真正执行走 MCP 自己的 ffmpeg runner。
import fs from 'node:fs';
import path from 'node:path';
import {
  VIDEO_TARGETS, videoEncodeArgs, scaleToHeightArgs,
  AUDIO_TARGETS, audioEncodeArgs
} from '../../src/shared/ffmpeg.js';
import { buildPlan as buildVideoCompressPlan, verifyTarget, retryBitrate } from '../../src/tools/video-compress/core/plan.js';
import {
  OUTPUTS, outputOf, isAnimOutput, classifyExt, animArgs, videoArgs, sizeLadder
} from '../../src/tools/sticker/core/plan.js';
import { buildEditPlan } from '../../src/tools/audio-edit/core/waveform.js';
import { probeMedia, convertFile, convertTwoPass, convertMulti } from '../lib/ffmpeg-runner.mjs';
import { assertFile } from '../lib/paths.mjs';

const QUALITIES = ['high', 'standard', 'small'];

function videoTargetOf(value) {
  const t = VIDEO_TARGETS.find((x) => x.value === value);
  if (!t) throw new Error(`不支持的视频输出格式：${value}（支持 ${VIDEO_TARGETS.map((x) => x.value).join(' / ')}）`);
  return t;
}

function audioTargetOf(value) {
  const t = AUDIO_TARGETS.find((x) => x.value === value);
  if (!t) throw new Error(`不支持的音频输出格式：${value}`);
  return t;
}

async function probeOrThrow(file) {
  const info = await probeMedia(file);
  if (!info.ok) throw new Error(`${path.basename(file)}：${info.message}`);
  return info;
}

export const probeTool = {
  name: 'media_probe',
  description: '读取媒体信息：时长、分辨率、帧率、视频/音频编码、采样率、是否有音轨。',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string', description: '媒体文件路径' } },
    additionalProperties: false
  },
  async handler(args = {}) {
    const file = assertFile(args.path, '媒体文件');
    return probeOrThrow(file);
  }
};

export const videoConvertTool = {
  name: 'video_convert',
  description: '视频格式转换（MP4 / WebM / MKV / MOV / AVI），可调画质档、分辨率、静音。',
  inputSchema: {
    type: 'object',
    required: ['inputs', 'target'],
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 1, description: '要转换的视频' },
      target: { type: 'string', enum: VIDEO_TARGETS.map((t) => t.value), description: '输出格式' },
      quality: { type: 'string', enum: QUALITIES, description: '画质档，默认 standard' },
      height: { type: 'integer', minimum: 0, description: '目标高度（0=保持原样）' },
      mute: { type: 'boolean', description: '是否去掉声音' },
      output_dir: { type: 'string', description: '可选：输出目录（默认源文件同目录）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const target = videoTargetOf(String(args.target || ''));
    const quality = QUALITIES.includes(args.quality) ? args.quality : 'standard';
    const outputs = [];
    for (const raw of Array.isArray(args.inputs) ? args.inputs : []) {
      const input = assertFile(raw, '视频');
      const info = await probeOrThrow(input);
      const ffArgs = [
        ...scaleToHeightArgs(info.width, info.height, Number(args.height) || 0),
        ...videoEncodeArgs(target.value, quality, { mute: !!args.mute })
      ];
      const res = await convertFile({
        inputPath: input,
        outputDir: args.output_dir,
        ext: target.ext,
        args: ffArgs,
        durationMs: info.durationSec * 1000
      });
      if (!res.ok) throw new Error(res.message);
      outputs.push({ input, output: res.path, size: res.size });
    }
    return { ok: true, target: target.value, quality, outputs };
  }
};

export const videoCompressTool = {
  name: 'video_compress',
  description:
    '压缩视频。mode=quality 按画质档单遍编码；mode=size 按目标体积两遍编码，'
    + '压完会校验体积，超出 5% 会自动降码率重跑一次。',
  inputSchema: {
    type: 'object',
    required: ['inputs', 'mode'],
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 1, description: '要压缩的视频' },
      mode: { type: 'string', enum: ['quality', 'size'], description: 'quality=画质优先；size=目标体积' },
      quality: { type: 'string', enum: QUALITIES, description: 'mode=quality 时的画质档' },
      target_mb: { type: 'number', minimum: 0.1, description: 'mode=size 时的目标体积（MB）' },
      audio_kbps: { type: 'integer', minimum: 0, description: 'mode=size 时给音频预留的码率（0=去声音）' },
      height: { type: 'integer', minimum: 0, description: '目标高度（0=保持原样）' },
      mute: { type: 'boolean', description: '是否去掉声音' },
      output_dir: { type: 'string', description: '可选：输出目录（默认源文件同目录）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const mode = args.mode === 'size' ? 'size' : 'quality';
    if (mode === 'size' && !(Number(args.target_mb) > 0)) throw new Error('mode=size 时必须给 target_mb');
    const outputs = [];
    const warnings = [];
    for (const raw of Array.isArray(args.inputs) ? args.inputs : []) {
      const input = assertFile(raw, '视频');
      const info = await probeOrThrow(input);
      const base = path.basename(input, path.extname(input));
      let plan = buildVideoCompressPlan(info, {
        mode,
        quality: QUALITIES.includes(args.quality) ? args.quality : 'standard',
        targetMB: Number(args.target_mb) || 0,
        audioKbps: Number.isFinite(args.audio_kbps) ? args.audio_kbps : 96,
        height: Number(args.height) || 0,
        mute: !!args.mute
      });

      let res;
      if (plan.mode === 'twoPass') {
        res = await convertTwoPass({
          inputPath: input, outputDir: args.output_dir, baseName: base, ext: plan.ext,
          pass1Args: plan.pass1Args, pass2Args: plan.pass2Args, durationMs: plan.durationMs
        });
        if (!res.ok) throw new Error(res.message);
        let check = verifyTarget({ sizeBytes: res.size, targetMB: Number(args.target_mb) });
        if (!check.ok) {
          // 超出目标：删掉第一份，降码率重跑一次（与 GUI 行为一致）
          try { fs.rmSync(res.path, { force: true }); } catch { /* 删不掉就留着 */ }
          const retry = retryBitrate({ videoKbps: plan.videoKbps });
          const retryPlan = buildVideoCompressPlan(info, {
            mode: 'size', targetMB: Number(args.target_mb),
            audioKbps: Number.isFinite(args.audio_kbps) ? args.audio_kbps : 96,
            mute: !!args.mute, videoKbps: retry
          });
          const retryRes = await convertTwoPass({
            inputPath: input, outputDir: args.output_dir, baseName: base, ext: retryPlan.ext,
            pass1Args: retryPlan.pass1Args, pass2Args: retryPlan.pass2Args, durationMs: retryPlan.durationMs
          });
          if (!retryRes.ok) throw new Error(retryRes.message);
          res = retryRes;
          check = verifyTarget({ sizeBytes: res.size, targetMB: Number(args.target_mb) });
          if (!check.ok) warnings.push(`${base}：重跑后仍超出目标 ${check.overBy} 字节`);
        }
        outputs.push({ input, output: res.path, size: res.size, target_mb: Number(args.target_mb), verified: check.ok });
      } else {
        res = await convertFile({
          inputPath: input, outputDir: args.output_dir, ext: plan.ext,
          args: plan.args, durationMs: plan.durationMs
        });
        if (!res.ok) throw new Error(res.message);
        outputs.push({ input, output: res.path, size: res.size, mode: 'quality' });
      }
    }
    return { ok: true, mode, outputs, warnings };
  }
};

export const stickerTool = {
  name: 'sticker_convert',
  description: '动图与视频互转（GIF / WebP 动图 / APNG ↔ MP4 / WebM），可调帧率、宽度、目标体积。',
  inputSchema: {
    type: 'object',
    required: ['inputs', 'output'],
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 1, description: '动图或视频' },
      output: { type: 'string', enum: OUTPUTS.map((o) => o.value), description: '输出格式' },
      fps: { type: 'integer', minimum: 1, maximum: 60, description: '帧率，默认 15' },
      width: { type: 'integer', minimum: 0, description: '目标宽度（0=保持原样）' },
      height: { type: 'integer', minimum: 0, description: '输出视频时的目标高度' },
      target_mb: { type: 'number', minimum: 0.1, description: '可选：目标体积（MB，超了自动降档）' },
      output_dir: { type: 'string', description: '可选：输出目录' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const output = outputOf(String(args.output || ''));
    const isAnim = isAnimOutput(output.value);
    const outputs = [];
    const warnings = [];
    for (const raw of Array.isArray(args.inputs) ? args.inputs : []) {
      const input = assertFile(raw, '动图/视频');
      const info = await probeOrThrow(input);
      const kind = classifyExt(path.extname(input).toLowerCase(), info);
      if (!kind) throw new Error(`${path.basename(input)}：不是本工具支持的动图/视频`);

      const base = path.basename(input, path.extname(input));
      const baseParams = {
        fps: Number(args.fps) || 15,
        width: Number(args.width) || 0,
        colors: 256,
        loop: 0,
        srcW: info.width,
        srcH: info.height,
        targetHeight: Number(args.height) || 0,
        target: output.value
      };
      const argsFor = (rung) => (isAnim ? animArgs(output.value, rung) : videoArgs({ ...rung, target: output.value }));

      if (Number(args.target_mb) > 0) {
        const ladder = sizeLadder(baseParams, output.value === 'gif');
        let last = null;
        for (let i = 0; i < ladder.length; i += 1) {
          const res = await convertFile({
            inputPath: input, outputDir: args.output_dir, baseName: base,
            ext: output.ext, args: argsFor(ladder[i]), durationMs: info.durationSec * 1000
          });
          if (!res.ok) throw new Error(res.message);
          last = res;
          if (res.size <= Number(args.target_mb) * 1024 * 1024) {
            outputs.push({ input, output: res.path, size: res.size, rung: ladder[i].label, target_mb: Number(args.target_mb), verified: true });
            last = null;
            break;
          }
          try { fs.rmSync(res.path, { force: true }); } catch { /* 忽略 */ }
        }
        if (last) {
          warnings.push(`${base}：降到最低档仍超出目标 ${Number(args.target_mb)} MB`);
          // 最低档的产物已经删了，重跑一次保留下来
          const res = await convertFile({
            inputPath: input, outputDir: args.output_dir, baseName: base,
            ext: output.ext, args: argsFor(ladder[ladder.length - 1]), durationMs: info.durationSec * 1000
          });
          if (!res.ok) throw new Error(res.message);
          outputs.push({ input, output: res.path, size: res.size, rung: ladder[ladder.length - 1].label, target_mb: Number(args.target_mb), verified: false });
        }
      } else {
        const res = await convertFile({
          inputPath: input, outputDir: args.output_dir, baseName: base,
          ext: output.ext, args: argsFor(baseParams), durationMs: info.durationSec * 1000
        });
        if (!res.ok) throw new Error(res.message);
        outputs.push({ input, output: res.path, size: res.size, format: output.value });
      }
    }
    return { ok: true, output: output.value, outputs, warnings };
  }
};

export const audioConvertTool = {
  name: 'audio_convert',
  description: '音频格式转换（21 种输出；视频输入会自动提取声音；保留标题/歌手标签）。',
  inputSchema: {
    type: 'object',
    required: ['inputs', 'target'],
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 1, description: '音频或视频文件' },
      target: { type: 'string', enum: AUDIO_TARGETS.map((t) => t.value), description: '输出格式' },
      quality: { type: 'string', enum: QUALITIES, description: '音质档，默认 standard' },
      output_dir: { type: 'string', description: '可选：输出目录' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const target = audioTargetOf(String(args.target || ''));
    const quality = QUALITIES.includes(args.quality) ? args.quality : 'standard';
    const outputs = [];
    for (const raw of Array.isArray(args.inputs) ? args.inputs : []) {
      const input = assertFile(raw, '音频/视频');
      const info = await probeOrThrow(input);
      const ffArgs = [
        ...(info.hasVideo ? ['-vn'] : []),
        ...audioEncodeArgs(target.value, quality),
        '-map_metadata', '0',
        ...(target.ext === '.mp3' ? ['-id3v2_version', '3'] : [])
      ];
      const res = await convertFile({
        inputPath: input, outputDir: args.output_dir, ext: target.ext,
        args: ffArgs, durationMs: info.durationSec * 1000
      });
      if (!res.ok) throw new Error(res.message);
      outputs.push({ input, output: res.path, size: res.size });
    }
    return { ok: true, target: target.value, quality, outputs };
  }
};

export const audioEditTool = {
  name: 'audio_edit',
  description:
    '音频剪辑：按时间截取、音量调整、淡入淡出；给多个输入时按顺序拼接。'
    + ' target 是输出格式（同 audio_convert 的 21 种）。',
  inputSchema: {
    type: 'object',
    required: ['inputs', 'target'],
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 1, description: '音频或视频文件；多个=按顺序拼接' },
      target: { type: 'string', enum: AUDIO_TARGETS.map((t) => t.value), description: '输出格式' },
      quality: { type: 'string', enum: QUALITIES, description: '音质档，默认 standard' },
      start_ms: { type: 'integer', minimum: 0, description: '截取起点（毫秒）' },
      end_ms: { type: 'integer', minimum: 0, description: '截取终点（毫秒；0=到结尾）' },
      gain_db: {
        oneOf: [{ type: 'number' }, { type: 'string', enum: ['normalize'] }],
        description: '音量：负数变小、正数变大；"normalize"=响度标准化'
      },
      fade_in_ms: { type: 'integer', minimum: 0, description: '淡入时长（毫秒）' },
      fade_out_ms: { type: 'integer', minimum: 0, description: '淡出时长（毫秒）' },
      output_dir: { type: 'string', description: '可选：输出目录' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const target = audioTargetOf(String(args.target || ''));
    const quality = QUALITIES.includes(args.quality) ? args.quality : 'standard';
    const inputs = (Array.isArray(args.inputs) ? args.inputs : []).map((p) => assertFile(p, '音频/视频'));
    if (inputs.length === 0) throw new Error('inputs 不能为空');
    const infos = [];
    for (const input of inputs) infos.push(await probeOrThrow(input));

    if (inputs.length >= 2) {
      const totalMs = infos.reduce((s, i) => s + (i.durationSec * 1000), 0);
      const plan = buildEditPlan(
        { ext: path.extname(inputs[0]).toLowerCase(), isVideo: false, durationMs: totalMs },
        {
          target: target.value,
          quality,
          concatCount: inputs.length,
          segmentDurationsMs: infos.map((i) => i.durationSec * 1000),
          totalDurationMs: totalMs
        }
      );
      const res = await convertMulti({
        inputPaths: inputs,
        outputDir: args.output_dir,
        baseName: '拼接结果',
        ext: plan.ext,
        args: plan.args,
        durationMs: plan.durationMs
      });
      if (!res.ok) throw new Error(res.message);
      return { ok: true, mode: 'concat', output: res.path, size: res.size, inputs: inputs.length };
    }

    const input = inputs[0];
    const info = infos[0];
    const plan = buildEditPlan(
      { ext: path.extname(input).toLowerCase(), isVideo: info.hasVideo, durationMs: info.durationSec * 1000 },
      {
        target: target.value,
        quality,
        startMs: Number(args.start_ms) || 0,
        endMs: Number(args.end_ms) || 0,
        gainDb: args.gain_db === 'normalize' ? 'normalize' : (Number(args.gain_db) || 0),
        fadeInMs: Number(args.fade_in_ms) || 0,
        fadeOutMs: Number(args.fade_out_ms) || 0
      }
    );
    const res = await convertFile({
      inputPath: input,
      outputDir: args.output_dir,
      ext: plan.ext,
      inputArgs: plan.inputArgs,
      args: plan.args,
      durationMs: plan.durationMs
    });
    if (!res.ok) throw new Error(res.message);
    return { ok: true, mode: 'single', output: res.path, size: res.size, target: target.value };
  }
};

export default [
  probeTool, videoConvertTool, videoCompressTool, stickerTool, audioConvertTool, audioEditTool
];
