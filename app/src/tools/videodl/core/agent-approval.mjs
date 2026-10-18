// 视频下载 · Agent 授权闸门（纯 Node，GUI 与 MCP 共用）
//
// 设计目标：让「AI 能不能下载」由用户在软件里决定，而不是靠 agent 自觉。
// 做法：GUI 写授权文件，MCP 只读；agent 没有任何 MCP 工具能改这个文件。
//
// 两种授权：
//   session —— 「本次运行免确认」：在软件里打开开关后，一段时间内 agent 可直接下载；
//   once    —— 「允许一次」：只放行下一次下载，用完即焚。
//
// 文件位置：软件目录的 userdata/videodl-agent-approvals.json（绿色版约定，随软件搬走）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const FILE_NAME = 'videodl-agent-approvals.json';

/** 本次运行免确认的默认有效期（8 小时；软件退出时 GUI 会主动撤销） */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** 「允许一次」的有效期（5 分钟；够 agent 收到授权后马上重试） */
export const ONCE_TTL_MS = 5 * 60 * 1000;

export function approvalFile(userdataDir) {
  return path.join(String(userdataDir || ''), FILE_NAME);
}

/** 读授权；文件不存在/损坏都返回空授权（绝不因为坏文件把下载永久锁死） */
export function readApprovals(userdataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(approvalFile(userdataDir), 'utf8'));
    const now = Date.now();
    return {
      sessionUntil: Number(raw && raw.sessionUntil) > now ? Number(raw.sessionUntil) : 0,
      onceUntil: Number(raw && raw.onceUntil) > now ? Number(raw.onceUntil) : 0,
      updatedAt: Number(raw && raw.updatedAt) || 0
    };
  } catch {
    return { sessionUntil: 0, onceUntil: 0, updatedAt: 0 };
  }
}

/** 原子写授权文件 */
export async function writeApprovals(userdataDir, data) {
  const file = approvalFile(userdataDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    sessionUntil: Number(data && data.sessionUntil) || 0,
    onceUntil: Number(data && data.onceUntil) || 0,
    updatedAt: Date.now()
  };
  try {
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return payload;
}

/** 开启「本次运行免确认」 */
export async function grantSession(userdataDir, ttlMs = SESSION_TTL_MS) {
  const cur = readApprovals(userdataDir);
  return writeApprovals(userdataDir, {
    sessionUntil: Date.now() + Math.max(60_000, Number(ttlMs) || SESSION_TTL_MS),
    onceUntil: cur.onceUntil
  });
}

/** 开启「允许一次」 */
export async function grantOnce(userdataDir, ttlMs = ONCE_TTL_MS) {
  const cur = readApprovals(userdataDir);
  return writeApprovals(userdataDir, {
    sessionUntil: cur.sessionUntil,
    onceUntil: Date.now() + Math.max(60_000, Number(ttlMs) || ONCE_TTL_MS)
  });
}

/** 撤销全部授权（用户关掉开关 / 软件退出时调用） */
export async function revokeAll(userdataDir) {
  return writeApprovals(userdataDir, { sessionUntil: 0, onceUntil: 0 });
}

/**
 * 检查当前是否允许 agent 下载。
 * 注意：once 是一次性的——检查通过后立刻清掉，避免被重复使用。
 * @returns {Promise<{ok:boolean, mode:'session'|'once'|'none', sessionUntil:number}>}
 */
export async function checkApproval(userdataDir, now = Date.now()) {
  const cur = readApprovals(userdataDir);
  if (cur.sessionUntil > now) {
    return { ok: true, mode: 'session', sessionUntil: cur.sessionUntil };
  }
  if (cur.onceUntil > now) {
    await writeApprovals(userdataDir, { sessionUntil: 0, onceUntil: 0 });
    return { ok: true, mode: 'once', sessionUntil: 0 };
  }
  return { ok: false, mode: 'none', sessionUntil: 0 };
}

/** 给界面看的状态（不消费 once） */
export function approvalStatus(userdataDir, now = Date.now()) {
  const cur = readApprovals(userdataDir);
  return {
    session: cur.sessionUntil > now,
    sessionUntil: cur.sessionUntil,
    once: cur.onceUntil > now,
    onceUntil: cur.onceUntil
  };
}
