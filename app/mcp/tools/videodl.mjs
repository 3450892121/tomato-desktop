// MCP 工具：视频下载（受限——必须先拿到用户在软件里的授权）
//
// 授权不是「agent 在聊天里问一句」：那样 agent 可以撒谎。
// 真正的闸门是 src/tools/videodl/core/agent-approval.mjs：
//   · 用户在软件「视频下载」页打开「允许 AI 助手直接下载（本次运行有效）」→ 写 session 授权；
//   · 或点「允许一次」→ 写一次性授权（5 分钟）；
//   · 没有任何 MCP 工具能改这个文件。
//
// 本工具只读授权文件；拿不到就返回 NEEDS_APPROVAL，不产生任何下载。
import fs from 'node:fs';
import path from 'node:path';
import { appRoot } from '../lib/paths.mjs';
import { checkApproval } from '../../src/tools/videodl/core/agent-approval.mjs';

function userdataDir() {
  const override = process.env.TOMATO_USERDATA_DIR;
  if (override) return path.resolve(override);
  const dev = path.join(appRoot(), 'userdata');
  // 打包态：appRoot = <软件目录>/resources/app，userdata 在 <软件目录>/userdata
  const packaged = path.join(path.dirname(path.dirname(appRoot())), 'userdata');
  if (fs.existsSync(dev)) return dev;
  if (fs.existsSync(packaged)) return packaged;
  return dev;
}

function findFfmpeg() {
  const addon = path.join(appRoot(), 'addons', 'ffmpeg', 'ffmpeg.exe');
  if (fs.existsSync(addon)) return addon;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'ffmpeg.exe');
    if (fs.existsSync(p)) return p;
  }
  return '';
}

let managerPromise = null;
function getManager() {
  if (!managerPromise) {
    managerPromise = import('../../src/tools/videodl/core/manager.mjs').then(({ createVideoDownloader }) => {
      const ffmpegPath = findFfmpeg();
      return createVideoDownloader({
        addonsRoot: path.join(appRoot(), 'addons'),
        toolRoot: path.join(appRoot(), 'src', 'tools', 'videodl'),
        userdataDir: userdataDir(),
        ffmpegPath,
        onChanged: () => {}
      });
    });
  }
  return managerPromise;
}

export const downloadTool = {
  name: 'video_download',
  description:
    '下载网络视频（抖音/小红书/B站/YouTube/央视频/直链）。**必须先由用户在软件「视频下载」页授权**：'
    + '没授权时返回 NEEDS_APPROVAL，不会下载任何东西。授权方式：打开「允许 AI 助手直接下载（本次运行有效）」，'
    + '或点「允许一次」。下载完成后会校验成品必须有画面和声音，且文件必须在指定目录内。',
  inputSchema: {
    type: 'object',
    required: ['url', 'output_dir'],
    properties: {
      url: { type: 'string', description: '视频网页地址，或 MP4/M3U8/MPD 直链' },
      output_dir: { type: 'string', description: '保存目录（必须是绝对路径且可写）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const url = String(args.url || '').trim();
    const outputDir = String(args.output_dir || '').trim();
    if (!url) throw new Error('缺少 url');
    if (!outputDir || !path.isAbsolute(outputDir)) throw new Error('output_dir 必须是绝对路径');

    const approval = await checkApproval(userdataDir());
    if (!approval.ok) {
      return {
        ok: false,
        code: 'NEEDS_APPROVAL',
        message: '用户还没有授权这次下载。请打开软件「视频下载」页，点「允许一次」'
          + '或打开「允许 AI 助手直接下载（本次运行有效）」，然后重试。',
        approval: { mode: 'none' }
      };
    }

    if (!findFfmpeg()) {
      throw new Error('未检测到 ffmpeg 加装包（下载后合并音视频与成品校验需要它）');
    }

    const manager = await getManager();
    const job = await manager.start(url, outputDir);
    return {
      ok: true,
      job,
      approval: { mode: approval.mode },
      message: '已开始下载。用 video_download_status 查询进度。'
    };
  }
};

export const statusTool = {
  name: 'video_download_status',
  description: '查询视频下载任务的状态（全部任务；可按 job_id 过滤）。不需要授权。',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: '可选：只看这一条任务' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const manager = await getManager();
    const list = manager.list();
    if (args.job_id) {
      const job = list.find((j) => j.id === args.job_id);
      if (!job) throw new Error(`没有找到任务：${args.job_id}`);
      return { ok: true, job };
    }
    return { ok: true, jobs: list };
  }
};

export const cancelTool = {
  name: 'video_download_cancel',
  description: '取消一个正在下载的视频任务。不需要授权。',
  inputSchema: {
    type: 'object',
    required: ['job_id'],
    properties: { job_id: { type: 'string', description: '任务 id（video_download 返回的 job.id）' } },
    additionalProperties: false
  },
  async handler(args = {}) {
    const manager = await getManager();
    const ok = manager.cancel(String(args.job_id || ''));
    return { ok, canceled: ok, job_id: args.job_id };
  }
};

export default [downloadTool, statusTool, cancelTool];
