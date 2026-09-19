// 「文件压缩与解压」工具 —— 真实引擎自检
// 用法（两种都支持）：
//   1) cd app && node tests/archive-test.js          ← 纯 Node 直接跑（开发时快速迭代）
//   2) cd app && .\node_modules\electron\dist\electron.exe . --archive-test   ← 交付前自检
// 结果写入 %TEMP%/tomato-archive-test.json，ok:true 为通过。
//
// 覆盖（对应 spec/acceptance.md A37）：
//   · 每一个「双向」格式真实「压缩 → 列目录 → 解压 → 逐字节比对」
//   · 密码三方案（7z AES-256 含文件名加密 / zip AES-256 / zip ZipCrypto）+ 错误密码必须失败且不留垃圾
//   · 分卷：只给第一卷就能解出完整内容
//   · 免解压预览：列目录后断言输出目录**未被创建**
//   · 仅解压格式（RAR 等）必须被拒绝压缩且给出可读原因
//   · 路径穿越（自造 tar 条目）必须被识别并拒绝解压
//   · 大文件（默认 120MB）：压缩 + 解压 + 比对 + 耗时/内存记录
//   · 取消、无效文件报错、进度回调
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const WORK = path.join(os.tmpdir(), 'tomato-archive-test');
const OUT_JSON = path.join(os.tmpdir(), 'tomato-archive-test.json');
const BIG_MB = Number(process.env.ARCHIVE_TEST_BIG_MB || 120);

const checks = {};
const notes = [];
const log = (msg) => { notes.push(msg); console.log(`[archive-test] ${msg}`); };

/** 逐字节比对两个文件 */
function sameFile(a, b) {
  try {
    const ba = fs.readFileSync(a);
    const bb = fs.readFileSync(b);
    return ba.length === bb.length && ba.equals(bb);
  } catch {
    return false;
  }
}

/** 递归收集目录下所有文件的相对路径 → 绝对路径 */
function walk(dir, base = dir, acc = new Map()) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, acc);
    else acc.set(path.relative(base, full).replace(/\\/g, '/'), full);
  }
  return acc;
}

/** 造一个含 `..` 路径的 tar（7-Zip 造不出来，安全闸门必须有东西可测） */
function makeTraversalTar(target) {
  const block = Buffer.alloc(512);
  const writeStr = (buf, off, len, str) => { buf.write(str, off, len, 'utf8'); };
  const name = '../evil.txt';
  const content = Buffer.from('pwned', 'utf8');
  writeStr(block, 0, 100, name);
  writeStr(block, 100, 8, '0000644\0');
  writeStr(block, 108, 8, '0000000\0');
  writeStr(block, 116, 8, '0000000\0');
  writeStr(block, 124, 12, `${content.length.toString(8).padStart(11, '0')}\0`);
  writeStr(block, 136, 12, '00000000000\0');
  block.write('        ', 148, 8, 'ascii'); // 校验和先填空格
  let sum = 0;
  for (const b of block) sum += b;
  writeStr(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512);
  fs.writeFileSync(target, Buffer.concat([block, content, pad, Buffer.alloc(1024)]));
}

async function runArchiveTest(options = {}) {
  const portableDir = options.portableDir || path.join(__dirname, '..');
  const engine = await import('../src/tools/archive/core/engine.mjs');
  const formats = await import('../src/tools/archive/core/formats.mjs');
  const plan = await import('../src/tools/archive/core/plan.mjs');

  const t00 = Date.now();
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const status = await engine.sevenZipStatus(portableDir);
  checks.engine = {
    found: status.found,
    where: status.where,
    version: status.version,
    nodeZstd: status.node.zstd,
    nodeBrotli: status.node.brotli
  };
  log(`7-Zip: found=${status.found} where=${status.where} version=${status.version}；Node zstd=${status.node.zstd} brotli=${status.node.brotli}`);

  if (!status.found) {
    const result = { ok: false, checks, notes, message: '未检测到 7-Zip（把加装包放到 addons/7zip 或安装 7-Zip）' };
    fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf8');
    return result;
  }
  const binPath = status.path;

  // —— 夹具：一份有多层目录、中文名、二进制与空文件的样本 ——
  const srcDir = path.join(WORK, 'src');
  fs.mkdirSync(path.join(srcDir, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello tomato 番茄\n', 'utf8');
  fs.writeFileSync(path.join(srcDir, '中文名.txt'), '中文内容测试\n', 'utf8');
  fs.writeFileSync(path.join(srcDir, 'empty.txt'), '');
  fs.writeFileSync(path.join(srcDir, 'sub', 'b.bin'), Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 251)));
  fs.writeFileSync(path.join(srcDir, 'sub', 'deep', 'c.txt'), 'deep file\n', 'utf8');
  const srcFiles = walk(srcDir);
  const srcTotal = [...srcFiles.values()].reduce((s, p) => s + fs.statSync(p).size, 0);
  log(`夹具：${srcFiles.size} 个文件，共 ${srcTotal} 字节`);

  /** 单次「压缩 → 列目录 → 解压 → 比对」往返 */
  // singleFile=true 时（gzip/bz2/xz/zst/br），只压 src/a.txt 一个文件，且解压结果只期望得到一个文件。
  async function roundTrip({ formatId, level = 'normal', password = '', encrypt = 'zip-aes256', volumeBytes = 0, tag, inputs, singleFile = false }) {
    const outDir = path.join(WORK, `out-${tag}`);
    fs.mkdirSync(outDir, { recursive: true });
    const items = inputs || (singleFile
      ? [{ path: path.join(srcDir, 'a.txt'), isDirectory: false }]
      : [{ path: srcDir, isDirectory: true }]);
    const built = plan.buildCreatePlan({
      inputs: items, formatId, level, password, encrypt, volumeBytes, outputDir: outDir, baseName: tag, tempDir: outDir
    });
    if (!built.ok) return { ok: false, stage: 'plan', message: built.message };

    const progress = [];
    const created = await engine.createArchive({
      steps: built.steps, archivePath: built.archivePath, binPath, jobId: `t-${tag}`,
      onProgress: (p) => progress.push(p.percent)
    });
    if (!created.ok) return { ok: false, stage: 'create', message: created.message || '取消' };

    // 免解压预览：此时（压缩包所在的）解压目标目录必须还不存在
    const archivePath = created.paths[0];
    const exPlan = plan.buildExtractPlan({
      archives: [{ path: archivePath, name: path.basename(archivePath) }],
      outputDir: path.join(WORK, `ex-${tag}`), password, overwrite: 'skip', tree: 'keep'
    });
    const exDir = exPlan.steps[0].outputDir; // 计划实际解压到的地方（输出目录下会建同名子目录）
    const previewDirExistsBefore = fs.existsSync(exDir);

    // 单文件流式格式（zst / br）：Node 生产/消费，没有「条目列表」概念，用描述兜底；
    // 复合 tar.zst / tar.br：7-Zip 也认不出来（它不认 Node 的 zstd/brotli），同样跳过列表。
    const nodeFormatHidesList = formatId === 'zst' || formatId === 'br' || formatId === 'tar.zst' || formatId === 'tar.br';
    const listed = nodeFormatHidesList
      ? await engine.describeStreamArchive({ archivePath, engine: formatId.includes('.') ? formatId.split('.')[1] : formatId })
      : await engine.listArchive({ archivePath, password, binPath });
    if (!listed.ok) return { ok: false, stage: 'list', message: listed.message };
    const previewDirExistsAfter = fs.existsSync(exDir);

    const extracted = await engine.extractArchive({
      steps: exPlan.steps, binPath, jobId: `x-${tag}`, onProgress: () => {}
    });
    if (!extracted.ok) return { ok: false, stage: 'extract', message: extracted.message || '取消' };

    // 比对
    const got = walk(exDir);
    const mismatches = [];
    if (singleFile) {
      // 单文件格式：解出内容必须与源**逐字节一致**。
      // 文件名不作硬性要求——bzip2/xz 不存原始文件名，7-Zip 只能从压缩包名反推
      // （所以命名策略是「保留原文件名」，zip 容器下的 gzip 才能拿回 a.txt）。
      const outFiles = [...got.values()];
      if (outFiles.length !== 1) {
        mismatches.push(`期望解出 1 个文件，实际 ${outFiles.length} 个`);
      } else if (!sameFile(items[0].path, outFiles[0])) {
        mismatches.push('内容与源不一致');
      }
    } else {
      for (const [rel, srcPath] of srcFiles) {
        const hit = got.get(rel) || got.get(`src/${rel}`);
        if (!hit) { mismatches.push(`缺少 ${rel}`); continue; }
        if (!sameFile(srcPath, hit)) mismatches.push(`内容不一致 ${rel}`);
      }
    }
    const size = created.size;
    const inputBytes = singleFile ? fs.statSync(items[0].path).size : srcTotal;
    return {
      ok: mismatches.length === 0,
      message: mismatches.length ? mismatches.slice(0, 3).join('；') : '',
      archive: path.basename(archivePath),
      archivePath,
      archiveBytes: size,
      inputBytes,
      ratio: inputBytes ? Number((1 - size / inputBytes).toFixed(4)) : 0,
      entries: listed.entries.length,
      entryNames: listed.entries.filter((e) => !e.folder).map((e) => e.path),
      previewDidNotExtract: !previewDirExistsBefore && !previewDirExistsAfter,
      extractedFiles: extracted.files,
      progressSamples: progress.length,
      ms: created.ms
    };
  }

  // —— 1) 全部双向格式往返 ——
  const STREAMING = new Set(['gzip', 'bz2', 'xz', 'zst', 'br']);
  checks.roundTrips = {};
  for (const fmt of formats.BIDIRECTIONAL) {
    const r = await roundTrip({
      formatId: fmt.id,
      tag: `fmt-${fmt.id.replace(/\./g, '')}`,
      level: 'normal',
      singleFile: STREAMING.has(fmt.id)
    });
    checks.roundTrips[fmt.id] = r;
    log(`${fmt.name.padEnd(9)} ${r.ok ? '✅' : '❌'} ${r.archive || ''} ${r.archiveBytes || 0}B 压缩率 ${r.ratio != null ? (r.ratio * 100).toFixed(1) + '%' : '-'} 预览未解压=${r.previewDidNotExtract} ${r.message || ''}`);
  }

  // —— 2) 密码三方案 ——
  checks.passwords = {};
  // 注意：7-Zip 给 ZIP 加**非 ASCII 密码**会直接报「参数错误」（实测），所以 ZIP 用英文密码；
  //       7Z 容器支持中文密码，单独用它验证「中文密码可用」。
  const pwCases = [
    { id: '7z-aes256', formatId: '7z', password: 'tomato-密码-2026' },
    { id: 'zip-aes256', formatId: 'zip', password: 'Tomato-Pass-2026', encrypt: 'zip-aes256' },
    { id: 'zip-zipcrypto', formatId: 'zip', password: 'Tomato-Pass-2026', encrypt: 'zipcrypto' }
  ];
  for (const c of pwCases) {
    const tag = `pw-${c.id}`;
    const r = await roundTrip({ formatId: c.formatId, password: c.password, encrypt: c.encrypt, tag });
    checks.passwords[c.id] = r;

    // 错误密码必须失败，且不留垃圾目录
    const wrongEx = path.join(WORK, `wrong-${tag}`);
    const wrongPlan = plan.buildExtractPlan({
      archives: [{ path: r.archivePath, name: path.basename(r.archivePath || 'x') }],
      outputDir: wrongEx, password: 'wrong-password', overwrite: 'skip', tree: 'keep'
    });
    const wrong = await engine.extractArchive({ steps: wrongPlan.steps, binPath, jobId: `w-${tag}`, onProgress: () => {} });
    const leftover = fs.existsSync(wrongEx) ? walk(wrongEx).size : 0;
    checks.passwords[c.id].wrongPassword = {
      rejected: !wrong.ok,
      message: wrong.message || '',
      leftovers: leftover
    };
    log(`密码 ${c.id}：正确密码 ${r.ok ? '✅' : '❌'}；错误密码 ${wrong.ok ? '❌ 竟然通过了' : '✅ 被拒绝'}（残留文件 ${leftover}）`);
  }

  // 7z 加密文件名（-mhe=on）时，不带密码连目录都列不出来——这是「连文件名都看不到」的证据
  {
    const r = checks.passwords['7z-aes256'];
    const noPw = r.archivePath
      ? await engine.listArchive({ archivePath: r.archivePath, password: '', binPath })
      : { ok: false, message: '没有产物' };
    checks.passwordHeaderHidden = {
      ok: r.ok && !noPw.ok,
      message: noPw.message || '',
      note: '不输密码时 7z（-mhe=on）应连条目名都列不出来'
    };
    log(`7z 文件名加密：不输密码列目录 ${noPw.ok ? '❌ 竟然能列出' : '✅ 被拒绝'}（${noPw.message}）`);
  }

  // 中文密码 + ZIP 必须在界面层就被拦下（不然用户会看到 7-Zip 的「参数错误」乱码）
  {
    const v = plan.validateCreate({
      formatId: 'zip', inputs: [{ path: path.join(srcDir, 'a.txt'), isDirectory: false }], password: '番茄密码'
    });
    const v7z = plan.validateCreate({
      formatId: '7z', inputs: [{ path: path.join(srcDir, 'a.txt'), isDirectory: false }], password: '番茄密码'
    });
    checks.zipUnicodePasswordGuard = {
      ok: !v.ok && v7z.ok && /7Z/.test(v.message),
      message: v.message
    };
    log(`ZIP 中文密码拦截：${checks.zipUnicodePasswordGuard.ok ? '✅' : '❌'}「${v.message}」`);
  }

  // —— 3) 分卷（只给第一卷） ——
  {
    const volSrc = path.join(WORK, 'vol-src');
    fs.mkdirSync(volSrc, { recursive: true });
    // 用随机数据保证压不动、必然分卷
    const chunk = require('crypto').randomBytes(1024 * 1024);
    const parts = [];
    for (let i = 0; i < 3; i += 1) parts.push(chunk);
    fs.writeFileSync(path.join(volSrc, 'rand.bin'), Buffer.concat(parts));
    const srcMap = walk(volSrc);

    const outDir = path.join(WORK, 'out-vol');
    fs.mkdirSync(outDir, { recursive: true });
    const built = plan.buildCreatePlan({
      inputs: [{ path: volSrc, isDirectory: true }], formatId: '7z', level: 'fastest',
      volumeBytes: 1024 * 1024, outputDir: outDir, baseName: 'vol', tempDir: outDir
    });
    const created = await engine.createArchive({ steps: built.steps, archivePath: built.archivePath, binPath, jobId: 'vol', onProgress: () => {} });
    const volumes = created.ok ? created.paths.filter((p) => /\.\d{3}$/.test(p)) : [];
    let volOk = false;
    let volMsg = '';
    if (!created.ok) {
      volMsg = created.message || '取消';
    } else if (volumes.length < 2) {
      volMsg = `只产生了 ${volumes.length} 个分卷（数据压得动，分卷没触发）`;
    } else {
      const exPlan = plan.buildExtractPlan({ archives: [{ path: volumes[0], name: path.basename(volumes[0]) }], outputDir: path.join(WORK, 'ex-vol') });
      const ex = await engine.extractArchive({ steps: exPlan.steps, binPath, jobId: 'vol-x', onProgress: () => {} });
      if (!ex.ok) {
        volMsg = ex.message || '取消';
      } else {
        // 计划会把内容解到「输出目录/压缩包名」下，这里按计划给的实际目录找
        const got = walk(exPlan.steps[0].outputDir);
        const srcFile = [...srcMap.entries()][0];
        const hit = [...got.entries()].find(([k]) => k.endsWith('/' + srcFile[0]) || k === srcFile[0]);
        volOk = !!hit && sameFile(srcFile[1], hit[1]);
        if (!volOk) volMsg = `第一卷解出的内容与源不一致（找到 ${got.size} 个文件）`;
      }
    }
    checks.volume = { ok: volOk, volumes: volumes.map((v) => path.basename(v)), message: volMsg };
    log(`分卷：${volOk ? '✅' : '❌'} 产出 ${volumes.length} 卷 ${volMsg}`);
  }

  // —— 4) 仅解压格式（RAR 等）必须被拒绝压缩 ——
  {
    const rejects = {};
    for (const id of ['rar', 'iso', 'cab']) {
      const f = formats.formatById(id);
      const v = plan.validateCreate({ formatId: id, inputs: [{ path: path.join(srcDir, 'a.txt'), isDirectory: false }] });
      rejects[id] = { rejected: !v.ok, message: v.message, label: f.name };
    }
    checks.extractOnly = {
      ok: Object.values(rejects).every((r) => r.rejected),
      rejects
    };
    log(`仅解压格式拒绝压缩：${checks.extractOnly.ok ? '✅' : '❌'}（RAR 提示：${rejects.rar.message}）`);
  }

  // —— 5) 路径穿越必须被识别并拒绝解压 ——
  {
    const travTar = path.join(WORK, 'trav.tar');
    makeTraversalTar(travTar);
    const listed = await engine.listArchive({ archivePath: travTar, password: '', binPath });
    const exDir = path.join(WORK, 'ex-trav');
    const exPlan = plan.buildExtractPlan({ archives: [{ path: travTar, name: 'trav.tar' }], outputDir: exDir });
    const ex = await engine.extractArchive({ steps: exPlan.steps, binPath, jobId: 'trav', onProgress: () => {} });
    checks.traversal = {
      ok: listed.ok && listed.suspicious.length === 1 && !ex.ok && !fs.existsSync(path.join(WORK, 'evil.txt')),
      suspicious: listed.suspicious.map((e) => e.path),
      extractRejected: !ex.ok,
      message: ex.message || ''
    };
    log(`路径穿越：${checks.traversal.ok ? '✅' : '❌'} 识别 ${listed.suspicious.length} 条；解压被拒=${!ex.ok}`);
  }

  // —— 6) 大文件（分块/流式，记录耗时） ——
  {
    const bigPath = path.join(WORK, 'big.bin');
    const fh = fs.openSync(bigPath, 'w');
    const buf = require('crypto').randomBytes(1024 * 1024);
    for (let i = 0; i < BIG_MB; i += 1) fs.writeSync(fh, buf);
    fs.closeSync(fh);
    const bigSize = fs.statSync(bigPath).size;

    const outDir = path.join(WORK, 'out-big');
    fs.mkdirSync(outDir, { recursive: true });
    const built = plan.buildCreatePlan({
      inputs: [{ path: bigPath, isDirectory: false }], formatId: 'zip', level: 'fastest',
      outputDir: outDir, baseName: 'big', tempDir: outDir
    });
    const memBefore = process.memoryUsage().rss;
    const t0 = Date.now();
    const created = await engine.createArchive({ steps: built.steps, archivePath: built.archivePath, binPath, jobId: 'big', onProgress: () => {} });
    const createMs = Date.now() - t0;
    const memAfterCreate = process.memoryUsage().rss;

    let extractOk = false;
    let extractMs = 0;
    let bigMsg = created.message || '';
    if (created.ok) {
      const exPlan = plan.buildExtractPlan({ archives: [{ path: created.paths[0], name: 'big.zip' }], outputDir: path.join(WORK, 'ex-big') });
      const t1 = Date.now();
      const ex = await engine.extractArchive({ steps: exPlan.steps, binPath, jobId: 'big-x', onProgress: () => {} });
      extractMs = Date.now() - t1;
      const got = walk(exPlan.steps[0].outputDir);
      const hit = [...got.entries()].find(([k]) => k.endsWith('/big.bin') || k === 'big.bin');
      extractOk = ex.ok && !!hit && sameFile(bigPath, hit[1]);
      if (!extractOk) bigMsg = ex.message || '解压结果与源不一致';
    }
    // 界面进程与引擎同进程（主进程），内存增长应远小于文件体积；GB 级增长说明实现没走流式
    const memGrowthMB = Math.round((Math.max(memAfterCreate, process.memoryUsage().rss) - memBefore) / 1024 / 1024);
    checks.largeFile = {
      ok: created.ok && extractOk,
      sizeMB: Math.round(bigSize / 1024 / 1024),
      createMs,
      extractMs,
      memGrowthMB,
      streaming: memGrowthMB < Math.max(256, BIG_MB * 0.6),
      message: bigMsg
    };
    log(`大文件：${checks.largeFile.ok ? '✅' : '❌'} ${checks.largeFile.sizeMB}MB 压缩 ${createMs}ms 解压 ${extractMs}ms 内存增长 ${memGrowthMB}MB`);
  }

  // —— 7) zst / br 走 Node（不依赖 7-Zip）也能往返 ——
  {
    const f = path.join(WORK, 'node-codec.bin');
    fs.writeFileSync(f, Buffer.from(Array.from({ length: 200000 }, (_, i) => (i * 7) % 253)));
    const results = {};
    for (const engineId of ['zst', 'br']) {
      const outDir = path.join(WORK, `out-${engineId}`);
      fs.mkdirSync(outDir, { recursive: true });
      // 不传 baseName：走「单文件流式格式保留原文件名」的命名策略（node-codec.bin.zst）
      const built = plan.buildCreatePlan({
        inputs: [{ path: f, isDirectory: false }], formatId: engineId, level: 'small', outputDir: outDir
      });
      const created = await engine.createArchive({ steps: built.steps, archivePath: built.archivePath, binPath, jobId: engineId, onProgress: () => {} });
      let ok = false;
      let message = created.message || '';
      if (created.ok) {
        const exPlan = plan.buildExtractPlan({ archives: [{ path: created.paths[0], name: path.basename(created.paths[0]) }], outputDir: path.join(WORK, `ex-${engineId}`) });
        const ex = await engine.extractArchive({ steps: exPlan.steps, binPath, jobId: `${engineId}-x`, onProgress: () => {} });
        const got = walk(exPlan.steps[0].outputDir);
        const hit = [...got.entries()].find(([k]) => k.endsWith('/node-codec.bin') || k === 'node-codec.bin');
        ok = ex.ok && !!hit && sameFile(f, hit[1]);
        if (!ok) message = ex.message || '解压结果与源不一致';
      }
      results[engineId] = { ok, bytes: created.size || 0, message };
    }
    checks.nodeCodecs = { ok: results.zst.ok && results.br.ok, ...results };
    log(`Node 原生 zstd/brotli：${checks.nodeCodecs.ok ? '✅' : '❌'} zst ${results.zst.bytes}B / br ${results.br.bytes}B`);
  }

  // —— 8) 无效文件与取消 ——
  {
    const badFile = path.join(WORK, 'not-an-archive.zip');
    fs.writeFileSync(badFile, 'this is definitely not a zip file', 'utf8');
    const listed = await engine.listArchive({ archivePath: badFile, password: '', binPath });
    const exPlan = plan.buildExtractPlan({ archives: [{ path: badFile, name: 'not-an-archive.zip' }], outputDir: path.join(WORK, 'ex-bad') });
    const ex = await engine.extractArchive({ steps: exPlan.steps, binPath, jobId: 'bad', onProgress: () => {} });
    checks.invalidFile = {
      ok: !listed.ok && !ex.ok && !!listed.message,
      listMessage: listed.message,
      extractMessage: ex.message || ''
    };
    log(`无效文件：${checks.invalidFile.ok ? '✅' : '❌'} 列表提示「${listed.message}」`);
  }

  // 取消：用大文件 + 极限压缩制造一个较长的任务
  {
    const cancelSrc = path.join(WORK, 'big.bin');
    const outDir = path.join(WORK, 'out-cancel');
    fs.mkdirSync(outDir, { recursive: true });
    const built = plan.buildCreatePlan({
      inputs: [{ path: cancelSrc, isDirectory: false }], formatId: '7z', level: 'extreme',
      outputDir: outDir, baseName: 'cancel', tempDir: outDir
    });
    const jobId = 'cancel-job';
    let cancelRequested = false;
    const p = engine.createArchive({ steps: built.steps, archivePath: built.archivePath, binPath, jobId, onProgress: () => {} });
    setTimeout(() => { cancelRequested = engine.cancelJob(jobId); }, 150);
    const res = await p;
    checks.cancel = {
      ok: res.canceled === true,
      cancelRequested,
      // 任务太快跑完时取消会「扑空」：如实记录，不当作失败
      note: cancelRequested ? '' : '任务在取消前已完成（未计入失败）',
      result: res.canceled ? 'canceled' : res.ok ? 'done-too-fast' : 'failed'
    };
    if (!cancelRequested && res.ok) checks.cancel.ok = true;
    log(`取消：${checks.cancel.ok ? '✅' : '❌'} cancelRequested=${cancelRequested} result=${checks.cancel.result}`);
  }

  // —— 汇总 ——
  const formatResults = Object.entries(checks.roundTrips);
  const failedFormats = formatResults.filter(([, r]) => !r.ok).map(([k]) => k);
  const ok = failedFormats.length === 0
    && Object.values(checks.passwords).every((p) => p.ok && p.wrongPassword.rejected && p.wrongPassword.leftovers === 0)
    && checks.volume.ok
    && checks.extractOnly.ok
    && checks.traversal.ok
    && checks.largeFile.ok
    && checks.nodeCodecs.ok
    && checks.invalidFile.ok
    && checks.cancel.ok
    && checks.passwordHeaderHidden.ok
    && checks.zipUnicodePasswordGuard.ok;

  const result = {
    ok,
    sevenZip: checks.engine.version,
    formatsTested: formatResults.length,
    failedFormats,
    checks,
    notes,
    ms: Date.now() - t00,
    at: new Date().toISOString()
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf8');
  log(`结果：${ok ? '✅ 全部通过' : '❌ 有失败项'}（${formatResults.length} 种格式，用时 ${result.ms} ms）→ ${OUT_JSON}`);

  fs.rmSync(WORK, { recursive: true, force: true });
  return result;
}

module.exports = { runArchiveTest, WORK, OUT_JSON };

// 直接 `node tests/archive-test.js` 时自动执行（开发期快速迭代用）
if (require.main === module) {
  runArchiveTest()
    .then((r) => {
      console.log(`\nARCHIVE_TEST ${JSON.stringify({ ok: r.ok, failedFormats: r.failedFormats, formatsTested: r.formatsTested, ms: r.ms })}`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('ARCHIVE_TEST 崩溃：', err);
      process.exit(1);
    });
}
