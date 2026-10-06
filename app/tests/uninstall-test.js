// 软件卸载自检（仅 `electron . --uninstall-test` 时运行；见 spec/modules/uninstall.md）
//
// 覆盖四件事：
//  1) 加装包：HiBit 便携版在位、体积合理、版本文件可读、**SHA-256 与说明.txt 记录一致**（防被悄悄换掉）；
//     并核对 exe 清单里的 requireAdministrator —— 这是「必须提权启动」的硬证据。
//  2) 提权命令构造（纯逻辑）：RunAs 脚本拼装、单引号转义、PowerShell 绝对路径、结果三态解读。
//  3) 测试模式空跑：点界面按钮**绝不真的拉起**（用 tasklist 断言进程不存在），那是自动化测试的红线。
//  4) 界面走查与截图：分组里能找到入口、页面元素齐全、状态卡显示版本与来源、缺失加装包时的降级提示。
//
// 结果写入 %TEMP%/tomato-uninstall-test.json，截图落在 %TEMP%/tomato-uitest。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-uninstall-test.json');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ADDON_DIR_NAME = path.join('addons', 'hibit');
const EXE_NAME = 'HiBitUninstaller-Portable.exe';
const OFF_NAME = `${EXE_NAME}.off`; // 临时「藏起来」（测缺失降级用；跑完必定还原）

const addonBase = () => (app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'));

function writeResult(payload) {
  fsSync.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

const sha256 = (file) => crypto.createHash('sha256').update(fsSync.readFileSync(file)).digest('hex').toUpperCase();

/** exe 清单里的权限级别（读二进制里的 manifest 文本，够用且零依赖） */
function readExecutionLevel(exePath) {
  const ascii = fsSync.readFileSync(exePath).toString('latin1');
  const m = ascii.match(/<requestedExecutionLevel[\s\S]{0,120}?level="([^"]+)"/);
  return m ? m[1] : '';
}

/** 断言辅助：跑完开头的「藏起来的那一份」能自愈（万一上次跑到一半被打断） */
function healAddonDir(dir) {
  const exe = path.join(dir, EXE_NAME);
  const off = path.join(dir, OFF_NAME);
  if (!fsSync.existsSync(exe) && fsSync.existsSync(off)) {
    fsSync.renameSync(off, exe);
    return 'healed';
  }
  return 'clean';
}

/** 便携版进程是否存在（断言「测试模式没真的启动」用） */
function isHibitRunning() {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/NH'], { windowsHide: true, encoding: 'utf8' });
  if (r.error || typeof r.stdout !== 'string') return { checked: false, running: null, note: (r.error && r.error.message) || 'tasklist 不可用' };
  return { checked: true, running: /HiBitUninstaller-Portable\.exe/i.test(r.stdout) };
}

async function runUninstallTest(win, { portableDir }) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const addonDir = path.join(portableDir || addonBase(), ADDON_DIR_NAME);
  const exePath = path.join(addonDir, EXE_NAME);
  const result = { steps: {}, checks: {}, shots: [], failures: [] };
  const fail = (name, detail) => { result.failures.push({ name, detail: String(detail === undefined ? '' : detail) }); };
  const ok = (name, cond, detail) => { result.checks[name] = cond ? true : { ok: false, detail: String(detail === undefined ? '' : detail) }; if (!cond) fail(name, detail); };

  await fs.mkdir(TEST_DIR, { recursive: true });

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-uninstall-${name}.png`);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        win.show();
        win.focus();
        if (wc.setBackgroundThrottling) wc.setBackgroundThrottling(false);
        await wait(200);
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

  // —— ① 加装包 ——
  result.steps.自愈 = healAddonDir(addonDir);
  const lib = await import('../src/tools/uninstall/core/launch.mjs');
  const exeOk = fsSync.existsSync(exePath);
  ok('加装包-exe存在', exeOk, exePath);
  if (exeOk) {
    const sizeMB = +(fsSync.statSync(exePath).size / 1024 / 1024).toFixed(1);
    result.addon = { exePath, sizeMB, sha256: sha256(exePath) };
    ok('加装包-体积合理', sizeMB > 10 && sizeMB < 60, `${sizeMB} MB`);

    const versionTxt = await fs.readFile(path.join(addonDir, lib.VERSION_FILE), 'utf8').catch(() => '');
    result.addon.version = versionTxt.trim();
    ok('加装包-版本文件可读', /^\d+\.\d+/.test(versionTxt.trim()), JSON.stringify(versionTxt));

    // 说明.txt 里记的 SHA-256 必须与实际文件一致（换过文件却没更新说明 = 断言失败）
    const readme = await fs.readFile(path.join(addonDir, '说明.txt'), 'utf8').catch(() => '');
    const recorded = (readme.match(/\b[0-9A-F]{64}\b/i) || [''])[0].toUpperCase();
    result.addon.recordedHash = recorded;
    ok('加装包-哈希与说明一致', !!recorded && recorded === result.addon.sha256, `${recorded} vs ${result.addon.sha256}`);

    const level = readExecutionLevel(exePath);
    result.addon.executionLevel = level;
    ok('加装包-清单要求管理员', level === 'requireAdministrator', `level=${level}`);
  }

  // —— ② 提权命令构造（纯逻辑的完整断言在 `tests/uninstall.test.mjs`，随 npm test 跑；
  //        这里只留一条「拼出来的脚本确实指着本机这个 exe」的接线检查 ——
  const script = lib.buildRunAsScript({ exePath, workingDir: addonDir });
  result.checks['命令-脚本'] = script;
  ok('命令-指向本机加装包', script.includes(`-FilePath '${exePath.replace(/'/g, "''")}'`) && /-Verb RunAs$/.test(script), script);

  // —— ③ 界面：切到「软件卸载」 ——
  const navFound = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === 'uninstall');
    if (!btn) return { found: false };
    const inGroup = !!btn.closest('.tool-group[data-group-id="system"]');
    btn.click();
    return { found: true, inGroup, text: btn.textContent.trim() };
  })()`);
  result.steps.导航 = navFound;
  ok('界面-左侧有入口', navFound.found === true, JSON.stringify(navFound));
  ok('界面-入口在「系统」分组', navFound.inGroup === true, JSON.stringify(navFound));
  await wait(400);

  // 引擎状态走的是真 IPC（window.desktop.hibitStatus → 主进程探测）
  const ipcStatus = await evalJs('window.desktop.hibitStatus()');
  result.checks['IPC-状态'] = ipcStatus;
  ok('IPC-状态可用', !!ipcStatus && ipcStatus.found === true, JSON.stringify(ipcStatus));
  ok('IPC-状态带版本', !!(ipcStatus && ipcStatus.version && /^\d+\.\d+/.test(ipcStatus.version)), JSON.stringify(ipcStatus && ipcStatus.version));

  const pageInfo = await evalJs(`(() => {
    const q = (s) => document.querySelector(s);
    const engine = q('[data-role="engine"]');
    return {
      launch: !!q('[data-action="launch"]'),
      recheck: !!q('[data-action="recheck"]'),
      hint: (q('[data-role="hint"]') || {}).textContent || '',
      engineText: (engine || {}).textContent || '',
      // 来源必须是纯文本、不能是 <a>：本项目没有「打开外部浏览器」的能力，
      // 一个真链接会把这个窗口导航到外站、切不回来
      srcLinks: ((engine || {}).querySelectorAll ? engine.querySelectorAll('a').length : -1),
      disabled: !!(q('[data-action="launch"]') || {}).disabled,
      statusText: document.getElementById('statusText').textContent,
      engineMissing: !!(engine && engine.classList.contains('is-missing'))
    };
  })()`);
  result.steps.页面 = pageInfo;
  ok('界面-按钮与状态卡齐全', pageInfo.launch && pageInfo.recheck, JSON.stringify(pageInfo));
  ok('界面-就绪时按钮可点', pageInfo.disabled === false, JSON.stringify(pageInfo));
  ok('界面-状态卡显示版本', !!(ipcStatus && ipcStatus.version && pageInfo.engineText.includes(ipcStatus.version)), pageInfo.engineText);
  ok('界面-状态卡给出官方来源', /hibitsoft\.ir/i.test(pageInfo.engineText), pageInfo.engineText);
  ok('界面-来源是纯文本而非可点链接', pageInfo.srcLinks === 0, `a=${pageInfo.srcLinks}`);
  ok('界面-顶栏提示就绪', /卸载工具已就绪/.test(pageInfo.statusText), pageInfo.statusText);
  await shot('01-就绪');

  // —— ④ 点按钮：测试模式必须空跑（绝不弹 UAC、绝不真的启动） ——
  const beforeProc = isHibitRunning();
  const clicked = await evalJs(`(() => {
    const btn = document.querySelector('[data-action="launch"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await wait(1200);
  const afterClick = await evalJs(`(() => ({
    hint: (document.querySelector('[data-role="hint"]') || {}).textContent || '',
    statusText: document.getElementById('statusText').textContent,
    disabled: !!(document.querySelector('[data-action="launch"]') || {}).disabled
  }))()`);
  const afterProc = isHibitRunning();
  result.steps.点击启动 = { clicked, afterClick, beforeProc, afterProc };
  ok('空跑-测试模式如实提示', /测试模式/.test(afterClick.hint), afterClick.hint);
  ok('空跑-按钮回到可用态', afterClick.disabled === false, JSON.stringify(afterClick));
  ok('空跑-顶栏提示测试模式', /测试模式/.test(afterClick.statusText), afterClick.statusText);
  if (afterProc.checked) {
    ok('空跑-没有真的拉起进程', afterProc.running === false, JSON.stringify(afterProc));
  } else {
    result.checks['空跑-没有真的拉起进程'] = { skipped: true, reason: afterProc.note };
  }
  await shot('02-测试模式空跑');

  // —— ⑤ 缺失加装包的降级（把 exe 临时改成 .off，走完立刻还原） ——
  let missingState = null;
  try {
    fsSync.renameSync(exePath, path.join(addonDir, OFF_NAME));
    await evalJs(`document.querySelector('[data-action="recheck"]').click()`);
    await wait(600);
    missingState = await evalJs(`(() => {
      const engine = document.querySelector('[data-role="engine"]');
      return {
        engineMissing: !!(engine && engine.classList.contains('is-missing')),
        engineText: (engine || {}).textContent || '',
        disabled: !!(document.querySelector('[data-action="launch"]') || {}).disabled,
        statusText: document.getElementById('statusText').textContent
      };
    })()`);
    await shot('03-缺失加装包');
  } finally {
    if (fsSync.existsSync(path.join(addonDir, OFF_NAME))) fsSync.renameSync(path.join(addonDir, OFF_NAME), exePath);
  }
  result.steps.缺失降级 = missingState;
  ok('降级-按钮被禁用', !!missingState && missingState.disabled === true, JSON.stringify(missingState));
  ok('降级-给出放置说明', !!missingState && /addons[\\/]hibit/.test(missingState.engineText), missingState && missingState.engineText);
  ok('降级-顶栏提示未检测到', !!missingState && /未检测到/.test(missingState.statusText), missingState && missingState.statusText);
  ok('降级-加装包已还原', fsSync.existsSync(exePath), exePath);

  // 收尾：恢复就绪态（界面提示与按钮状态）
  await evalJs(`document.querySelector('[data-action="recheck"]').click()`);
  await wait(500);
  const restored = await evalJs(`(() => ({
    disabled: !!(document.querySelector('[data-action="launch"]') || {}).disabled,
    engineMissing: document.querySelector('[data-role="engine"]').classList.contains('is-missing')
  }))()`);
  ok('收尾-恢复就绪', restored.disabled === false && restored.engineMissing === false, JSON.stringify(restored));

  result.pass = result.failures.length === 0;
  return result;
}

module.exports = { runUninstallTest, writeResult };