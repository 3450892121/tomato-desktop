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
      && p2.conflicts[0].status === 'skip'
      && /目标文件已存在/.test(p2.conflicts[0].reason);

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

  // —— 1d-2) 排序：按修改时间正序 / 倒序（稳定，取不到时间的沉底） ——
  try {
    const mk = (name, t) => ({ path: path.join(TEST_DIR, name), mtimeMs: t });
    const items = [mk('测试重命名a.png', 3000), mk('测试重命名b.png', 1000), mk('测试重命名c.png', 2000), mk('测试重命名d.png', 1000)];
    const asc = plan.sortItems(items, 'time-asc').map((x) => path.basename(x.path));
    const desc = plan.sortItems(items, 'time-desc').map((x) => path.basename(x.path));
    const none = plan.sortItems(items, 'none').map((x) => path.basename(x.path));
    const mixed = plan.sortItems([mk('测试重命名x.png', 0), mk('测试重命名y.png', 500), mk('测试重命名z.png', 0)], 'time-asc')
      .map((x) => path.basename(x.path));
    const uniq = plan.uniqueNameFor('照片_001.png', (n) => n === '照片_001(1).png');
    const ok = asc.join(',') === '测试重命名b.png,测试重命名d.png,测试重命名c.png,测试重命名a.png' // b/d 同一时刻保持原顺序
      && desc.join(',') === '测试重命名a.png,测试重命名c.png,测试重命名b.png,测试重命名d.png'
      && none.join(',') === '测试重命名a.png,测试重命名b.png,测试重命名c.png,测试重命名d.png'
      && mixed.join(',') === '测试重命名y.png,测试重命名x.png,测试重命名z.png'                // 无时间的沉底
      && uniq === '照片_001(2).png'
      && plan.formatDateTime(new Date(2026, 8, 21, 9, 5).getTime()) === '2026-09-21 09:05'
      && plan.formatDateTime(0) === '';
    result.checks.sortItems = { ok, asc, desc, none, mixed, uniq, dt: plan.formatDateTime(new Date(2026, 8, 21, 9, 5).getTime()) };
  } catch (err) {
    result.checks.sortItems = { ok: false, error: err.message };
  }

  // —— 1d-3) 冲突三策略：跳过 / 替换 / 自动编号 ——
  try {
    const item = itemOf(path.join(TEST_DIR, '测试重命名甲.png'));
    // 占位文件名 = 「替换」规则算出来的目标名（测试重命名甲 → 测试重命名同）
    const occupied = [path.join(TEST_DIR, '测试重命名同.png')];

    const skipPlan = plan.buildRenamePlan({
      items: [item], rule: { mode: 'replace', find: '甲', replace: '同' },
      existingPaths: occupied, conflictMode: 'skip'
    });
    const overwritePlan = plan.buildRenamePlan({
      items: [item], rule: { mode: 'replace', find: '甲', replace: '同' },
      existingPaths: occupied, conflictMode: 'overwrite'
    });
    const autoPlan = plan.buildRenamePlan({
      items: [item], rule: { mode: 'replace', find: '甲', replace: '同' },
      existingPaths: occupied, conflictMode: 'auto'
    });
    // 自动编号要避开「磁盘上占着的」和「本批已经用掉的」两类名字
    const auto2Plan = plan.buildRenamePlan({
      items: [item],
      rule: { mode: 'replace', find: '甲', replace: '同' },
      existingPaths: [...occupied, path.join(TEST_DIR, '测试重命名同(1).png')],
      conflictMode: 'auto'
    });
    // 批内重名：跳过/替换两条都拒绝；自动编号第一条保留、第二条加编号
    // （用「替换」把两个不同的名字换成同一个，制造真正的批内重名）
    const dupItems = [itemOf(path.join(TEST_DIR, '测试重命名A1.png')), itemOf(path.join(TEST_DIR, '测试重命名A2.png'))];
    const dupRule = { mode: 'replace', find: 'A1|A2', replace: '同批', useRegex: true };
    const dupSkip = plan.buildRenamePlan({ items: dupItems, rule: dupRule, existingPaths: [], conflictMode: 'skip' });
    const dupAuto = plan.buildRenamePlan({ items: dupItems, rule: dupRule, existingPaths: [], conflictMode: 'auto' });
    const dupOver = plan.buildRenamePlan({ items: dupItems, rule: dupRule, existingPaths: [], conflictMode: 'overwrite' });

    const ok = skipPlan.okCount === 0 && skipPlan.skipCount === 1 && skipPlan.renames.length === 0
      && overwritePlan.okCount === 1 && overwritePlan.overwriteCount === 1 && overwritePlan.renames[0].overwrite === true
      && autoPlan.okCount === 1 && autoPlan.autoCount === 1 && autoPlan.renames[0].to.endsWith('同(1).png')
      && auto2Plan.renames[0].to.endsWith('同(2).png')
      && dupSkip.okCount === 0 && dupSkip.conflicts.length === 2
      && dupOver.okCount === 0 && dupOver.conflicts.length === 2
      && dupAuto.okCount === 2 && dupAuto.autoCount === 1
      && path.basename(dupAuto.renames[0].to) === '测试重命名同批.png'
      && path.basename(dupAuto.renames[1].to) === '测试重命名同批(1).png';
    result.checks.conflictModes = {
      ok,
      skip: { ok: skipPlan.okCount, reason: skipPlan.conflicts[0] && skipPlan.conflicts[0].reason },
      overwrite: { ok: overwritePlan.okCount, flag: overwritePlan.renames[0] && overwritePlan.renames[0].overwrite },
      auto: autoPlan.renames.map((r) => path.basename(r.to)),
      auto2: auto2Plan.renames.map((r) => path.basename(r.to)),
      dupAuto: dupAuto.renames.map((r) => path.basename(r.to)),
      dupSkip: dupSkip.conflicts.map((c) => c.reason)
    };
  } catch (err) {
    result.checks.conflictModes = { ok: false, error: err.message };
  }

  // —— 1e) 真实改名：序号 / 查找替换 / 加前后缀（走 fs:rename-batch 真 IPC） ——
  const live = { rounds: [], conflict: null, chain: null };
  const callRename = async (renames) => {
    const raw = await evalJs(`window.desktop.renameBatch(${JSON.stringify(renames)})`);
    return raw;
  };
  /** 目录里现存的临时名（改名中途的中间态）：1h) 只比对「本批新增的」残留，历史遗留不算本工具的账 */
  const tmpNames = async () => (await fs.readdir(TEST_DIR).catch(() => []))
    .filter((n) => n.startsWith('.tomato-rename-'));
  const tmpBefore = await tmpNames();

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

  // —— 1h) 冲突三策略的真实落盘：替换要备份后覆盖、自动编号要真落到新名字 ——
  try {
    // 替换：O2 → O1（O1 已存在），带 overwrite:true 时内容应变成 O2 的，且不能留下临时/备份文件
    const o1 = await makeFixture('测试重命名O1.png', 'OLD');
    const o2 = await makeFixture('测试重命名O2.png', 'NEW');
    const res = await callRename([{ from: o2, to: o1, overwrite: true }]);
    live.overwrite = {
      res,
      oldSourceGone: !exists(o2),
      targetContent: readText(o1),
      overwritten: res.overwritten,
      ok: res.ok && res.done === 1 && res.failed.length === 0 && res.overwritten === 1
        && !exists(o2) && readText(o1) === 'NEW'
    };

    // 自动编号：走 plan（auto）算出名字，再真改名
    // 注：夹具名一律以「测试重命名」开头，收尾的 cleanFixtures 才能只清自己的文件
    const a1 = await makeFixture('测试重命名自动.png', 'AUTO');
    const occupied = path.join(TEST_DIR, '测试重命名自动_001.png');
    await makeFixture('测试重命名自动_001.png', 'OCCUPIED');
    const autoPlan = plan.buildRenamePlan({
      items: [itemOf(a1)],
      rule: { mode: 'seq', prefix: '测试重命名自动_', start: 1, digits: 3 },
      existingPaths: await existingPaths(),
      conflictMode: 'auto'
    });
    const autoRes = await callRename(autoPlan.renames);
    const autoTarget = path.join(TEST_DIR, '测试重命名自动_001(1).png');
    live.auto = {
      planned: autoPlan.renames.map((r) => path.basename(r.to)),
      res: autoRes,
      movedExists: exists(autoTarget),
      content: readText(autoTarget),
      occupiedKept: readText(occupied),
      ok: autoRes.ok && autoRes.done === 1
        && exists(autoTarget) && readText(autoTarget) === 'AUTO'
        && readText(occupied) === 'OCCUPIED'
    };

    // 收尾：本批跑完不能在夹具目录里留下临时名 / 备份名（历史遗留的垃圾不算本工具新增）
    const tmpAfter = await tmpNames();
    const leftovers = tmpAfter.filter((n) => !tmpBefore.includes(n));
    live.noLeftover = { leftovers, before: tmpBefore, after: tmpAfter, ok: leftovers.length === 0 };
  } catch (err) {
    live.overwrite = live.overwrite || { ok: false, error: err.message };
    live.noLeftover = live.noLeftover || { ok: false, error: err.message };
  }

  // 注意：这一步必须在 1h) 之后——{...live} 是快照，写在前面会漏掉 overwrite / auto / noLeftover
  result.checks.真实改名 = {
    ok: live.rounds.length === 3 && live.rounds.every((r) => r.ok)
      && !!live.conflict && live.conflict.ok
      && !!live.chain && live.chain.ok
      && !!live.overwrite && live.overwrite.ok
      && !!live.auto && live.auto.ok
      && !!live.noLeftover && live.noLeftover.ok,
    ...live
  };

  // —— 汇总 ——
  const names = ['formatDate', 'applyRule', 'validateFileName', 'planConflicts', 'sortItems', 'conflictModes', '真实改名'];
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
  await cleanLogs();     // 上一次留下的日志 CSV 会被清掉（它不以「测试重命名」开头）

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
      bad: li.classList.contains('is-bad'),
      skip: li.classList.contains('is-skip'),
      status: li.dataset.status || '',
      mtime: Number(li.dataset.mtime) || 0,
      time: (li.querySelector('.bren-time') || {}).textContent || '',
      tag: (li.querySelector('.bren-tag') || {}).textContent || ''
    }))
  )`));

  /** 设置某个控件的值并触发 input/change（和真人打字/选择等效） */
  const setField = (sel, val) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.value = ${JSON.stringify(String(val))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  const clickRun = () => evalJs(`(() => {
    const btn = document.querySelector('[data-run]');
    if (!btn) return 'no-button';
    if (btn.disabled) return 'disabled';
    btn.click();
    return true;
  })()`);

  /** 只等确认弹窗出现并读下它的文案（不点按钮），用于截图与断言 */
  async function waitForDialog(timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const raw = await evalJs(`(() => {
        const box = document.querySelector('.modal-backdrop .bren-confirm');
        if (!box) return '';
        const btn = document.querySelector('.modal-backdrop [data-confirm]');
        return JSON.stringify({
          summary: (box.querySelector('.bren-confirm-summary') || {}).textContent || '',
          warn: (box.querySelector('.bren-confirm-warn') || {}).textContent || '',
          rows: box.querySelectorAll('.bren-confirm-row').length,
          hasConfirm: !!btn
        });
      })()`);
      if (raw) return JSON.parse(raw);
      await wait(150);
    }
    return null;
  }

  /** 点确认弹窗里的「确认改名」 */
  const clickDialogConfirm = () => evalJs(`(() => {
    const b = document.querySelector('.modal-backdrop [data-confirm]');
    if (!b) return false;
    b.click();
    return true;
  })()`);

  /** 等执行前的确认弹窗出现，读下它的文案并点「确认」；返回弹窗信息或 null（超时） */
  async function confirmDialog(timeoutMs = 8000) {
    const info = await waitForDialog(timeoutMs);
    if (!info) return null;
    await clickDialogConfirm();
    return info;
  }

  /** 等确认弹窗出现后点「取消」（验证取消不会动文件） */
  async function cancelDialog(timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const found = await evalJs(`(() => {
        const box = document.querySelector('.modal-backdrop .bren-confirm');
        if (!box) return false;
        const btns = [...box.querySelectorAll('.modal-actions .btn')];
        const cancel = btns.find((b) => !b.dataset.confirm);
        if (cancel) cancel.click();
        return true;
      })()`);
      if (found) return true;
      await wait(200);
    }
    return false;
  }

  /** 清掉本测试产出的日志文件（名字不以「测试重命名」开头，cleanFixtures 清不到） */
  async function cleanLogs() {
    const names = await fs.readdir(TEST_DIR).catch(() => []);
    for (const name of names) {
      if (name.startsWith('重命名日志-') || name === '占位.png' || name.startsWith('占位(')) {
        await fs.rm(path.join(TEST_DIR, name), { force: true });
      }
    }
  }

  // 夹具：三个以「测试重命名」开头的文件（测试模式下对话框只返回这类文件）
  // 修改时间刻意错开：甲最旧、丙最新（用来验证「按修改时间排序」真的改变了顺序与编号）
  const fA = await makeFixture('测试重命名甲.png', '甲甲');
  const fB = await makeFixture('测试重命名乙.png', '乙乙');
  const fC = await makeFixture('测试重命名丙.png', '丙丙');
  const baseT = Date.now() - 3 * 24 * 3600 * 1000;
  await fs.utimes(fA, new Date(baseT), new Date(baseT));
  await fs.utimes(fB, new Date(baseT + 24 * 3600 * 1000), new Date(baseT + 24 * 3600 * 1000));
  await fs.utimes(fC, new Date(baseT + 2 * 24 * 3600 * 1000), new Date(baseT + 2 * 24 * 3600 * 1000));

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

  // 3) 排序方式：先看默认（按添加顺序），再切「旧 → 新」「新 → 旧」，预览顺序与修改日期列都要跟着变
  const namesOf = (list) => list.map((p) => p.fromName);
  result.steps.sortControls = await evalJs(`(() => {
    const s = document.querySelector('#brenSort');
    const c = document.querySelector('#brenConflict');
    return JSON.stringify({
      sort: s ? [...s.options].map((o) => o.value) : null,
      conflict: c ? [...c.options].map((o) => o.value) : null
    });
  })()`);
  const controls = JSON.parse(result.steps.sortControls || '{}');
  if (!controls.sort || controls.sort.join(',') !== 'none,time-asc,time-desc') {
    result.failures.push(`排序下拉选项不符合预期：${result.steps.sortControls}`);
  }
  if (!controls.conflict || controls.conflict.join(',') !== 'skip,overwrite,auto') {
    result.failures.push(`冲突处理下拉选项不符合预期：${result.steps.sortControls}`);
  }

  await setField('#brenSort', 'time-asc');
  await wait(300);
  const previewAsc = await readPreview();
  await setField('#brenSort', 'time-desc');
  await wait(300);
  const previewDesc = await readPreview();
  result.steps.sort = { add: namesOf(previewDefault), asc: namesOf(previewAsc), desc: namesOf(previewDesc) };
  await shot('03a-排序');

  const timeShown = previewAsc.every((p) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(p.time) && p.mtime > 0);
  if (namesOf(previewAsc).join(',') !== '测试重命名甲.png,测试重命名乙.png,测试重命名丙.png') {
    result.failures.push(`按修改时间正序不对：${JSON.stringify(result.steps.sort.asc)}`);
  }
  if (namesOf(previewDesc).join(',') !== '测试重命名丙.png,测试重命名乙.png,测试重命名甲.png') {
    result.failures.push(`按修改时间倒序不对：${JSON.stringify(result.steps.sort.desc)}`);
  }
  if (!timeShown) result.failures.push(`修改日期列没显示出来：${JSON.stringify(previewAsc.map((p) => p.time))}`);

  // 4) 设规则：序号 + 前缀「测试重命名UI_」（位数用界面默认的 3 位；顺序 = 旧→新，甲最旧 = 001、丙最新 = 003）
  result.steps.ruleSet = await setField('#brenSort', 'time-asc')
    && await setField('#brenMode', 'seq')
    && await setField('#brenSeqStart', '1')
    && await setField('#brenSeqPrefix', '测试重命名UI_');
  await wait(400);
  const preview = await readPreview();
  result.steps.preview = preview;
  await shot('03-预览');

  const previewOk = preview.length === 3
    && preview.every((p) => !p.bad && /^测试重命名UI_\d{3}\.png$/.test(p.toName));
  if (!previewOk) result.failures.push(`预览不符合预期：${JSON.stringify(preview)}`);
  // 排序必须真的决定编号：甲(最旧)→001、乙→002、丙(最新)→003
  const mappingOk = preview.map((p) => `${p.fromName}→${p.toName}`).join(',')
    === '测试重命名甲.png→测试重命名UI_001.png,测试重命名乙.png→测试重命名UI_002.png,测试重命名丙.png→测试重命名UI_003.png';
  if (!mappingOk) result.failures.push(`编号没有按排序结果分配：${JSON.stringify(preview.map((p) => `${p.fromName}→${p.toName}`))}`);

  // 5) 先点一次「开始重命名」再取消：确认弹窗必须出现，取消后磁盘一个都不许动
  result.steps.cancelled = await clickRun();
  const dialogShown = await waitForDialog();
  await shot('04-确认弹窗'); // 弹窗开着的时候拍，截图才有说服力
  const cancelSeen = dialogShown ? await cancelDialog() : false;
  await wait(600);
  const untouchedAfterCancel = !exists(path.join(TEST_DIR, '测试重命名UI_001.png'))
    && exists(fA) && exists(fB) && exists(fC);
  result.steps.cancelDialog = { seen: cancelSeen, dialog: dialogShown, untouched: untouchedAfterCancel, status: await getStatus() };
  if (!cancelSeen) result.failures.push('点「开始重命名」后没有出现确认弹窗');
  if (!untouchedAfterCancel) result.failures.push('确认弹窗里点了取消，但文件已经被改动了');

  // 6) 再走一遍：这次在确认弹窗里点「确认改名」
  result.steps.ran = await clickRun();
  const dialog = await confirmDialog();
  result.steps.confirmDialog = dialog;
  if (!dialog) {
    result.failures.push('确认弹窗没等到（超时）');
  } else if (!/将改名 3 个/.test(dialog.summary)) {
    result.failures.push(`确认弹窗概要不对：${dialog.summary}`);
  }
  if (dialogShown && !/将改名 3 个/.test(dialogShown.summary)) {
    result.failures.push(`确认弹窗（取消那次）概要不对：${dialogShown.summary}`);
  }
  const finish = await waitForFinish(statusAfterAdd, 60000);
  result.steps.finish = finish;
  await wait(400);
  await shot('05-完成');
  if (!finish.ok) result.failures.push(`执行未在超时内结束：${JSON.stringify(finish)}`);

  // 7) 核对磁盘：预览里的每个「原名 → 新名」都必须真的落盘，且内容跟着名字走（验证编号顺序）
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
  const contentsOk = readText(path.join(TEST_DIR, '测试重命名UI_001.png')) === '甲甲'
    && readText(path.join(TEST_DIR, '测试重命名UI_002.png')) === '乙乙'
    && readText(path.join(TEST_DIR, '测试重命名UI_003.png')) === '丙丙';
  if (!contentsOk) result.failures.push('排序后的编号与文件内容对不上（001 应为最旧的「甲甲」）');
  if (!/成功 3 个/.test(finish.status || '')) result.failures.push(`完成文案不含「成功 3 个」：${finish.status}`);
  result.steps.stats = await evalJs('document.getElementById("brenResult").textContent');

  // 8) 导出日志：点「导出日志」应生成 CSV（UTF-8 BOM），逐条记下原名/修改时间/新名/结果
  await evalJs(`(() => { const b = document.getElementById('brenExportBtn'); if (b) b.click(); return true; })()`);
  await wait(1200);
  const logNames = (await fs.readdir(TEST_DIR).catch(() => [])).filter((n) => n.startsWith('重命名日志-') && n.endsWith('.csv'));
  const logFile = logNames.length ? path.join(TEST_DIR, logNames[0]) : '';
  const logText = logFile ? (fsSync.readFileSync(logFile, 'utf8')) : '';
  const logLines = logText.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  result.steps.log = {
    file: logFile,
    lines: logLines.length,
    header: logLines[0],
    rows: logLines.slice(1),
    status: await getStatus()
  };
  const logOk = logNames.length === 1
    && logText.startsWith('\uFEFF')
    && logLines.length === 4
    && logLines[0] === '序号,原文件名,原路径,修改时间,新文件名,结果,说明'
    && logLines.slice(1).every((l) => l.includes('成功') && l.includes('测试重命名UI_'))
    && logLines[1].includes('测试重命名甲.png');
  if (!logOk) result.failures.push(`导出的日志不符合预期：${JSON.stringify(result.steps.log)}`);
  await shot('06-日志');

  // 9) 冲突处理三策略（同一批夹具切三种模式，看预览怎么变；最后真跑一次「自动编号」）
  //    占位文件刻意不以「测试重命名」开头：这样它不会被对话框选进列表，才是真正的「目标已存在」
  await cleanFixtures();
  await cleanLogs();
  await evalJs(`(() => { const b = document.querySelector('[data-clear]'); if (b) b.click(); return true; })()`);
  await wait(300);
  await makeFixture('测试重命名覆A.png', 'AAA2');
  await makeFixture('占位.png', 'OLD2');
  await evalJs(`(() => { const b = document.querySelector('[data-add]'); if (b) b.click(); return true; })()`);
  await wait(1200);
  const statusAfterAdd2 = await getStatus();

  await setField('#brenMode', 'replace');
  await setField('#brenFind', '测试重命名覆A');
  await setField('#brenReplace', '占位');
  await setField('#brenSort', 'none');
  await setField('#brenConflict', 'skip');
  await wait(400);
  const conflictSkip = await readPreview();
  const skipRunBtn = await evalJs('document.getElementById("brenRunBtn").disabled');
  await setField('#brenConflict', 'overwrite');
  await wait(400);
  const conflictOverwrite = await readPreview();
  const overwriteWarnShown = await evalJs('!document.getElementById("brenOverwriteWarn").hidden');
  await setField('#brenConflict', 'auto');
  await wait(400);
  const conflictAuto = await readPreview();
  result.steps.conflicts = {
    skip: conflictSkip.map((p) => `${p.fromName}→${p.toName}(${p.status})`),
    overwrite: conflictOverwrite.map((p) => `${p.fromName}→${p.toName}(${p.tag})`),
    auto: conflictAuto.map((p) => `${p.fromName}→${p.toName}(${p.tag})`),
    skipRunDisabled: skipRunBtn,
    overwriteWarnShown
  };
  await shot('07-冲突策略');

  if (!(conflictSkip.length === 1 && conflictSkip[0].skip && skipRunBtn === true)) {
    result.failures.push(`「跳过」模式下应显示为不改且不能执行：${JSON.stringify(result.steps.conflicts.skip)}`);
  }
  if (!(conflictOverwrite.length === 1 && conflictOverwrite[0].tag === '覆盖' && overwriteWarnShown)) {
    result.failures.push(`「替换」模式预览不对：${JSON.stringify(result.steps.conflicts.overwrite)}，警告条显示=${overwriteWarnShown}`);
  }
  if (!(conflictAuto.length === 1 && conflictAuto[0].toName === '占位(1).png' && conflictAuto[0].tag === '自动编号')) {
    result.failures.push(`「自动编号」模式预览不对：${JSON.stringify(result.steps.conflicts.auto)}`);
  }

  // 真跑一次自动编号：占位.png 必须原样不动，改名结果落到「占位(1).png」
  result.steps.ran2 = await clickRun();
  const dialog2 = await confirmDialog();
  const finish2 = await waitForFinish(statusAfterAdd2, 60000);
  const autoTarget = path.join(TEST_DIR, '占位(1).png');
  result.steps.auto = {
    dialog: dialog2,
    finish: finish2,
    occupiedKept: readText(path.join(TEST_DIR, '占位.png')),
    movedExists: exists(autoTarget),
    movedContent: readText(autoTarget),
    stats: await evalJs('document.getElementById("brenResult").textContent')
  };
  await shot('08-自动编号');
  if (!(finish2.ok && /成功 1 个/.test(finish2.status || '') && /自动编号 1 个/.test(result.steps.auto.stats || ''))) {
    result.failures.push(`自动编号这一轮的结果不对：${JSON.stringify(result.steps.auto)}`);
  }
  if (!(result.steps.auto.occupiedKept === 'OLD2' && result.steps.auto.movedContent === 'AAA2')) {
    result.failures.push(`自动编号把已有文件动了或内容不对：${JSON.stringify(result.steps.auto)}`);
  }

  await cleanFixtures(); // 收尾清一次
  await cleanLogs();

  result.pass = result.failures.length === 0;
  writeResult({ ok: result.pass, at: new Date().toISOString(), result }, UI_RESULT_FILE);
  return result;
}

module.exports = { runBatchRenameTest, runBatchRenameUiTest, writeResult, TEST_DIR, RESULT_FILE, UI_RESULT_FILE };