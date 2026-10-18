// MCP 工具：压缩 / 解压 / 免解压预览
// 直接复用 src/tools/archive/core/{formats,plan,engine}.mjs。
// 引擎查找顺序由 sevenZipStatus 负责：随包 addons/7zip → 系统 PATH → 常见安装目录。
import fs from 'node:fs/promises';
import path from 'node:path';
import fss from 'node:fs';
import { buildCreatePlan, buildExtractPlan } from '../../src/tools/archive/core/plan.mjs';
import {
  sevenZipStatus, createArchive, extractArchive, listArchive,
  uniqueArchivePath, makeTempDir
} from '../../src/tools/archive/core/engine.mjs';
import { portableRoot, assertDir, assertFile } from '../lib/paths.mjs';

const LEVELS = ['store', 'fastest', 'fast', 'normal', 'small', 'extreme'];

async function engineStatus() {
  const status = await sevenZipStatus(portableRoot());
  if (!status.found) {
    throw new Error('未检测到 7-Zip 加装包（把 addons/7zip 放回软件目录）');
  }
  return status;
}

/** 和 GUI 主进程一样：重名时把计划里的产物路径整体改成加序号后的路径 */
function finalizePath(plan) {
  const finalPath = uniqueArchivePath(plan.archivePath);
  if (finalPath === plan.archivePath) return finalPath;
  const oldName = path.basename(plan.archivePath);
  const newName = path.basename(finalPath);
  for (const step of plan.steps) {
    if (step.target === plan.archivePath) step.target = finalPath;
    else if (typeof step.target === 'string' && step.target.endsWith(oldName) && step.action === 'compress') {
      step.target = finalPath;
    }
    if (step.name === oldName) step.name = newName;
  }
  return finalPath;
}

export const createTool = {
  name: 'archive_create',
  description:
    '把文件/文件夹压缩成压缩包。支持 ZIP / 7Z / TAR / GZIP / TAR.GZ / BZIP2 / XZ / '
    + 'ZSTANDARD / BROTLI 等；7Z 与 ZIP 可加密码，ZIP 可用 AES-256，部分格式支持分卷。'
    + '产物重名自动加序号，绝不覆盖已有文件。',
  inputSchema: {
    type: 'object',
    required: ['inputs', 'format', 'output_dir'],
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 1, description: '要压缩的文件/文件夹' },
      format: { type: 'string', description: '格式 id：zip / 7z / tar / gzip / tar.gz / bz2 / xz / zst / br 等' },
      level: { type: 'string', enum: LEVELS, description: '压缩级别，默认 normal' },
      password: { type: 'string', description: '可选：密码（仅 7Z / ZIP）' },
      encrypt: { type: 'string', enum: ['zip-aes256', 'zipcrypto'], description: 'ZIP 加密方案，默认 zip-aes256' },
      volume_bytes: { type: 'integer', minimum: 0, description: '可选：分卷大小（字节，0=不分卷）' },
      output_dir: { type: 'string', description: '压缩包输出目录' },
      base_name: { type: 'string', description: '可选：压缩包文件名（不含扩展名）' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const status = await engineStatus();
    const outputDir = assertDir(args.output_dir, '输出目录');
    const inputs = [];
    for (const p of Array.isArray(args.inputs) ? args.inputs : []) {
      const abs = path.resolve(String(p || ''));
      let st;
      try {
        st = fss.statSync(abs);
      } catch {
        throw new Error(`输入不存在：${abs}`);
      }
      inputs.push({ path: abs, isDirectory: st.isDirectory() });
    }
    if (inputs.length === 0) throw new Error('inputs 不能为空');

    const tempDir = await makeTempDir('mcp');
    try {
      const plan = buildCreatePlan({
        inputs,
        formatId: String(args.format || ''),
        level: args.level || 'normal',
        password: String(args.password || ''),
        encrypt: args.encrypt === 'zipcrypto' ? 'zipcrypto' : 'zip-aes256',
        volumeBytes: Number(args.volume_bytes) || 0,
        outputDir,
        baseName: args.base_name || undefined,
        tempDir
      });
      if (!plan.ok) throw new Error(plan.message || '压缩参数不合法');

      const finalPath = finalizePath(plan);
      const res = await createArchive({
        steps: plan.steps,
        archivePath: finalPath,
        binPath: status.path,
        onProgress: () => {}
      });
      if (!res.ok) throw new Error(res.message || '压缩失败');
      return {
        ok: true,
        output: res.paths,
        size: res.size,
        input_bytes: res.inputBytes,
        format: args.format,
        ms: res.ms
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
};

export const extractTool = {
  name: 'archive_extract',
  description:
    '解压压缩包（支持 RAR / ZIP / 7Z / TAR / GZ / BZ2 / XZ / ZSTD / BROTLI / ISO 等；'
    + 'RAR 等专有格式仅解压）。可带密码；默认跳过已存在文件，保留目录结构。'
    + '每个压缩包解到输出目录下的同名子目录。',
  inputSchema: {
    type: 'object',
    required: ['archives', 'output_dir'],
    properties: {
      archives: { type: 'array', items: { type: 'string' }, minItems: 1, description: '压缩包路径列表' },
      output_dir: { type: 'string', description: '解压输出目录' },
      password: { type: 'string', description: '可选：压缩包密码' },
      overwrite: { type: 'string', enum: ['skip', 'replace'], description: '同名文件策略，默认 skip' },
      tree: { type: 'string', enum: ['keep', 'flatten'], description: '目录结构，默认 keep' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const status = await engineStatus();
    const outputDir = assertDir(args.output_dir, '输出目录');
    const archives = (Array.isArray(args.archives) ? args.archives : []).map((p) => {
      const abs = assertFile(p, '压缩包');
      return { path: abs, name: path.basename(abs), ext: path.extname(abs).toLowerCase() };
    });
    const plan = buildExtractPlan({
      archives,
      outputDir,
      password: String(args.password || ''),
      overwrite: args.overwrite === 'replace' ? 'replace' : 'skip',
      tree: args.tree === 'flatten' ? 'flatten' : 'keep'
    });
    if (!plan.ok) throw new Error(plan.message || '解压参数不合法');

    const res = await extractArchive({
      steps: plan.steps,
      binPath: status.path,
      onProgress: () => {}
    });
    if (!res.ok) throw new Error(res.message || '解压失败');
    return {
      ok: true,
      dirs: res.dirs,
      files: res.files,
      ms: res.ms
    };
  }
};

export const listTool = {
  name: 'archive_list',
  description: '不解压、只列出压缩包内容（条目、体积、是否加密、可疑路径）。用于预览或解压前检查。',
  inputSchema: {
    type: 'object',
    required: ['archive'],
    properties: {
      archive: { type: 'string', description: '压缩包路径' },
      password: { type: 'string', description: '可选：压缩包密码' }
    },
    additionalProperties: false
  },
  async handler(args = {}) {
    const status = await engineStatus();
    const archive = assertFile(args.archive, '压缩包');
    const res = await listArchive({
      archivePath: archive,
      password: String(args.password || ''),
      binPath: status.path
    });
    if (!res.ok) throw new Error(res.message || '读取压缩包失败');
    return {
      ok: true,
      entries: res.entries,
      summary: res.summary,
      meta: res.meta,
      suspicious: res.suspicious
    };
  }
};

export default [createTool, extractTool, listTool];
