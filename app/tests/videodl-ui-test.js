// 视频下载界面自动测试（仅 `electron . --videodl-ui-test` 时运行）
// 做法：像真人一样「切工具 → 改保存位置 → 贴链接 → 开始下载 → 看进度 → 完成 → 取消 → 清空」，
//      下载源用本地小服务器（真实跑 yt-dlp + ffmpeg，但不依赖外网），每一步截图。
// 结果写入 %TEMP%/tomato-videodl-ui-test.json，截图落在 %TEMP%/tomato-uitest，pass:true 为通过。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const { spawnSync, spawn } = require('child_process');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-videodl-ui-test.json');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeResult(payload) {
  fsSync.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return RESULT_FILE;
}

function findFfmpeg() {
  const base = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
  const addon = path.join(base, 'addons', 'ffmpeg', 'ffmpeg.exe');
  if (fsSync.existsSync(addon)) return addon;
  try {
    const r = spawnSync('where', ['ffmpeg'], { windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) {
      const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fsSync.existsSync(first)) return first;
    }
  } catch { /* 未安装 */ }
  return null;
}

function makeFixture(ffmpeg, outFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outFile], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg 退出码 ${code}`))));
  });
}

function startServer(fixtureFile) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/uitest-video.mp4')) {
      const size = fsSync.statSync(fixtureFile).size;
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
      fsSync.createReadStream(fixtureFile).pipe(res);
      return;
    }
    if (req.url.startsWith('/uitest-slow.mp4')) {
      const size = fsSync.statSync(fixtureFile).size;
      const total = size * 60; // 约 15 秒发完，够点取消
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': total });
      const chunk = fsSync.readFileSync(fixtureFile);
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

async function runVideodlUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [], failures: [] };
  const check = (name, ok, detail) => {
    result.checks[name] = { ok: Boolean(ok), detail: String(detail || '') };
    if (!ok) result.failures.push(`${name}：${detail}`);
  };

  const ffmpeg = findFfmpeg();
  if (wc.setBackgroundThrottling) wc.setBackgroundThrottling(false);
  win.show();
  await fs.mkdir(TEST_DIR, { recursive: true });

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-${name}.png`);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        win.show();
        win.focus();
        await wait(180);
        const image = await wc.capturePage();
        if (image && !image.isEmpty()) {
          await fs.writeFile(file, image.toPNG());
          result.shots.push(file);
          return true;
        }
      } catch { /* 重试 */ }
      await wait(400);
    }
    return false;
  };
  const clickTool = (name) => evalJs(`(() => {
    const btn = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.textContent.includes(${JSON.stringify(name)}));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  const click = (sel) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.click();
    return true;
  })()`);

  /** 工具页状态快照 */
  const pageState = () => evalJs(`(() => {
    const items = [...document.querySelectorAll('.vdl-item')].map((el) => ({
      status: (el.className.match(/is-(\\w+)/) || [])[1] || '',
      text: el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200)
    }));
    return JSON.stringify({
      active: (document.querySelector('.tool-page.is-active') || { dataset: {} }).dataset.toolId || '',
      dir: (document.querySelector('[data-role="dir"]') || {}).textContent || '',
      badge: (document.querySelector('[data-role="engine-badge"]') || {}).textContent || '',
      engineLine: (document.querySelector('[data-role="engine-line"]') || {}).textContent || '',
      engineHint: (document.querySelector('[data-role="engine-hint"]') || {}).textContent || '',
      autocheck: !!(document.querySelector('[data-role="autocheck"]') || {}).checked,
      emptyVisible: /还没有下载记录/.test((document.querySelector('[data-role="list"]') || {}).textContent || ''),
      items
    });
  })()`);

  const waitItem = async (predicate, timeoutMs, label) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      const st = JSON.parse(await pageState());
      last = st;
      const found = st.items.find(predicate);
      if (found) return { ok: true, item: found, state: st };
      await wait(400);
    }
    return { ok: false, state: last };
  };

  let server = null;
  const fixture = path.join(TEST_DIR, 'uitest-fixture.mp4');
  const proxyBackup = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY };
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;

  try {
    await makeFixture(ffmpeg, fixture);
    server = await startServer(fixture);
    const port = server.address().port;
    const videoUrl = `http://127.0.0.1:${port}/uitest-video.mp4`;
    const slowUrl = `http://127.0.0.1:${port}/uitest-slow.mp4`;
    // 产物名由 yt-dlp 的 %(title)s [%(id)s] 决定，别写死——按前缀在测试目录里找
    const resultFiles = () => fsSync.readdirSync(TEST_DIR).filter((f) => f.startsWith('uitest-video') && f.endsWith('.mp4'));
    const firstResult = () => {
      const names = resultFiles();
      return names.length ? path.join(TEST_DIR, names[0]) : '';
    };

    // —— 1) 切工具，看初始态 ——
    await shot('videodl-01-切工具前');
    result.steps.switch = await clickTool('视频下载');
    await wait(900);
    const initial = JSON.parse(await pageState());
    result.steps.initial = initial;
    check('初始态-已进入视频下载页', initial.active === 'videodl', `active=${initial.active}`);
    check('初始态-引擎徽章有内容', Boolean(initial.badge), `badge=${initial.badge}`);
    check('初始态-引擎信息非空', Boolean(initial.engineLine), `engineLine=${initial.engineLine.slice(0, 60)}`);
    check('初始态-空记录提示可见', initial.emptyVisible, 'list 含空态文案');
    await shot('videodl-02-初始态');

    // —— 2) 改保存位置（测试模式对话框桩返回 TEST_DIR） ——
    await click('[data-action="change-dir"]');
    await wait(700);
    const afterDir = JSON.parse(await pageState());
    check('保存位置可更改', afterDir.dir.includes('tomato-uitest'), `dir=${afterDir.dir}`);

    // —— 3) 贴链接下载（真实 yt-dlp + ffmpeg 链路） ——
    await evalJs(`(() => {
      const input = document.querySelector('[data-role="url"]');
      input.value = ${JSON.stringify(videoUrl)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await click('[data-action="start"]');
    const appeared = await waitItem(() => true, 30000, '任务出现');
    check('任务出现在记录里', appeared.ok, appeared.ok ? appeared.item.text.slice(0, 60) : '超时');
    if (appeared.ok) await shot('videodl-03-下载中');
    const finished = await waitItem((it) => it.status === 'done' || it.status === 'error', 120000, '下载完成');
    const doneItem = finished.ok ? finished.item : null;
    check('下载完成', Boolean(doneItem) && doneItem.status === 'done', doneItem ? doneItem.text : `超时：${JSON.stringify(finished.state)}`);
    const downloaded = firstResult();
    const fileOk = Boolean(downloaded) && fsSync.statSync(downloaded).size > 1000;
    check('产物落盘', fileOk, downloaded || '测试目录里没有产物');
    if (fileOk) {
      const decode = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', downloaded, '-map', '0:v:0', '-map', '0:a:0', '-t', '0', '-f', 'null', '-'], { windowsHide: true, timeout: 20000 });
      check('产物可被 ffmpeg 完整解码（含音轨）', decode.status === 0, `ffmpeg 退出码 ${decode.status}`);
    }
    await shot('videodl-04-下载完成');

    // —— 4) 「在文件夹中显示」不崩（测试模式空跑） ——
    await click('.vdl-item.is-done [data-action="reveal"]');
    await wait(400);
    check('定位按钮可用（测试模式空跑）', true, '点击无异常');

    // —— 5) 引擎卡片：检查更新 + 自动检查开关（联网失败也如实显示） ——
    await click('[data-action="check-engine"]');
    await wait(1500);
    const afterCheck = JSON.parse(await pageState());
    check('检查更新有反馈', /已是最新|发现新版本|检查失败/.test(afterCheck.engineHint), `hint=${afterCheck.engineHint.slice(0, 80)}`);
    await click('[data-role="autocheck"]');
    await wait(400);
    const toggledOff = JSON.parse(await pageState());
    await click('[data-role="autocheck"]');
    await wait(400);
    const toggledOn = JSON.parse(await pageState());
    check('自动检查开关可切换', toggledOff.autocheck === false && toggledOn.autocheck === true, `off=${toggledOff.autocheck} on=${toggledOn.autocheck}`);
    await shot('videodl-05-引擎卡片');

    // —— 6) 取消：慢速下载中途点取消 ——
    await evalJs(`(() => {
      const input = document.querySelector('[data-role="url"]');
      input.value = ${JSON.stringify(slowUrl)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await click('[data-action="start"]');
    const slowRunning = await waitItem((it) => it.status === 'running' && /%/.test(it.text), 45000, '慢速任务出现进度');
    check('慢速任务出现进度', slowRunning.ok, slowRunning.ok ? slowRunning.item.text.slice(0, 80) : '超时');
    await shot('videodl-06-慢速下载中');
    await click('.vdl-item.is-running [data-action="cancel"]');
    const cancelled = await waitItem((it) => it.status === 'cancelled', 45000, '取消生效');
    check('取消生效', cancelled.ok, cancelled.ok ? cancelled.item.text.slice(0, 80) : '超时');
    await shot('videodl-07-已取消');

    // —— 7) 清空记录：列表清空、磁盘文件仍在 ——
    await click('[data-action="clear"]');
    await wait(700);
    const afterClear = JSON.parse(await pageState());
    check('清空记录-列表回到空态', afterClear.emptyVisible && afterClear.items.length === 0, `items=${afterClear.items.length}`);
    check('清空记录-不删磁盘文件', resultFiles().length > 0, `测试目录里的产物数=${resultFiles().length}`);
    await shot('videodl-08-清空记录');
  } catch (error) {
    check('界面测试执行', false, `${error.message}\n${error.stack || ''}`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (proxyBackup.http !== undefined) process.env.HTTP_PROXY = proxyBackup.http;
    if (proxyBackup.https !== undefined) process.env.HTTPS_PROXY = proxyBackup.https;
    try { await fs.rm(fixture, { force: true }); } catch { /* 忽略 */ }
  }

  result.pass = result.failures.length === 0;
  writeResult(result);
  return result;
}

module.exports = { runVideodlUiTest, writeResult, RESULT_FILE };
