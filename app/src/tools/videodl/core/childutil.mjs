// 子进程通用封装：fork 解析器脚本（Electron 下走 ELECTRON_RUN_AS_NODE 充当 Node）、杀进程树、取消解析器。
// 上游 leetools 用 spawn(自带 node.exe)；本项目用 fork + IPC（Electron 主进程标准做法，取消走 IPC 消息）。
import fs from 'node:fs';
import { fork, spawnSync } from 'node:child_process';

export function forkNode(scriptPath, args) {
  return fork(scriptPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

export function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } else { child.kill(); }
  } catch { try { child.kill(); } catch {} }
}

export function cancelResolver(child) {
  if (child.connected) { try { child.send('cancel', () => {}); } catch {} }
  else killProcessTree(child);
  const kill = setTimeout(() => { if (child.exitCode === null) killProcessTree(child); }, 15000);
  kill.unref();
}

/**
 * 跑一个「解析器子进程」并等它输出一行 JSON。
 * job 上挂 _killResolver 供用户取消；超时/数据异常/非零退出都转成可读错误。
 */
export function runChildJson(job, { script, args, timeoutMs, tag, onSpawn }) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(script)) return reject(new Error(`${tag}组件不可用`));
    const child = forkNode(script, args);
    job._killResolver = () => cancelResolver(child);
    onSpawn?.(child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      job._killResolver = null;
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { cancelResolver(child); finish(new Error(`${tag}解析超时`)); }, timeoutMs);
    child.stdout.on('data', (data) => {
      stdout += data.toString('utf8');
      if (stdout.length > 1024 * 1024) { cancelResolver(child); finish(new Error(`${tag}返回数据异常`)); }
    });
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString('utf8')).slice(-600); });
    child.on('error', (error) => finish(new Error(`${tag}启动失败：${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (job.cancelRequested) return finish(new Error('已取消'));
      if (code !== 0) return finish(new Error(stderr.trim() || `${tag}没有取得播放地址`));
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(new Error(`${tag}返回的数据无效`)); }
    });
  });
}
