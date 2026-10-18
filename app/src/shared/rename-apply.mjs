// 批量重命名的「真正落盘」逻辑（两阶段改名）
//
// 为什么单独成文件：这段逻辑原来内联在 main.js 的 `fs:rename-batch` handler 里。
// MCP 是独立 Node 进程，不能走 Electron IPC；把它抽出来后，GUI 与 MCP 可以共用同一套
// 两阶段语义（先全部改成临时名，再改成最终名），避免「链式改名/互换名」互相踩。
//
// 安全约定（与 GUI 一致）：
//   · 默认绝不覆盖已存在文件；只有该条显式 overwrite:true 才走「备份 → 覆盖 → 删备份」；
//   · 跨盘（EXDEV）自动回退为「复制 + 删源」；
//   · 任何一步失败都尽力把临时名/备份还原，避免文件消失。
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

/**
 * @param {Array<{from:string,to:string,overwrite?:boolean}>} renames
 * @returns {Promise<{ok:boolean,done:number,failed:Array<{from:string,to:string,message:string}>,overwritten:number}>}
 */
export async function applyRenamePlan(renames) {
  const list = (Array.isArray(renames) ? renames : []).filter((r) => r && r.from && r.to);
  if (list.length === 0) return { ok: true, done: 0, failed: [], overwritten: 0 };

  const sources = new Set(list.map((r) => path.resolve(r.from)));
  const failed = [];
  const stage1 = [];
  const stamp = Date.now();

  // 阶段 1：源文件 → 同目录临时名
  for (let i = 0; i < list.length; i += 1) {
    const { from, to, overwrite } = list[i];
    const src = path.resolve(from);
    const dst = path.resolve(to);
    try {
      const st = await fs.stat(src);
      if (st.isDirectory()) throw new Error('是文件夹，已跳过');
      if (dst !== src && !sources.has(dst) && fsSync.existsSync(dst) && !overwrite) {
        throw new Error('目标文件已存在');
      }
      const tmp = path.join(path.dirname(src), `.tomato-rename-${stamp}-${i}`);
      await fs.rename(src, tmp);
      stage1.push({ tmp, dst, from, to, i, overwrite: !!overwrite });
    } catch (err) {
      failed.push({ from, to, message: String((err && err.message) || err) });
    }
  }

  // 阶段 2：临时名 → 最终名
  let done = 0;
  let overwritten = 0;
  for (const item of stage1) {
    let bak = null;
    try {
      if (item.overwrite && fsSync.existsSync(item.dst)) {
        bak = path.join(path.dirname(item.dst), `.tomato-rename-bak-${stamp}-${item.i}`);
        await fs.rename(item.dst, bak);
      }
      await fs.rename(item.tmp, item.dst);
      if (bak) {
        await fs.rm(bak, { force: true });
        bak = null;
        overwritten += 1;
      }
      done += 1;
    } catch {
      // 跨盘等情况：回退为复制 + 删源
      try {
        await fs.copyFile(item.tmp, item.dst);
        await fs.rm(item.tmp, { force: true });
        if (bak) {
          await fs.rm(bak, { force: true });
          bak = null;
          overwritten += 1;
        }
        done += 1;
      } catch (err2) {
        failed.push({ from: item.from, to: item.to, message: String((err2 && err2.message) || err2) });
        try { await fs.rename(item.tmp, item.from); } catch { /* 还原失败只能如实报告 */ }
        if (bak) { try { await fs.rename(bak, item.dst); } catch { /* 同上 */ } }
      }
    }
  }

  return { ok: failed.length === 0, done, failed, overwritten };
}
