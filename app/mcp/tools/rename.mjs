// MCP 工具：批量重命名
// 规则计算复用 src/tools/batch-rename/core/plan.js；落盘复用 src/shared/rename-apply.mjs。
// 默认 dry_run=true：先给预览，agent 确认后再真正改名。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildRenamePlan, sortItems, RENAME_MODES, SORT_MODES } from '../../src/tools/batch-rename/core/plan.js';
import { applyRenamePlan } from '../../src/shared/rename-apply.mjs';
import { assertAllowed } from '../lib/paths.mjs';

async function normalizeItems(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const p = typeof item === 'string' ? item : (item && item.path);
    if (!p) continue;
    const abs = assertAllowed(p, '重命名文件');
    let mtimeMs = item && Number(item.mtimeMs);
    if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) {
      try { mtimeMs = (await fsp.stat(abs)).mtimeMs; } catch { mtimeMs = 0; }
    }
    out.push({ path: abs, mtimeMs });
  }
  return out;
}

async function collectExisting(items) {
  const dirs = new Set(items.map((it) => path.dirname(it.path)));
  const existing = [];
  for (const dir of dirs) {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { names = []; }
    for (const name of names) existing.push(path.join(dir, name));
  }
  return existing;
}

export default {
  name: 'file_rename_batch',
  description:
    '按规则批量重命名文件（序号 / 查找替换 / 前后缀 / 按日期），支持按修改时间排序与三种冲突策略。'
    + ' **默认 dry_run=true，只返回预览不改名**；确认后传 dry_run=false 才真正落盘。'
    + ' 默认绝不覆盖已有文件；只有 conflict="overwrite" 时才走「备份 → 覆盖 → 删备份」。',
  inputSchema: {
    type: 'object',
    required: ['items', 'rule'],
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              required: ['path'],
              properties: { path: { type: 'string' }, mtimeMs: { type: 'number' } },
              additionalProperties: false
            }
          ]
        },
        description: '要改名的文件路径（可带 mtimeMs）'
      },
      rule: {
        type: 'object',
        description:
          '规则：{mode:"seq",prefix,start,digits,keepName} / '
          + '{mode:"replace",find,replace,useRegex} / {mode:"affix",prefix,suffix} / '
          + '{mode:"date",pattern}；pattern 支持 YYYY MM DD HH mm ss',
        properties: {
          mode: { type: 'string', enum: RENAME_MODES.map((m) => m.value) },
          prefix: { type: 'string' },
          suffix: { type: 'string' },
          start: { type: 'integer' },
          digits: { type: 'integer', minimum: 1, maximum: 8 },
          keepName: { type: 'boolean' },
          find: { type: 'string' },
          replace: { type: 'string' },
          useRegex: { type: 'boolean' },
          pattern: { type: 'string' }
        },
        additionalProperties: false
      },
      sort: { type: 'string', enum: SORT_MODES.map((m) => m.value), description: '排序方式，默认 none' },
      conflict: { type: 'string', enum: ['skip', 'auto'], description: '冲突策略：跳过或自动编号；MCP 侧不允许覆盖' },
      dry_run: { type: 'boolean', description: '默认 true；false 才真正改名' }
    },
    additionalProperties: false
  },

  async handler(args = {}) {
    if (args.conflict === 'overwrite') {
      throw new Error('MCP 侧不允许覆盖已有文件；需要覆盖请在软件界面里操作');
    }
    const items = await normalizeItems(args.items);
    if (items.length === 0) throw new Error('items 不能为空');
    const sorted = sortItems(items, args.sort || 'none');
    const existing = await collectExisting(sorted);
    const conflict = args.conflict === 'auto' ? 'auto' : 'skip';
    const plan = buildRenamePlan({
      items: sorted,
      rule: args.rule || {},
      existingPaths: existing,
      conflictMode: conflict
    });

    const dryRun = args.dry_run !== false;
    const summary = {
      dry_run: dryRun,
      planned: plan.okCount,
      skipped: plan.skipCount,
      errors: plan.errorCount,
      overwrite: plan.overwriteCount,
      auto_renamed: plan.autoCount,
      conflict_mode: plan.conflictMode,
      previews: plan.previews,
      renames: plan.renames
    };

    if (dryRun) return { ok: true, ...summary, applied: null };

    const applied = await applyRenamePlan(plan.renames);
    return {
      ok: applied.ok,
      ...summary,
      applied,
      message: applied.ok ? '' : `有 ${applied.failed.length} 个改名失败，详见 applied.failed`
    };
  }
};
