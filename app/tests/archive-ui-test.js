// 「文件压缩与解压」工具 —— 界面自动测试
// 用法：cd app && .\node_modules\electron\dist\electron.exe . --archive-ui-test
// 像真人一样操作：切到工具 → 压缩（7Z）→ 校验产物 → 切解压模式 → 预览断言 → 解压 → 内容比对
//                → 密码往返 → 分卷往返 → 仅解压格式提示 → 清空
// 逐步截图 shot-archive-*.png 落在 %TEMP%\tomato-uitest；结果写 %TEMP%/tomato-archive-ui-test.json，pass:true 为通过。
//
// 夹具纪律：开跑前、收尾后各清一次 %TEMP%\tomato-uitest 里的
// 「测试压缩源」目录与「测试压缩*」压缩包，绝不残留——否则会污染其它工具的界面测试。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-archive-ui-test.json');
/** 待压缩夹具目录（主进程 dialog:open-archive-files 的桩用的就是它） */
const SRC_DIR_NAME = '测试压缩源';
/** 压缩包夹具前缀（主进程 dialog:open-archives 的桩按它筛选） */
const PACK_PREFIX = '测试压缩';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeResult(payload) {
  try {
    fsSync.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[archive-ui-test] 结果文件写入失败：', err.message);
  }
  return RESULT_FILE;
}

/**
 * 清理上一次留下的夹具：
 *   · 「测试压缩源」目录
 *   · 「测试压缩*」前缀的文件（含所有扩展名与分卷）
 *   · **所有压缩包类文件**——「添加压缩包」对话框是按扩展名扫 TEST_DIR 的，
 *     上一次跑剩的加密包（如 中文名字.zip）会被一起选进来，
 *     导致用空密码解它时报「密码错误」，把测试结果搅乱（踩过）。
 */
async function cleanFixtures() {
  const removed = [];
  const srcDir = path.join(TEST_DIR, SRC_DIR_NAME);
  if (fsSync.existsSync(srcDir)) {
    await fs.rm(srcDir, { recursive: true, force: true });
    removed.push(SRC_DIR_NAME);
  }
  const entries = await fs.readdir(TEST_DIR).catch(() => []);
  for (const name of entries) {
    const isFixture = name.startsWith(PACK_PREFIX);
    const isArchive = /\.(7z|zip|tar|gz|bz2|xz|zst|br)$/i.test(name);
    if (!isFixture && !isArchive) continue;
    await fs.rm(path.join(TEST_DIR, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** 删掉测试目录里本工具产出的压缩包（只删压缩包类扩展名，不碰别的工具的夹具） */
async function cleanArchivesInTestDir() {
  const removed = [];
  for (const name of await fs.readdir(TEST_DIR).catch(() => [])) {
    if (!/\.(7z|zip|tar|gz|bz2|xz|zst|br)$/i.test(name)) continue;
    await fs.rm(path.join(TEST_DIR, name), { recursive: true, force: true }).catch(() => {});
    removed.push(name);
  }
  return removed;
}

/** 找到 7z.exe（加装包优先，其次系统 PATH） */
function findSevenZip() {
  const base = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
  const addon = path.join(base, 'addons', '7zip', '7z.exe');
  if (fsSync.existsSync(addon)) return addon;
  try {
    const r = spawnSync('where', ['7z'], { windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) {
      const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fsSync.existsSync(first)) return first;
    }
  } catch { /* 未安装 */ }
  return null;
}

/** 用 7z l -slt 读压缩包，返回条目加密标记（用于断言「密码压缩确实加密了」） */
function probeEncryption(zipPath) {
  const bin = findSevenZip();
  if (!bin) return { ok: false, error: '没有 7z' };
  const r = spawnSync(bin, ['l', '-slt', '-ba', '-pTomato-Ui-2026', zipPath], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  const out = String(r.stdout || '');
  const methods = [...out.matchAll(/Method = (.+)/g)].map((m) => m[1].trim());
  const encFlags = [...out.matchAll(/Encrypted = (.+)/g)].map((m) => m[1].trim());
  return {
    ok: r.status === 0,
    exitCode: r.status,
    methods,
    encryptedCount: encFlags.filter((f) => f === '+').length,
    entryCount: (out.match(/^Path = /gm) || []).length
  };
}

/** 压缩包名 → 默认解压目录名（去掉压缩包后缀；与 core/plan.mjs 的规则一致） */
function defaultExtractDirName(archiveFileName) {
  let base = archiveFileName;
  for (const suffix of ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tar.br', '.tar', '.zip', '.7z', '.gz', '.bz2', '.xz', '.zst', '.br']) {
    if (base.toLowerCase().endsWith(suffix)) { base = base.slice(0, -suffix.length); break; }
  }
  return base;
}

/** 造夹具：一份有多层目录、中文名、二进制与空文件的样本 */
async function makeSourceFixture() {
  const dir = path.join(TEST_DIR, SRC_DIR_NAME);
  await fs.mkdir(path.join(dir, '子目录', '更深处'), { recursive: true });
  await fs.writeFile(path.join(dir, '说明.txt'), '这是压缩与解压界面测试的样本文件。\n', 'utf8');
  await fs.writeFile(path.join(dir, '中文名字.txt'), '中文内容\n', 'utf8');
  await fs.writeFile(path.join(dir, '空文件.txt'), '');
  await fs.writeFile(path.join(dir, '子目录', '数据.bin'), Buffer.from(Array.from({ length: 20000 }, (_, i) => i % 251)));
  await fs.writeFile(path.join(dir, '子目录', '更深处', '深层.txt'), 'deep\n', 'utf8');
  return dir;
}

/** 递归收集文件（相对路径 → 绝对路径） */
function walk(dir, base = dir, acc = new Map()) {
  let entries = [];
  try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, acc);
    else acc.set(path.relative(base, full).replace(/\\/g, '/'), full);
  }
  return acc;
}

function sameFile(a, b) {
  try {
    const ba = fsSync.readFileSync(a);
    const bb = fsSync.readFileSync(b);
    return ba.length === bb.length && ba.equals(bb);
  } catch {
    return false;
  }
}

async function pollUntil(fn, timeoutMs, intervalMs = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await wait(intervalMs);
  }
}

/**
 * 跑「文件压缩与解压」界面自动测试
 * @param {import('electron').BrowserWindow} win
 */
async function runArchiveUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { steps: {}, checks: {}, shots: [], failures: [] };
  const fail = (msg) => { result.failures.push(msg); console.error(`[archive-ui-test] ${msg}`); };

  // 把渲染进程的报错收进结果：工具页 mount 抛错时界面「看起来在、点了没反应」，
  // 只有控制台里的原始错误才能定位（踩过：按钮点了没反应但测试只说超时）
  const consoleErrors = [];
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) consoleErrors.push(`${message} (${path.basename(sourceId || '')}:${line})`);
  });
  result.checks.consoleErrors = consoleErrors;

  await fs.mkdir(TEST_DIR, { recursive: true });

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-archive-${name}.png`);
    for (let attempt = 0; attempt < 4; attempt++) {
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
    fail(`截图失败：${name}`);
    return false;
  };

  result.steps.cleanedAtStart = await cleanFixtures();
  const srcDir = await makeSourceFixture();
  const srcFiles = walk(srcDir);
  result.steps.fixture = { dir: srcDir, files: srcFiles.size };

  /** 等工具页的按钮出现（切换工具是异步渲染的） */
  const ensureToolMounted = async () => pollUntil(async () => evalJs('!!document.getElementById("arcRunBtn")'), 8000, 300);

  // —— 1) 切到工具，检查界面元素与引擎状态 ——
  await evalJs(`(() => {
    const nav = (id) => [...document.querySelectorAll('#toolNav .tool-item')].find((b) => b.dataset.toolId === id);
    nav('archive').click();
    return true;
  })()`);
  if (!await ensureToolMounted()) {
    result.pass = false;
    const status = await evalJs('document.getElementById("statusText").textContent').catch(() => '');
    fail(`切到「压缩与解压」后界面没有渲染出 #arcRunBtn；状态栏="${status}"`);
    if (consoleErrors.length) fail(`渲染进程报错：${consoleErrors.slice(0, 3).join(' ｜ ')}`);
    writeResult({ ok: false, at: new Date().toISOString(), result });
    return result;
  }
  await wait(600);

  result.checks.mount = JSON.parse(await evalJs(`(() => {
    const ids = ['arcModePack','arcModeUnpack','arcFormat','arcLevel','arcVolume','arcPassword',
                 'arcAddBtn','arcAddDirBtn','arcRunBtn','arcClearBtn','arcDrop','arcPreview'];
    const missing = ids.filter((id) => !document.getElementById(id));
    const opts = [...document.querySelectorAll('#arcFormat option')].map((o) => o.value);
    const groups = [...document.querySelectorAll('#arcFormat optgroup')].map((g) => g.label);
    return JSON.stringify({
      missing,
      formatCount: opts.length,
      groups,
      hasRar: opts.includes('rar'),
      has7z: opts.includes('7z'),
      hasZst: opts.includes('zst'),
      activeMode: document.getElementById('arcModePack').classList.contains('is-active') ? 'pack' : 'unpack',
      engineText: document.getElementById('arcEngine').textContent,
      warnHidden: document.getElementById('arcWarn').hidden
    });
  })()`));
  if (result.checks.mount.missing.length) fail(`界面缺少元素：${result.checks.mount.missing.join('、')}`);
  if (!result.checks.mount.hasRar) fail('格式下拉里应有 rar（仅解压）');
  if (result.checks.mount.groups.length < 3) fail('格式下拉应分成 3 组（常用 / 其它 / 仅解压）');
  result.checks.engineAvailable = !result.checks.mount.warnHidden || /未检测到/.test(result.checks.mount.engineText);
  await shot('01-工具初始界面');

  // —— 2) 仅解压格式：选中 rar 后「开始压缩」必须禁用并给出原因 ——
  await evalJs(`(() => {
    const sel = document.getElementById('arcFormat');
    sel.value = 'rar';
    sel.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await wait(400);
  result.checks.extractOnlyNotice = JSON.parse(await evalJs(`JSON.stringify({
    runDisabled: document.getElementById('arcRunBtn').disabled,
    note: document.getElementById('arcPackNote').textContent,
    volumeHint: document.getElementById('arcVolumeHint').textContent
  })`));
  if (!result.checks.extractOnlyNotice.runDisabled) fail('选中「仅解压」格式后开始压缩应禁用');
  if (!/仅解压/.test(result.checks.extractOnlyNotice.note)) fail('选中「仅解压」格式后应说明原因');
  if (!/专有格式/.test(result.checks.extractOnlyNotice.note)) fail('应说明 RAR 是专有格式（免费工具无法创建）');
  await shot('02-仅解压格式提示');

  // 切回 7Z
  await evalJs(`(() => {
    const sel = document.getElementById('arcFormat');
    sel.value = '7z';
    sel.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await wait(300);

  // —— 3) 添加待压缩文件 → 压缩 ——
  await evalJs('document.getElementById("arcAddBtn").click()');
  const added = await pollUntil(async () => {
    const n = await evalJs('document.querySelectorAll("#arcList .arc-item").length');
    return n > 0 ? n : null;
  }, 10000, 400);
  result.steps.addedCount = added || 0;
  if (!added) fail('点「添加文件」后列表仍为空');
  result.checks.addToast = await evalJs('document.getElementById("statusText").textContent');

  // 用真实的「选择…」按钮指定输出目录（测试模式下 openFolder 返回 TEST_DIR）：
  // 既覆盖了该按钮，也让产物落在 TEST_DIR 顶层——解压模式的「添加压缩包」对话框才扫得到。
  await evalJs('document.getElementById("arcPickOutput").click()');
  await wait(800);
  result.checks.outputDirPick = await evalJs(`JSON.stringify({
    value: document.getElementById('arcOutputDir').value,
    status: document.getElementById('statusText').textContent
  })`);
  if (!JSON.parse(result.checks.outputDirPick).value) fail('点「选择…」后输出目录仍为空');
  await shot('03-已添加待压缩文件');

  await evalJs('document.getElementById("arcRunBtn").click()');
  const packed = await pollUntil(async () => {
    const t = await evalJs('document.getElementById("arcResult").textContent');
    return /压缩完成|失败|已取消|压缩完成：/.test(t) || /7z ｜/.test(t) ? t : null;
  }, 60000, 500);
  result.checks.packResult = packed || '';
  if (!packed || /失败/.test(packed)) fail(`压缩未成功：${packed || '超时'}`);
  await shot('04-压缩完成');

  // 产物：在测试目录里找刚生成的 .7z
  const afterPack = (await fs.readdir(TEST_DIR)).filter((f) => f.endsWith('.7z'));
  result.steps.packProducts = afterPack;
  if (afterPack.length < 1) fail('没有找到压缩产物 .7z');
  const sampleArchive = afterPack.length ? path.join(TEST_DIR, afterPack[0]) : '';
  result.checks.archiveSize = sampleArchive && fsSync.existsSync(sampleArchive) ? fsSync.statSync(sampleArchive).size : 0;
  if (!(result.checks.archiveSize > 0)) fail('压缩产物大小为 0');

  // —— 4) 切到解压模式：预览应列出内容且**不解压** ——
  await evalJs('document.getElementById("arcModeUnpack").click()');
  await wait(400);
  await evalJs('document.getElementById("arcAddBtn").click()');
  const xAdded = await pollUntil(async () => {
    const n = await evalJs('document.querySelectorAll("#arcList .arc-item").length');
    return n > 0 ? n : null;
  }, 10000, 400);
  result.steps.addedArchives = xAdded || 0;
  if (!xAdded) fail('解压模式下点「添加压缩包」后列表仍为空');
  await wait(800);

  // 预览是异步读的（先「正在读取内容列表…」），等它读完再断言
const previewReady = await pollUntil(async () => {
    const s = await evalJs('document.getElementById("arcPreviewSummary").textContent');
    return /个条目/.test(s) || /无法/.test(await evalJs('document.getElementById("arcPreviewEmpty").textContent')) ? s : null;
  }, 20000, 400);
  result.checks.preview = JSON.parse(await evalJs(`JSON.stringify({
    title: document.getElementById('arcPreviewTitle').textContent,
    summary: document.getElementById('arcPreviewSummary').textContent,
    rows: document.querySelectorAll('#arcEntries .arc-entry').length,
    emptyHidden: document.getElementById('arcPreviewEmpty').hidden,
    firstName: (document.querySelector('#arcEntries .arc-entry-name') || {}).textContent || ''
  })`));
  if (!previewReady) fail(`预览一直停在「读取中」：${result.checks.preview.summary}`);
  if (!result.checks.preview.rows) fail('预览没有列出任何条目');
  if (!/个条目/.test(result.checks.preview.summary)) fail(`预览汇总文案不对：${result.checks.preview.summary}`);

  // 关键：预览期间「默认解压目录」不能出现（证明预览真的没解压）
  const defDir = defaultExtractDirName(path.basename(sampleArchive));
  result.steps.defaultExtractDir = path.join(TEST_DIR, defDir);
  result.checks.previewDidNotExtract = !fsSync.existsSync(result.steps.defaultExtractDir);
  if (!result.checks.previewDidNotExtract) fail('预览阶段就出现了默认解压目录（说明预览把内容解开了）');
  await shot('05-免解压预览');

  // 搜索框过滤
  await evalJs(`(() => {
    const s = document.getElementById('arcPreviewSearch');
    s.value = '中文';
    s.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await wait(300);
  result.checks.previewSearch = await evalJs('document.querySelectorAll("#arcEntries .arc-entry").length');
  result.checks.previewSearchText = await evalJs('(document.querySelector("#arcEntries .arc-entry-name")||{}).textContent || ""');
  await evalJs(`(() => {
    const s = document.getElementById('arcPreviewSearch');
    s.value = '';
    s.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await wait(200);

  // —— 5) 解压到指定目录（测试目录下的「界面测试解压结果」），并与源逐字节比对 ——
  const outDir = path.join(TEST_DIR, '界面测试解压结果');
  await fs.rm(outDir, { recursive: true, force: true });
  await evalJs(`(() => {
    const el = document.getElementById('arcExtractDir');
    el.value = ${JSON.stringify(outDir)};
    return true;
  })()`);
  await evalJs('document.getElementById("arcRunBtn").click()');
  const unpacked = await pollUntil(async () => {
    const t = await evalJs('document.getElementById("arcResult").textContent');
    return /解压到|解压完成|失败/.test(t) ? t : null;
  }, 60000, 500);
  result.checks.unpackResult = unpacked || '';
  if (!unpacked || /失败/.test(unpacked)) fail(`解压未成功：${unpacked || '超时'}`);
  await shot('06-解压完成');

  // 「添加文件」对话框只会返回**顶层文件**（不递归），所以要按「实际加进去的那些文件」比对。
  // 整目录（含多层子目录）的往返由引擎自检 --archive-test 覆盖。
  const got = walk(outDir);
  const mismatches = [];
  for (const [rel, srcPath] of srcFiles) {
    if (rel.includes('/')) continue; // 子目录里的文件本轮没有加进去
    const hit = got.get(rel) || [...got.entries()].find(([k]) => k.endsWith('/' + rel))?.[1];
    if (!hit) { mismatches.push(`缺少 ${rel}`); continue; }
    if (!sameFile(srcPath, hit)) mismatches.push(`内容不一致 ${rel}`);
  }
  result.checks.unpackedMatchesSource = mismatches.length === 0;
  result.steps.unpackMismatches = mismatches;
  result.steps.comparedFiles = [...srcFiles.keys()].filter((k) => !k.includes('/'));
  if (mismatches.length) fail(`解压结果与源不一致：${mismatches.slice(0, 3).join('；')}`);

  // —— 6) 密码往返（ZIP + AES-256；英文密码，见 spec 的 7-Zip 限制说明） ——
  // 先清掉上一轮的产物：不然「添加压缩包」会把它们一起选进来，
  // 错误密码那一轮会因为「未加密的包解压成功」而误判为通过。
  await evalJs('document.getElementById("arcClearBtn").click()'); // 清空列表
  await evalJs('document.getElementById("arcModePack").click()');
  await wait(400);
  result.steps.archivesRemovedBeforePwRound = await cleanArchivesInTestDir();

  // 重新添加待压缩文件（清空后列表是空的，不重新加「开始压缩」是禁用的）
  await evalJs('document.getElementById("arcAddBtn").click()');
  const reAdded = await pollUntil(async () => {
    const n = await evalJs('document.querySelectorAll("#arcList .arc-item").length');
    return n > 0 ? n : null;
  }, 10000, 400);
  result.steps.reAddedForPwRound = reAdded || 0;
  if (!reAdded) fail('密码轮次重新添加文件失败');

  await evalJs(`(() => {
    const sel = document.getElementById('arcFormat');
    sel.value = 'zip';
    sel.dispatchEvent(new Event('change'));
    const pw = document.getElementById('arcPassword');
    pw.value = 'Tomato-Ui-2026';
    pw.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await wait(300);
  result.checks.pwRunEnabled = await evalJs('!document.getElementById("arcRunBtn").disabled');
  if (!result.checks.pwRunEnabled) {
    fail(`设了密码后「开始压缩」仍禁用：${await evalJs('document.getElementById("arcResult").textContent')}`);
  }
  await evalJs('document.getElementById("arcRunBtn").click()');
  const pwPacked = await pollUntil(async () => {
    const t = await evalJs('document.getElementById("arcResult").textContent');
    return /压缩完成|失败|已取消|zip ｜/.test(t) ? t : null;
  }, 60000, 500);
  result.checks.passwordPackResult = pwPacked || '';
  if (!pwPacked || /失败/.test(pwPacked)) fail(`带密码压缩失败：${pwPacked || '超时'}`);

  // 断言「密码压缩确实加密了」：光看界面文案不够，直接读产物里的加密标记
  const zipProduct = (await fs.readdir(TEST_DIR)).filter((f) => f.toLowerCase().endsWith('.zip'));
  result.steps.passwordProduct = zipProduct;
  result.checks.passwordArchiveEncrypted = zipProduct.length
    ? probeEncryption(path.join(TEST_DIR, zipProduct[0]))
    : { ok: false, error: '没有找到带密码的 .zip 产物' };
  if (!result.checks.passwordArchiveEncrypted.ok || !(result.checks.passwordArchiveEncrypted.encryptedCount > 0)) {
    fail(`带密码压缩的产物没有加密标记：${JSON.stringify(result.checks.passwordArchiveEncrypted)}`);
  }

  // 解压时给错密码 → 必须失败
  await evalJs('document.getElementById("arcModeUnpack").click()');
  await wait(400);
  await evalJs('document.getElementById("arcAddBtn").click()'); // 切模式会清空列表，先重新加压缩包
  const pwAdded = await pollUntil(async () => {
    const n = await evalJs('document.querySelectorAll("#arcList .arc-item").length');
    return n > 0 ? n : null;
  }, 10000, 400);
  result.steps.addedForPwRound = pwAdded || 0;
  if (!pwAdded) fail('密码轮次添加压缩包失败');
  await wait(600);

  // 用一个全新的输出目录：上一轮已解过一遍，同目录 + 「跳过已存在」会让 7-Zip 一个都不解
  // （那属于另一条断言，不能混进「错误密码」这一条里）
  const pwOutDir = path.join(TEST_DIR, '界面测试密码结果');
  await fs.rm(pwOutDir, { recursive: true, force: true });
  await evalJs(`(() => {
    document.getElementById('arcExtractDir').value = ${JSON.stringify(pwOutDir)};
    const pw = document.getElementById('arcPasswordX');
    pw.value = 'wrong-password';
    pw.dispatchEvent(new Event('input'));
    document.getElementById('arcRunBtn').click();
    return true;
  })()`);
  const wrongPw = await pollUntil(async () => {
    const t = await evalJs('document.getElementById("arcResult").textContent');
    return /失败|解压到|解压完成/.test(t) ? t : null;
  }, 60000, 500);
  result.checks.wrongPasswordRejected = !!wrongPw && /失败/.test(wrongPw) && /密码/.test(wrongPw);
  result.checks.wrongPasswordText = wrongPw || '';
  if (!result.checks.wrongPasswordRejected) fail(`错误密码应被拒绝并提示密码问题，实际：${wrongPw}`);
  await shot('07-错误密码被拒绝');

  // 正确密码 → 成功
  await evalJs(`(() => {
    const pw = document.getElementById('arcPasswordX');
    pw.value = 'Tomato-Ui-2026';
    pw.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await wait(300);
  await evalJs('document.getElementById("arcRunBtn").click()');
  const rightPw = await pollUntil(async () => {
    const t = await evalJs('document.getElementById("arcResult").textContent');
    return /解压到|解压完成|失败/.test(t) ? t : null;
  }, 60000, 500);
  result.checks.rightPasswordWorks = !!rightPw && !/失败/.test(rightPw);
  if (!result.checks.rightPasswordWorks) fail(`正确密码应能解压，实际：${rightPw}`);

  // 「跳过已存在」且目标文件都在时，必须如实报「没有解出任何文件」，不能报成功
  // （这是实测踩到的坑：-aos 全跳过时 7-Zip 退出码仍是 0）
  // 注意：结果行里还留着上一轮的文案，必须等它「变了」才算本轮结束
  const prevResult = await evalJs('document.getElementById("arcResult").textContent');
  await evalJs('document.getElementById("arcRunBtn").click()');
  const skipAgain = await pollUntil(async () => {
    const t = await evalJs('document.getElementById("arcResult").textContent');
    if (!t || t === prevResult) return null;
    return /失败|解压到|解压完成|没有解出/.test(t) ? t : null;
  }, 60000, 500);
  result.checks.skipExistingReportedHonestly = !!skipAgain && /没有解出任何文件/.test(skipAgain);
  result.checks.skipExistingText = skipAgain || '';
  if (!result.checks.skipExistingReportedHonestly) {
    fail(`重复解压到同一目录应如实提示「没有解出任何文件」，实际：${skipAgain}`);
  }
  await shot('09-重复解压如实提示');

  // —— 7) 清空 ——
  await evalJs('document.getElementById("arcClearBtn").click()');
  await wait(400);
  result.checks.cleared = JSON.parse(await evalJs(`JSON.stringify({
    rows: document.querySelectorAll('#arcList .arc-item').length,
    dropVisible: !document.getElementById('arcDrop').hidden,
    result: document.getElementById('arcResult').textContent
  })`));
  if (result.checks.cleared.rows !== 0) fail('清空后列表应为 0');
  if (!result.checks.cleared.dropVisible) fail('清空后应重新显示拖放区');
  await shot('08-清空后');

  // —— 8) 收尾：清掉本轮夹具（含压缩产物），避免污染其它界面测试 ——
  result.steps.cleanedAtEnd = await cleanFixtures();
  await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(pwOutDir, { recursive: true, force: true }).catch(() => {});

  result.pass = result.failures.length === 0;
  writeResult({ ok: result.pass, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runArchiveUiTest, writeResult, TEST_DIR, RESULT_FILE, cleanFixtures, SRC_DIR_NAME, PACK_PREFIX };