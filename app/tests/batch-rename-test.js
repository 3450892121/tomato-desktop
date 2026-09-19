// 批量重命名工具自检（仅 `electron . --batch-rename-test` / `--batch-rename-ui-test` 时运行）
// 覆盖两部分：
//   1) runBatchRenameTest：core/plan.js 纯逻辑断言（formatDate / applyRule 四模式 / validateFileName / buildRenamePlan 冲突检出）
//      + 通过 window.desktop.renameBatch 走**真实 IPC 改名**（序号 / 查找替换 / 加前后缀），并重点验证
//        「目标已存在必须跳过」「链式改名不互相踩」两条安全性要求。
//   2) runBatchRenameUiTest：像真人一样「切工具 → 点添加 → 设规则 → 读预览 → 点开始重命名 → 截图」，
//      断言界面预览与实际磁盘改名结果一致。
// 结果写入 %TEMP%/tomato-batch-rename-test.json 与 %TEMP%/tomato-batch-rename-ui-test.json；
// 截图落在 %TEMP%/tomato-uitest（与其它界面测试共用夹具目录）。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs');
const { pathToFileURL } = require('url');

const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');
const RESULT_FILE = path.join(os.tmpdir(), 'tomato-batch-rename-test.json');
const UI_RESULT_FILE = path.join(os.tmpdir(), 'tomato-batch-rename-ui-test.json');
const PLAN_PATH = path.join(__dirname, '..', 'src', 'tools', 'batch-rename', 'core', 'plan.js');
/** 本工具测试夹具的前缀（对话框在测试模式下也只返回以此开头的文件） */
const FIXTURE_PREFIX = '测试重命名';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeResult(payload, file = RESULT_FILE) {
  fsSync.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

/** 清掉本工具的夹具（所有扩展名），其它测试的夹具一律不动 */
async function cleanFixtures() {
  const names = await fs.readdir(TEST_DIR).catch(() => []);
  for (const name of names) {
    if (name.startsWith(FIXTURE_PREFIX)) {
      await fs.rm(path.join(TEST_DIR, name), { recursive: true, force: true });
    }
  }
}

/** 在共用夹具目录里造一个小文件（内容随意，只为校验改名后内容有没有串） */
async function makeFixture(name, content) {
  const full = path.join(TEST_DIR, name);
  await fs.writeFile(full, Buffer.from(content, 'utf8'));
  return full;
}

const exists = (p) => fsSync.existsSync(p);
const readText = (p) => (exists(p) ? fsSync.readFileSync(p, 'utf8') : null);

/** 由路径造一条 items 记录（与界面里 ctx.pathInfo 的字段对齐） */
function itemOf(fullPath) {
  const name = path.basename(fullPath);
  const ext = path.extname(name);
  return {
    path: fullPath,
    name,
    baseName: ext ? name.slice(0, -ext.length) : name,
    ext,
    dir: path.dirname(fullPath),
    size: exists(fullPath) ? fsSync.statSync(fullPath).size : 0,
    mtimeMs: exists(fullPath) ? fsSync.statSync(fullPath).mtimeMs : 0
  };
}

/** 目录里现有的全部文件路径（喂给 buildRenamePlan 的 existingPaths） */
async function existingPaths() {
  const names = await fs.readdir(TEST_DIR).catch(() => []);
  const all = [];
  for (const name of names) {
    const full = path.join(TEST_DIR, name);
    if (fsSync.statSync(full).isFile()) all.push(full);
  }
  return all;
}

// ============================================================
// 1) 纯逻辑 + 真实改名
// ============================================================

async function runBatchRenameTest(win) {
  const evalJs = (code) => win.webContents.executeJavaScript(code);
  const result = { ok: false, checks: {}, notes: [] };

  const plan = await import(pathToFileURL(PLAN_PATH).href);
  result.module = PLAN_PATH;

  await fs.mkdir(TEST_DIR, { recursive: true });
  await cleanFixtures(); // 开跑清一次

  // —— 1a) formatDate ——
  try {
    const d = new Date(2026, 8, 19, 14, 30, 25); // 本地时间 2026-09-19 14:30:25
    const cases = {
      full: plan.formatDate(d, 'YYYY-MM-DD HH:mm:ss'),
      compact: plan.formatDate(d, 'YYYYMMDD_HHmmss'),
      onlyYear: plan.formatDate(d, 'YYYY'),
      pad: plan.formatDate(new Date(2026, 0, 5, 3, 4, 6), 'YYYY-MM-DD HH:mm:ss'),
      literal: plan.formatDate(d, '生日-YYYY'),
      invalid: plan.formatDate(new Date('bad'), 'YYYY')
    };
    const ok = cases.full === '2026-09-19 14:30:25'
      && cases.compact === '20260919_143025'
      && cases.onlyYear === '2026'
      && cases.pad === '2026-01-05 03:04:06'
      && cases.literal === '生日-2026'
      && cases.invalid === 'YYYY';
    result.checks.formatDate = { ok, cases };
  } catch (err) {
    result.checks.formatDate = { ok: false, error: err.message };
  }

  // —— 1b) applyRule 四种模式 ——
  try {
    const cases = {
      seq: plan.applyRule({ baseName: '假期', ext: '.png', index: 0, rule: { mode: 'seq', prefix: '照片_', start: 1, digits: 3 } }),
      seqKeepName: plan.applyRule({ baseName: '假期', ext: '.png', index: 4, rule: { mode: 'seq', prefix: '_', start: 1, digits: 2, keepName: true } }),
      seqNext: plan.applyRule({ baseName: 'x', ext: '.png', index: 2, rule: { mode: 'seq', prefix: '', start: 10, digits: 3 } }),
      replace: plan.applyRule({ baseName: 'IMG_1234', ext: '.jpg', index: 0, rule: { mode: 'replace', find: 'IMG_', replace: '照片' } }),
      replaceRegex: plan.applyRule({ baseName: 'IMG_1234', ext: '.jpg', index: 0, rule: { mode: 'replace', find: '\\d+', replace: '#', useRegex: true } }),
      affix: plan.applyRule({ baseName: '报告', ext: '.txt', index: 0, rule: { mode: 'affix', prefix: '前_', suffix: '_后' } }),
      date: plan.applyRule({ baseName: 'x', ext: '.png', index: 0, rule: { mode: 'date', pattern: 'YYYYMMDD', mtimeMs: new Date(2026, 8, 19).getTime() } })
    };
    let regexThrew = false;
    try { plan.applyRule({ baseName: 'a', ext: '.png', index: 0, rule: { mode: 'replace', find: '(', replace: '', useRegex: true } }); } catch { regexThrew = true; }
    const ok = cases.seq === '照片_001.png'
      && cases.seqKeepName === '假期_05.png'
      && cases.seqNext === '012.png'
      && cases.replace === '照片1234.jpg'
      && cases.replaceRegex === 'IMG_#.jpg'
      && cases.affix === '前_报告_后.txt'
      && cases.date === '20260919.png'
      && regexThrew;
    result.checks.applyRule = { ok, cases, regexThrew };
  } catch (err) {
    result.checks.applyRule = { ok: false, error: err.message };
  }

  // —— 1c) validateFileName ——
  try {
    const cases = {
      normal: plan.validateFileName('正常名字.png').ok,
      slash: plan.validateFileName('a/b.png').ok,
      colon: plan.validateFileName('a:b.png').ok,
      star: plan.validateFileName('a*b.png').ok,
      reservedCon: plan.validateFileName('CON.txt').ok,
      reservedConLower: plan.validateFileName('con').ok,
      reservedCom1: plan.validateFileName('COM1.png').ok,
      notReservedCom10: plan.validateFileName('COM10.png').ok,
      empty: plan.validateFileName('').ok,
      tooLong: plan.validateFileName(`${'x'.repeat(256)}.png`).ok,
      justRight: plan.validateFileName(`${'x'.repeat(251)}.png`).ok,
      trailingDot: plan.validateFileName('a.').ok,
      trailingSpace: plan.validateFileName('a ').ok
    };
    const ok = cases.normal === true
      && cases.slash === false && cases.colon === false && cases.star === false
      && cases.reservedCon === false && cases.reservedConLower === false && cases.reservedCom1 === false
      && cases.notReservedCom10 === true
      && cases.empty === false && cases.tooLong === false && cases.justRight === true
      && cases.trailingDot === false && cases.trailingSpace === false;
    result.checks.validateFileName = {
      ok, cases,
      reasons: {
        slash: plan.validateFileName('a/b.png').reason,
        reserved: plan.validateFileName('CON.txt').reason,
        tooLong: plan.validateFileName(`${'x'.repeat(256)}.png`).reason
      }
    };
  } catch (err) {
    result.checks.validateFileName = { ok: false, error: err.message };
  }

  // —— 1d) buildRenamePlan：批内重名 / 目标已存在 / 链式互换放行 / 非法正则 ——
  try {
    const p1 = plan.buildRenamePlan({
      items: [
        itemOf(path.join(TEST_DIR, '测试重命名甲.png')),
        itemOf(path.join(TEST_DIR, '测试重命名乙.png'))
      ],
      rule: { mode: 'replace', find: '甲|乙', replace: '同', useRegex: true },
      existingPaths: []
    });
    const dupOk = p1.renames.length === 0 && p1.previews.length === 2
      && p1.previews.every((p) => !p.ok && p.reason.includes('同一个名字'));

    // 目标已存在（且不是本批源文件）必须判为冲突
    const srcX = path.join(TEST_DIR, '测试重命名X.png');
    const srcY = path.join(TEST_DIR, '测试重命名Y.png');
    const p2 = plan.buildRenamePlan({
      items: [itemOf(srcX)],
      rule: { mode: 'replace', find: 'X', replace: 'Y' },
      existingPaths: [srcY]
    });
    const existingOk = p2.renames.length === 0 && p2.conflicts.length === 1
      && p2.conflicts[0].reason === '目标文件已存在';

    // 目标是本批源文件（链式改名 / 互换）→ 放行
    const p3 = plan.buildRenamePlan({
      items: [itemOf(path.join(TEST_DIR, '测试重命名1.png')), itemOf(path.join(TEST_DIR, '测试重命名2.png'))],
      rule: { mode: 'affix', prefix: 'x_', suffix: '' },
      existingPaths: [path.join(TEST_DIR, '测试重命名1.png'), path.join(TEST_DIR, '测试重命名2.png')]
    });
    const chainOk = p3.renames.length === 2 && p3.conflicts.length === 0;

    // 非法正则 → errors 里有记录、该条不可执行
    const p4 = plan.buildRenamePlan({
      items: [itemOf(path.join(TEST_DIR, '测试重命名甲.png'))],
      rule: { mode: 'replace', find: '(', replace: '', useRegex: true },
      existingPaths: []
    });
    const errOk = p4.errors.length === 1 && p4.renames.length === 0;

    const ok = dupOk && existingOk && chainOk && errOk;
    result.checks.planConflicts = {
      ok,
      dupOk, existingOk, chainOk, errOk,
      dup: { renames: p1.renames.length, conflicts: p1.conflicts.length, reasons: p1.conflicts.map((p) => p.reason) },
      existing: { reason: p2.conflicts[0] && p2.conflicts[0].reason },
      chain: { renames: p3.renames.map((r) => path.basename(r.to)) }
    };
  } catch (err) {
    result.checks.planConflicts = { ok: false, error: err.message };
  }

  // —— 1e) 真实改名：序号 / 查找替换 / 加前后缀（走 fs:rename-batch 真 IPC） ——
  const live = { rounds: [], conflict: null, chain: null };
  const callRename = async (renames) => {
    const raw = await evalJs(`window.desktop.renameBatch(${JSON.stringify(renames)})`);
    return raw;
  };

  try {
    await makeFixture('测试重命名A.png', 'AAA');
    await makeFixture('测试重命名B.png', 'BBB');
    await makeFixture('测试重命名C.png', 'CCC');

    // 第 1 轮：序号（测试重命名A/B/C.png → 测试重命名_001/002/003.png）
    const round1 = await (async () => {
      const names = ['测试重命名A.png', '测试重命名B.png', '测试重命名C.png'];
      const items = names.map((n) => itemOf(path.join(TEST_DIR, n)));
      const p = plan.buildRenamePlan({
        items,
        rule: { mode: 'seq', prefix: '测试重命名_', start: 1, digits: 3 },
        existingPaths: await existingPaths()
      });
      const res = await callRename(p.renames);
      const checks = [
        { file: '测试重命名_001.png', content: readText(path.join(TEST_DIR, '测试重命名_001.png')) },
        { file: '测试重命名_002.png', content: readText(path.join(TEST_DIR, '测试重命名_002.png')) },
        { file: '测试重命名_003.png', content: readText(path.join(TEST_DIR, '测试重命名_003.png')) }
      ];
      return {
        rule: p.renames.map((r) => path.basename(r.to)),
        res,
        oldGone: names.every((n) => !exists(path.join(TEST_DIR, n))),
        newExists: checks.every((c) => c.content !== null),
        contents: checks.map((c) => c.content),
        ok: res.ok && res.done === 3 && res.failed.length === 0
          && names.every((n) => !exists(path.join(TEST_DIR, n)))
          && checks.every((c) => c.content !== null)
          && checks[0].content === 'AAA' && checks[1].content === 'BBB' && checks[2].content === 'CCC'
      };
    })();
    live.rounds.push({ name: '序号', ...round1 });

    // 第 2 轮：查找替换（测试重命名_00x.png → 测试重命名-00x.png）
    const round2 = await (async () => {
      const names = ['测试重命名_001.png', '测试重命名_002.png', '测试重命名_003.png'];
      const items = names.map((n) => itemOf(path.join(TEST_DIR, n)));
      const p = plan.buildRenamePlan({
        items,
        rule: { mode: 'replace', find: '测试重命名_', replace: '测试重命名-' },
        existingPaths: await existingPaths()
      });
      const res = await callRename(p.renames);
      const targets = ['测试重命名-001.png', '测试重命名-002.png', '测试重命名-003.png'];
      return {
        rule: p.renames.map((r) => path.basename(r.to)),
        res,
        oldGone: names.every((n) => !exists(path.join(TEST_DIR, n))),
        newExists: targets.every((n) => exists(path.join(TEST_DIR, n))),
        firstContent: readText(path.join(TEST_DIR, '测试重命名-001.png')),
        ok: res.ok && res.done === 3 && names.every((n) => !exists(path.join(TEST_DIR, n)))
          && targets.every((n) => exists(path.join(TEST_DIR, n)))
          && readText(path.join(TEST_DIR, '测试重命名-001.png')) === 'AAA'
      };
    })();
    live.rounds.push({ name: '查找替换', ...round2 });

    // 第 3 轮：加后缀（测试重命名-00x.png → 测试重命名-00x_完.png）
    // 说明：这里只加后缀——夹具名必须始终以「测试重命名」开头，收尾清理才能只清自己的文件。
    const round3 = await (async () => {
      const names = ['测试重命名-001.png', '测试重命名-002.png', '测试重命名-003.png'];
      const items = names.map((n) => itemOf(path.join(TEST_DIR, n)));
      const p = plan.buildRenamePlan({
        items,
        rule: { mode: 'affix', prefix: '', suffix: '_完' },
        existingPaths: await existingPaths()
      });
      const res = await callRename(p.renames);
      const targets = ['测试重命名-001_完.png', '测试重命名-002_完.png', '测试重命名-003_完.png'];
      return {
        rule: p.renames.map((r) => path.basename(r.to)),
        res,
        oldGone: names.every((n) => !exists(path.join(TEST_DIR, n))),
        newExists: targets.every((n) => exists(path.join(TEST_DIR, n))),
        lastContent: readText(path.join(TEST_DIR, '测试重命名-003_完.png')),
        ok: res.ok && res.done === 3 && names.every((n) => !exists(path.join(TEST_DIR, n)))
          && targets.every((n) => exists(path.join(TEST_DIR, n)))
          && readText(path.join(TEST_DIR, '测试重命名-003_完.png')) === 'CCC'
      };
    })();
    live.rounds.push({ name: '加后缀', ...round3 });
  } catch (err) {
    live.rounds.push({ name: '真实改名', ok: false, error: err.message });
  }

  // —— 1f) 安全性：目标已存在必须跳过并报原因 ——
  try {
    const x = await makeFixture('测试重命名X.png', 'XXX');
    const y = await makeFixture('测试重命名Y.png', 'YYY');
    const res = await callRename([{ from: y, to: x }]);
    live.conflict = {
      res,
      refused: res.ok === false && res.done === 0 && res.failed.length === 1
        && /目标文件已存在/.test(res.failed[0].message),
      bothStillThere: exists(x) && exists(y),
      contents: { x: readText(x), y: readText(y) },
      ok: false
    };
    live.conflict.ok = live.conflict.refused && live.conflict.bothStillThere
      && live.conflict.contents.x === 'XXX' && live.conflict.contents.y === 'YYY';
  } catch (err) {
    live.conflict = { ok: false, error: err.message };
  }

  // —— 1g) 安全性：链式改名不互相踩（1→2、2→3） ——
  try {
    const f1 = await makeFixture('测试重命名1.png', 'ONE');
    const f2 = await makeFixture('测试重命名2.png', 'TWO');
    const f3 = path.join(TEST_DIR, '测试重命名3.png');
    const res = await callRename([{ from: f1, to: f2 }, { from: f2, to: f3 }]);
    live.chain = {
      res,
      started: exists(f1) && exists(f2) && !exists(f3),
      oldGone: !exists(f1) && !exists(f2),
      newFiles: { two: readText(f2), three: readText(f3) },
      ok: false
    };
    live.chain.ok = res.ok && res.done === 2 && res.failed.length === 0
      && !exists(f1) && readText(f2) === 'ONE' && readText(f3) === 'TWO';
  } catch (err) {
    live.chain = { ok: false, error: err.message };
  }

  result.checks.真实改名 = {
    ok: live.rounds.length === 3 && live.rounds.every((r) => r.ok)
      && !!live.conflict && live.conflict.ok
      && !!live.chain && live.chain.ok,
    ...live
  };

  // —— 汇总 ——
  const names = ['formatDate', 'applyRule', 'validateFileName', 'planConflicts', '真实改名'];
  result.summary = Object.fromEntries(names.map((n) => [n, !!(result.checks[n] && result.checks[n].ok)]));
  result.ok = names.every((n) => result.summary[n]);

  await cleanFixtures(); // 收尾清一次
  writeResult({ ok: result.ok, at: new Date().toISOString(), result });
  return result;
}

// ============================================================
// 2) 界面自动测试（切工具 → 添加 → 设规则 → 读预览 → 执行 → 截图 → 核对磁盘）
// ============================================================

async function runBatchRenameUiTest(win) {
  const wc = win.webContents;
  const evalJs = (code) => wc.executeJavaScript(code);
  const result = { pass: false, failures: [], steps: {}, shots: [] };

  await fs.mkdir(TEST_DIR, { recursive: true });
  await cleanFixtures(); // 开跑清一次

  const shot = async (name) => {
    const file = path.join(TEST_DIR, `shot-bren-${name}.png`);
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

  const getStatus = () => evalJs('document.getElementById("statusText").textContent');

  /** 等一次运行结束：状态文案变化 + 进度条收起（或超时） */
  async function waitForFinish(statusBefore, timeoutMs) {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      const raw = await evalJs(`JSON.stringify({
        status: document.getElementById("statusText").textContent,
        progressHidden: document.getElementById("progressBar").hidden
      })`);
      const o = JSON.parse(raw);
      last = o.status;
      if (o.status !== statusBefore && o.progressHidden) return { ok: true, status: o.status, ms: Date.now() - t0 };
      await wait(400);
    }
    return { ok: false, status: last, timeout: true };
  }

  const readPreview = async () => JSON.parse(await evalJs(`JSON.stringify(
    [...document.querySelectorAll('#brenList .bren-item')].map((li) => ({
      from: li.dataset.from, fromName: li.dataset.fromName, toName: li.dataset.toName,
      bad: li.classList.contains('is-bad')
    }))
  )`));

  // 夹具：三个以「测试重命名」开头的文件（测试模式下对话框只返回这类文件）
  await makeFixture('测试重命名甲.png', '甲甲');
  await makeFixture('测试重命名乙.png', '乙乙');
  await makeFixture('测试重命名丙.png', '丙丙');

  await shot('01-起点');

  // 1) 切到本工具（左侧分组默认收起，按钮不可见时先展开所在分组）
  result.steps.reveal = await evalJs(`(() => {
    const btn = document.querySelector('.tool-item[data-tool-id="batch-rename"]');
    if (!btn) return 'no-button';
    const group = btn.closest('.tool-group');
    if (group && group.classList.contains('is-collapsed')) {
      const head = group.querySelector('.tool-group-head');
      if (head) head.click();
      return 'expanded';
    }
    return 'visible';
  })()`);
  await wait(400);
  result.steps.switched = await evalJs(`(() => {
    const btn = document.querySelector('.tool-item[data-tool-id="batch-rename"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await wait(500);
  if (!result.steps.switched) result.failures.push('左侧没有找到「批量重命名」工具');
  await shot('02-工具页');

  // 2) 加文件
  result.steps.added = await evalJs(`(() => {
    const btn = document.querySelector('[data-add]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await wait(1500);
  const statusAfterAdd = await getStatus();
  result.steps.addStatus = statusAfterAdd;

  const previewDefault = await readPreview();
  result.steps.previewDefault = previewDefault;
  if (previewDefault.length !== 3) result.failures.push(`应添加 3 个夹具文件，实际列表 ${previewDefault.length} 个`);

  // 3) 设规则：序号 001、两位、前缀「改名_」
  result.steps.ruleSet = await evalJs(`(() => {
    const set = (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    return set('#brenMode', 'seq') && set('#brenSeqStart', '1') && set('#brenSeqDigits', '2') && set('#brenSeqPrefix', '测试重命名UI_');
  })()`);
  await wait(400);
  const preview = await readPreview();
  result.steps.preview = preview;
  await shot('03-预览');

  const previewOk = preview.length === 3
    && preview.every((p) => !p.bad && /^测试重命名UI_\d{2}\.png$/.test(p.toName));
  if (!previewOk) result.failures.push(`预览不符合预期：${JSON.stringify(preview)}`);

  // 4) 执行
  result.steps.ran = await evalJs(`(() => {
    const btn = document.querySelector('[data-run]');
    if (!btn) return false;
    if (btn.disabled) return 'disabled';
    btn.click();
    return true;
  })()`);
  const finish = await waitForFinish(statusAfterAdd, 60000);
  result.steps.finish = finish;
  await wait(400);
  await shot('04-完成');
  if (!finish.ok) result.failures.push(`执行未在超时内结束：${JSON.stringify(finish)}`);

  // 5) 核对磁盘：预览里的每个「原名 → 新名」都必须真的落盘
  const disk = preview.map((p) => {
    const toFull = path.join(TEST_DIR, p.toName);
    return {
      fromName: p.fromName,
      toName: p.toName,
      oldGone: !exists(p.from),
      newExists: exists(toFull),
      content: readText(toFull)
    };
  });
  result.steps.disk = disk;
  const diskOk = disk.length === 3 && disk.every((d) => d.oldGone && d.newExists && d.content);
  if (!diskOk) result.failures.push(`磁盘改名结果与预览不一致：${JSON.stringify(disk)}`);
  if (!/成功 3 个/.test(finish.status || '')) result.failures.push(`完成文案不含「成功 3 个」：${finish.status}`);

  await cleanFixtures(); // 收尾清一次

  result.pass = result.failures.length === 0;
  writeResult({ ok: result.pass, at: new Date().toISOString(), result }, UI_RESULT_FILE);
  return result;
}

module.exports = { runBatchRenameTest, runBatchRenameUiTest, writeResult, TEST_DIR, RESULT_FILE, UI_RESULT_FILE };