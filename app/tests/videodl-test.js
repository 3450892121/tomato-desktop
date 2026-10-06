// 视频下载 · 引擎自检（在主进程里跑；`electron . --videodl-test`）
// 思路：下载源用「本地小服务器 + ffmpeg 现造的小 MP4」——真实走完 yt-dlp/ffmpeg 全链路，
// 但不依赖外网，结果可重复；只有「引擎更新检查」一项需要联网，失败如实记 skipped 且不计通过。
// 判定：ok = 跑过的项全过；verified = ok 且没有任何项被跳过（交付前要求 verified:true）。
// 结果落盘：%TEMP%\tomato-videodl-test.json
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const RESULTS_FILE = path.join(os.tmpdir(), 'tomato-videodl-test.json');

function writeResults(payload) {
  try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(payload, null, 2)); } catch { /* 写不进去也要退出 */ }
}

function waitFor(condition, { timeoutMs = 20000, intervalMs = 200, label = '条件' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      Promise.resolve()
        .then(condition)
        .then((value) => {
          if (value) { clearInterval(timer); resolve(value); }
          else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`等待${label}超时`)); }
        })
        .catch((err) => { clearInterval(timer); reject(err); });
    }, intervalMs);
  });
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeFfmpegFixture(ffmpegPath, outFile) {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outFile
    ], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg 退出码 ${code}`))));
  });
}

/** 起一个本地小服务器：/video.mp4 正常回、/slow.mp4 慢速回（用于取消） */
function startServer(fixtureFile) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/video.mp4')) {
      const size = fs.statSync(fixtureFile).size;
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
      fs.createReadStream(fixtureFile).pipe(res);
      return;
    }
    if (req.url.startsWith('/slow.mp4')) {
      const size = fs.statSync(fixtureFile).size;
      const total = size * 40; // 约 10 秒发完（250ms 一块），足够在中途点取消
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': total });
      const chunk = fs.readFileSync(fixtureFile);
      let sent = 0;
      const timer = setInterval(() => {
        if (res.writableEnded) { clearInterval(timer); return; }
        res.write(chunk);
        sent += chunk.length;
        if (sent >= total) { clearInterval(timer); res.end(); }
      }, 250);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runVideodlTest(_win, { portableDir } = {}) {
  const checks = {};
  const failures = [];
  const skipped = [];
  const record = (name, ok, detail) => {
    checks[name] = { ok: Boolean(ok), detail: String(detail || '') };
    if (!ok) failures.push(`${name}：${detail}`);
  };
  const skip = (name, reason) => { checks[name] = { ok: false, skipped: true, detail: reason }; skipped.push(`${name}：${reason}`); };

  const root = portableDir || path.join(__dirname, '..');
  const addonsRoot = path.join(root, 'addons');
  const toolRoot = path.join(__dirname, '..', 'src', 'tools', 'videodl');
  const ffmpegPath = path.join(addonsRoot, 'ffmpeg', 'ffmpeg.exe');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'videodl-selftest-'));
  const saveDir = path.join(tempRoot, '保存');
  fs.mkdirSync(saveDir, { recursive: true });

  const proxyBackup = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY };
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;

  let server = null;
  try {
    const { createVideoDownloader } = await import(pathToFileURL(path.join(toolRoot, 'core', 'manager.mjs')).href);
    const { PINNED_ENGINE } = await import(pathToFileURL(path.join(toolRoot, 'core', 'engine-update.mjs')).href);

    // 1) 加装包与引擎文件
    const ytdlpExe = path.join(addonsRoot, 'ytdlp', 'yt-dlp.exe');
    if (fs.existsSync(ytdlpExe)) {
      const sha = sha256File(ytdlpExe);
      record('加装包指纹', sha === PINNED_ENGINE.sha256,
        sha === PINNED_ENGINE.sha256 ? `与记录一致（${PINNED_ENGINE.version}）` : `不一致：实际 ${sha.slice(0, 16)}…，记录 ${PINNED_ENGINE.sha256.slice(0, 16)}…`);
    } else {
      record('加装包指纹', false, `未找到 ${ytdlpExe}`);
    }
    record('B站插件在位', fs.existsSync(path.join(toolRoot, 'plugins', 'leetools', 'yt_dlp_plugins', 'extractor', 'leetools_bilibili.py')), 'plugins/leetools/…/leetools_bilibili.py');
    record('ffmpeg 加装包', fs.existsSync(ffmpegPath), fs.existsSync(ffmpegPath) ? ffmpegPath : `未找到 ${ffmpegPath}`);
    if (fs.existsSync(path.join(addonsRoot, 'ytdlp', 'node', 'node.exe'))) {
      record('YouTube 运行时（可选）', true, 'node.exe 在位');
    } else {
      checks['YouTube 运行时（可选）'] = { ok: true, detail: '未随包（YouTube 之外的站点不受影响）' };
    }

    // 2) 造夹具 + 本地服务器
    const fixture = path.join(tempRoot, 'fixture.mp4');
    await makeFfmpegFixture(ffmpegPath, fixture);
    record('夹具生成', fs.existsSync(fixture) && fs.statSync(fixture).size > 1000, `本地 MP4 ${fs.statSync(fixture).size} 字节`);
    server = await startServer(fixture);
    const port = server.address().port;
    const videoUrl = `http://127.0.0.1:${port}/video.mp4`;
    const slowUrl = `http://127.0.0.1:${port}/slow.mp4`;

    // 3) 引擎状态（随包版可用）
    const userdataA = path.join(tempRoot, 'userdata-a');
    const manager = createVideoDownloader({ addonsRoot, toolRoot, userdataDir: userdataA, ffmpegPath, onChanged: () => {} });
    const status = manager.engineStatus();
    record('引擎解析', Boolean(status.engine), status.engine ? `${status.engine.version}（${status.engine.source}）` : '未解析到引擎');

    // 4) 真实下载（yt-dlp + ffmpeg 合并校验 + 历史落盘）
    let maxPct = 0;
    const poll = setInterval(() => {
      const job = manager.list().find((j) => j.status === 'running');
      if (job && job.pct > maxPct) maxPct = job.pct;
    }, 150);
    const started = await manager.start(videoUrl, saveDir);
    const done = await waitFor(() => {
      const job = manager.list().find((j) => j.id === started.id);
      return job && job.status !== 'running' ? job : null;
    }, { timeoutMs: 90000, label: '本地下载完成' });
    clearInterval(poll);
    record('本地直链下载', done.status === 'done' && done.file && fs.existsSync(done.file),
      `status=${done.status} file=${done.file || ''} err=${done.err || ''}`);
    if (done.file && fs.existsSync(done.file)) {
      const streams = await manager.inspectMedia(done.file);
      record('成品音视频校验', streams.video && streams.audio, `container=${streams.container}`);
      record('进度出现过', maxPct > 0 || done.status === 'done', `maxPct=${maxPct.toFixed(1)}`);
    }
    const historyFile = path.join(userdataA, 'videodl-history.json');
    record('历史落盘', fs.existsSync(historyFile) && fs.readFileSync(historyFile, 'utf8').includes(started.id), historyFile);
    const managerReload = createVideoDownloader({ addonsRoot, toolRoot, userdataDir: userdataA, ffmpegPath, onChanged: () => {} });
    record('历史重启可读', managerReload.list().some((j) => j.id === started.id), '新实例 list() 含该任务');

    // 5) 取消（慢速下载中途取消：进程终止、半成品清理、不留垃圾）
    const cancelStarted = await manager.start(slowUrl, saveDir);
    await waitFor(() => {
      const job = manager.list().find((j) => j.id === cancelStarted.id);
      return job && job.pct > 0 ? job : null;
    }, { timeoutMs: 30000, label: '慢速下载出现进度' });
    manager.cancel(cancelStarted.id);
    const cancelled = await waitFor(() => {
      const job = manager.list().find((j) => j.id === cancelStarted.id);
      return job && job.status !== 'running' ? job : null;
    }, { timeoutMs: 30000, label: '取消生效' });
    const tempDir = path.join(saveDir, '.视频下载临时');
    const leftovers = fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : [];
    const partFiles = fs.readdirSync(saveDir).filter((f) => f.endsWith('.part'));
    record('取消与清理', cancelled.status === 'cancelled' && leftovers.length === 0 && partFiles.length === 0,
      `status=${cancelled.status} 临时目录残留=${leftovers.length} part 残留=${partFiles.length}`);
    // 取消后再下一次同一链接：应能正常完成
    const again = await manager.start(videoUrl, saveDir);
    const againDone = await waitFor(() => {
      const job = manager.list().find((j) => j.id === again.id);
      return job && job.status !== 'running' ? job : null;
    }, { timeoutMs: 90000, label: '取消后重下完成' });
    record('取消后可继续下载', againDone.status === 'done', `status=${againDone.status} err=${againDone.err || ''}`);

    // 6) 错误路径：连不上的地址给可读错误
    const badPort = port === 1 ? 2 : port + 1000;
    const badStarted = await manager.start(`http://127.0.0.1:${badPort}/nope.mp4`, saveDir);
    const badDone = await waitFor(() => {
      const job = manager.list().find((j) => j.id === badStarted.id);
      return job && job.status !== 'running' ? job : null;
    }, { timeoutMs: 150000, label: '错误任务收敛' });
    record('无效地址报错', badDone.status === 'error' && Boolean(badDone.err), `status=${badDone.status} err=${badDone.err || ''}`);

    // 7) 缺包降级：空的 addons 目录 → 明确提示、不崩
    const emptyAddons = path.join(tempRoot, 'addons-empty');
    fs.mkdirSync(emptyAddons, { recursive: true });
    const managerNoEngine = createVideoDownloader({ addonsRoot: emptyAddons, toolRoot, userdataDir: path.join(tempRoot, 'userdata-b'), ffmpegPath: '', onChanged: () => {} });
    record('缺包降级-引擎状态', managerNoEngine.engineStatus().engine === null, '空 addons → engine=null');
    const noEngineStarted = await managerNoEngine.start(videoUrl, saveDir);
    const noEngineDone = await waitFor(() => {
      const job = managerNoEngine.list().find((j) => j.id === noEngineStarted.id);
      return job && job.status !== 'running' ? job : null;
    }, { timeoutMs: 20000, label: '缺包任务收敛' });
    record('缺包降级-任务提示', noEngineDone.status === 'error' && /下载引擎/.test(noEngineDone.err || ''), `err=${noEngineDone.err || ''}`);

    // 8) 引擎更新检查（需要联网；失败如实记 skipped，不静默当通过）
    try {
      const check = await manager.checkEngine({ force: true });
      if (check && check.ok) {
        record('引擎更新检查', Boolean(check.latest && check.latest.version), `官方最新 ${check.latest ? check.latest.version : '(缓存)'}`);
      } else {
        skip('引擎更新检查', `联网检查失败：${(check && check.error) || '未知原因'}`);
      }
    } catch (error) {
      skip('引擎更新检查', `联网检查异常：${error.message}`);
    }
    // 9) 引擎更新全链路（真实下载 + 校验 + 安装 + 生效；约 16MB，需要联网）
    //    默认就跑：这条是本工具「网站改版后能自救」的关键能力，不能靠环境变量才验。
    //    只有显式设 VIDEODL_TEST_SKIP_UPDATE=1 才跳过；联网失败如实记 skipped（不计通过）。
    if (process.env.VIDEODL_TEST_SKIP_UPDATE === '1') {
      skip('引擎更新全链路', '按 VIDEODL_TEST_SKIP_UPDATE=1 跳过');
    } else {
      try {
        const update = await manager.updateEngine();
        if (update && update.ok) {
          record('引擎更新全链路', true, `已更新到 ${update.version}（下载 + SHA-256 校验 + 装到 userdata + 生效）`);
          const after = manager.engineStatus();
          record('更新后引擎生效', after.engine && after.engine.source === 'updated' && after.engine.version === update.version,
            `${after.engine ? after.engine.version : 'null'}（${after.engine ? after.engine.source : ''}）`);
        } else if (update && /已是最新版本/.test(update.error || '')) {
          record('引擎更新全链路', true, '随包版已是官方最新，无需更新');
        } else {
          skip('引擎更新全链路', `联网更新失败：${(update && update.error) || '未知原因'}`);
        }
      } catch (error) {
        skip('引擎更新全链路', `联网更新异常：${error.message}`);
      }
    }

    manager.stopAll();
    managerNoEngine.stopAll();
  } catch (error) {
    record('自检执行', false, `${error.message}\n${error.stack || ''}`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (proxyBackup.http !== undefined) process.env.HTTP_PROXY = proxyBackup.http;
    if (proxyBackup.https !== undefined) process.env.HTTPS_PROXY = proxyBackup.https;
    try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 留给系统清 */ }
  }

  const ok = failures.length === 0;
  const result = { ok, verified: ok && skipped.length === 0, skipped, failures, checks, at: new Date().toISOString() };
  writeResults(result);
  return result;
}

module.exports = { runVideodlTest, writeResults, RESULTS_FILE };
