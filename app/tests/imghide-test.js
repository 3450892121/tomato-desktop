// 「文件藏图」工具 —— 引擎自检（真跑打包/解包，并用原版实现当裁判验证双向互通）
// 用法（两种都支持）：
//   1) cd app && node tests/imghide-test.js                              ← 纯 Node 直接跑（开发期快速迭代）
//   2) cd app && .\node_modules\electron\dist\electron.exe . --imghide-test  ← 交付前自检
// 结果写入 %TEMP%/tomato-imghide-test.json，ok:true 为通过。
//
// 覆盖范围：
//   · PNG / GIF 两种载体真实「打包 → 解包 → 逐字节比对」
//   · 带密码往返 + 错误密码必须失败且不留垃圾 + 不填密码给可读提示
//   · **双向互通**：原版实现能解我们打的图（含带密码）；我们能解原版打的图（含带密码）
//   · 表图零损伤：GIF 载体打包后原字节完全不变；PNG 产物像素流与解码尺寸一致
//   · 容错：普通图片 / 非法文件 / 被截断的图都给可读中文错误
//   · 安全：条目名带路径穿越时被净化（不写到目录外）
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const WORK = path.join(os.tmpdir(), 'tomato-imghide-test');
const OUT_JSON = path.join(os.tmpdir(), 'tomato-imghide-test.json');
const APP_DIR = path.join(__dirname, '..');
const TEST_DIR = path.join(os.tmpdir(), 'tomato-uitest');

const checks = {};
const notes = [];
const log = (msg) => {
  notes.push(msg);
  console.log(`[imghide-test] ${msg}`);
};

// —— 夹具构造（PNG 手写、GIF 优先用 ffmpeg 造；都不依赖界面进程） ——

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(list) {
  const total = list.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of list) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 8 位 RGBA、非隔行的 PNG（与原版 canvas 输出同构） */
function buildPng(width, height, seed = 11) {
  const raw = new Uint8Array(height * (1 + width * 4));
  let v = seed;
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width * 4; x += 1) {
      v = (v * 1103515245 + 12345) & 0x7fffffff;
      raw[y * (1 + width * 4) + 1 + x] = (v >> 7) % 256;
    }
  }
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    typeBytes.copy(head, 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(concat([new Uint8Array(typeBytes), new Uint8Array(data)])), 0);
    return Buffer.concat([head, Buffer.from(data), crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

/** 1×1 的最小合法 GIF89a（没有 ffmpeg 时的兜底） */
function minimalGif() {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b
  ]);
}

/** 用随包 ffmpeg 造一张真彩 GIF（造不出来就退回 1×1 最小 GIF） */
function buildGif(ffmpegPath) {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) return minimalGif();
  const out = path.join(WORK, '_fixture.gif');
  const res = spawnSync(ffmpegPath, [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=5:duration=0.6',
    '-vf', 'format=rgb24', out
  ], { windowsHide: true, encoding: 'buffer' });
  if (res.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) {
    const bytes = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    return bytes;
  }
  return minimalGif();
}

function findFfmpeg(portableDir) {
  const addon = path.join(portableDir, 'addons', 'ffmpeg', 'ffmpeg.exe');
  if (fs.existsSync(addon)) return addon;
  const probe = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
  return probe.status === 0 ? 'ffmpeg' : '';
}

// —— 夹具（界面自动测试共用；名字前缀固定，见 main.js 的对话框桩） ——

/** 造/更新界面测试要用的夹具：表图 PNG、表图 GIF、两个要藏的文件 */
async function ensureFixtures(testDir, portableDir) {
  await fsp.mkdir(testDir, { recursive: true });
  const ffmpeg = findFfmpeg(portableDir || APP_DIR);
  await fsp.writeFile(path.join(testDir, '测试藏图表图封面A.png'), buildPng(64, 48, 21));
  await fsp.writeFile(path.join(testDir, '测试藏图表图封面B.gif'), buildGif(ffmpeg));
  await fsp.writeFile(path.join(testDir, '测试藏图文件说明.txt'), Buffer.from('这是要藏进图片里的说明文字\n第二行。', 'utf8'));
  const bin = Buffer.alloc(256 * 1024);
  for (let i = 0; i < bin.length; i += 1) bin[i] = (i * 37 + 11) % 256;
  await fsp.writeFile(path.join(testDir, '测试藏图文件数据.bin'), bin);
}

/** 清掉本工具在测试目录留下的全部东西（开跑前、收尾后各一次） */
async function cleanFixtures(testDir) {
  const entries = await fsp.readdir(testDir).catch(() => []);
  for (const name of entries) {
    if (name.startsWith('测试藏图')) {
      await fsp.rm(path.join(testDir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

// —— 断言小工具 ——

function sameBytes(a, b) {
  return a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

async function sameFile(filePath, bytes) {
  const got = await fsp.readFile(filePath);
  return sameBytes(got, bytes);
}

function countLeftovers(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

async function rendererDecodeSize(win, filePath) {
  if (!win || !win.webContents) return null;
  const b64 = fs.readFileSync(filePath).toString('base64');
  return win.webContents.executeJavaScript(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([arr]));
    return { width: bmp.width, height: bmp.height };
  })()`);
}

// —— 主流程 ——

async function runImgHideTest({ portableDir, mainWindow } = {}) {
  const t00 = Date.now();
  const engine = await import('../src/tools/imghide/core/engine.mjs');
  const format = await import('../src/tools/imghide/core/format.mjs');
  const cryptoLayer = await import('../src/tools/imghide/core/crypto.mjs');
  const oracle = require('./tujia-oracle.js');

  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });

  // 素材
  const coverPng = path.join(WORK, 'cover.png');
  const coverGif = path.join(WORK, 'cover.gif');
  const coverJpg = path.join(WORK, 'cover.jpg');
  const pngBytes = buildPng(64, 48, 7);
  const gifBytes = buildGif(findFfmpeg(portableDir || APP_DIR));
  await fsp.writeFile(coverPng, pngBytes);
  await fsp.writeFile(coverGif, gifBytes);
  await fsp.writeFile(coverJpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]));

  const fileA = path.join(WORK, '说明.txt');
  const fileB = path.join(WORK, '数据.bin');
  const bytesA = Buffer.from('藏起来的内容：中文也照样还原。', 'utf8');
  const bytesB = Buffer.alloc(300 * 1024);
  for (let i = 0; i < bytesB.length; i += 1) bytesB[i] = (i * 91 + 7) % 256;
  await fsp.writeFile(fileA, bytesA);
  await fsp.writeFile(fileB, bytesB);

  const items = [{ path: fileA }, { path: fileB }];

  // —— ① PNG 载体往返 ——
  {
    const packed = await engine.packImage({ mode: 'pro', coverPath: coverPng, items, outputDir: WORK });
    const out = await engine.unpackImage({ imagePath: packed.path, outputDir: path.join(WORK, 'out-png') });
    const product = fs.readFileSync(packed.path);
    checks.roundTripPng = {
      ok: out.files.length === 2
        && await sameFile(out.files[0].path, bytesA)
        && await sameFile(out.files[1].path, bytesB)
        && sameBytes(product.subarray(0, 8), pngBytes.subarray(0, 8))
        && product.length > pngBytes.length,
      product: packed.path,
      productSize: packed.size,
      coverSize: pngBytes.length
    };
    // 产物仍是一张能打开的 PNG，且尺寸与表图一致（在界面进程里真解码）
    const decoded = await rendererDecodeSize(mainWindow, packed.path);
    checks.roundTripPng.decoded = decoded;
    if (decoded && (decoded.width !== 64 || decoded.height !== 48)) checks.roundTripPng.ok = false;
    log(`PNG 往返：${checks.roundTripPng.ok ? '✅' : '❌'}（表图 ${pngBytes.length} → 产物 ${packed.size} 字节）`);
  }

  // —— ② GIF 载体往返（原字节零改动） ——
  {
    const packed = await engine.packImage({ mode: 'pro', coverPath: coverGif, items, outputDir: WORK });
    const product = fs.readFileSync(packed.path);
    const out = await engine.unpackImage({ imagePath: packed.path, outputDir: path.join(WORK, 'out-gif') });
    checks.roundTripGif = {
      ok: out.files.length === 2
        && await sameFile(out.files[0].path, bytesA)
        && await sameFile(out.files[1].path, bytesB)
        && sameBytes(product.subarray(0, gifBytes.length), gifBytes),
      product: packed.path,
      productSize: packed.size,
      coverSize: gifBytes.length
    };
    const decoded = await rendererDecodeSize(mainWindow, packed.path);
    checks.roundTripGif.decoded = decoded;
    log(`GIF 往返：${checks.roundTripGif.ok ? '✅' : '❌'}（原 GIF ${gifBytes.length} → 产物 ${packed.size} 字节，原字节保持）`);
  }

  // —— ③ 密码 ——
  {
    const packed = await engine.packImage({ mode: 'pro', coverPath: coverPng, items: [{ path: fileA }], password: '图夹密码abc', outputDir: WORK, baseName: 'pw' });
    const okOut = path.join(WORK, 'out-pw');
    const okRes = await engine.unpackImage({ imagePath: packed.path, password: '图夹密码abc', outputDir: okOut });
    const wrongDir = path.join(WORK, 'out-pw-bad');
    let wrongMessage = '';
    try {
      await engine.unpackImage({ imagePath: packed.path, password: '错的密码', outputDir: wrongDir });
    } catch (err) {
      wrongMessage = err.message;
    }
    let noPwMessage = '';
    try {
      await engine.unpackImage({ imagePath: packed.path, outputDir: path.join(WORK, 'out-pw-none') });
    } catch (err) {
      noPwMessage = err.message;
    }
    checks.password = {
      ok: okRes.encrypted === true
        && await sameFile(okRes.files[0].path, bytesA)
        && /密码错误/.test(wrongMessage)
        && countLeftovers(wrongDir) === 0
        && /可能设了密码/.test(noPwMessage),
      wrongMessage,
      noPwMessage
    };
    log(`密码：${checks.password.ok ? '✅' : '❌'}（错误密码「${wrongMessage}」，不填密码「${noPwMessage}」）`);
  }

  // —— ③之二「动态混淆（极速）」往返 + 原版能否直接读（不弹密码框） ——
  {
    const packedPng = await engine.packImage({ mode: 'fast', coverPath: coverPng, items, outputDir: WORK, baseName: '极速PNG' });
    const packedGif = await engine.packImage({ mode: 'fast', coverPath: coverGif, items: [{ path: fileA }], outputDir: WORK, baseName: '极速GIF' });
    const outFast = await engine.unpackImage({ imagePath: packedPng.path, outputDir: path.join(WORK, 'out-fast') });
    const pngBytes = fs.readFileSync(packedPng.path);
    const coverBytes = fs.readFileSync(coverPng);
    checks.roundTripFast = {
      ok: outFast.files.length === 2
        && await sameFile(outFast.files[0].path, bytesA)
        && await sameFile(outFast.files[1].path, bytesB)
        && sameBytes(pngBytes.subarray(0, coverBytes.length), coverBytes)   // 表图零改动
        && !pngBytes.includes(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])) // 不带 PRO 指纹
        && pngBytes.includes(Buffer.from('DYNAMIC_V2_')),                    // 有动态前缀
      product: packedPng.path
    };
    const loaded = oracle.loadOracle(APP_DIR);
    if (!loaded.ok) {
      // 裁判缺失 ≠ 通过：记 skipped，并让汇总的 verified 变 false（详见收尾处）。
      checks.interopFast = { ok: true, skipped: true, oracle: 'skipped', reason: loaded.reason };
    } else {
      // 原版客户端不填密码走的就是 action='decrypt'（先在文件里找 PRO 指纹，没有才按 DYNAMIC_V2_ 解析）
      const officialPng = await oracle.oracleLegacyDecrypt(APP_DIR, new Uint8Array(pngBytes));
      const officialGif = await oracle.oracleLegacyDecrypt(APP_DIR, new Uint8Array(fs.readFileSync(packedGif.path)));
      checks.interopFast = {
        ok: officialPng.length === 2
          && sameBytes(officialPng[0].bytes, bytesA)
          && sameBytes(officialPng[1].bytes, bytesB)
          && officialGif.length === 1
          && sameBytes(officialGif[0].bytes, bytesA),
        oracle: 'used',
        officialPngFiles: officialPng.map((f) => `${f.name}(${f.bytes.length})`)
      };
    }
    log(`极速模式（动态混淆）：往返 ${checks.roundTripFast.ok ? '✅' : '❌'}；原版不解密直接读 ${checks.interopFast.skipped ? '⚠️ 未验证' : (checks.interopFast.ok ? '✅' : '❌')}（${(checks.interopFast.officialPngFiles || []).join(', ') || checks.interopFast.reason || ''}）`);
  }

  // —— ④ 双向互通（原版实现当裁判） ——
  {
    const loaded = oracle.loadOracle(APP_DIR);
    if (!loaded.ok) {
      checks.interop = { ok: true, skipped: true, oracle: 'skipped', reason: loaded.reason };
      log(`互通验证：⚠️ 未验证（${loaded.reason}）——与原版互通是本工具的核心卖点，跳过不等于通过；裁判放 .tools/tujia-oracle/decryptWorker.js`);
    } else {
      const detail = {};
      // ① 我们打的图 → 原版解
      const ourPng = (await engine.packImage({ mode: 'pro', coverPath: coverPng, items, outputDir: WORK, baseName: '互通PNG' })).path;
      const ourGif = (await engine.packImage({ mode: 'pro', coverPath: coverGif, items: [{ path: fileA }], outputDir: WORK, baseName: '互通GIF' })).path;
      const ourPw = (await engine.packImage({ mode: 'pro', coverPath: coverPng, items: [{ path: fileA }], password: 'pw-我们', outputDir: WORK, baseName: '互通PW' })).path;

      const readBack = async (file) => oracle.oracleExtractFiles(APP_DIR, fs.readFileSync(file));
      const officialFromPng = await readBack(ourPng);
      const officialFromGif = await readBack(ourGif);
      const officialFromPw = await oracle.oracleExtractFiles(APP_DIR, fs.readFileSync(ourPw), 'pw-我们');
      detail.officialReadsOursPng = officialFromPng.length === 2 && sameBytes(officialFromPng[0].bytes, bytesA) && sameBytes(officialFromPng[1].bytes, bytesB);
      detail.officialReadsOursGif = officialFromGif.length === 1 && sameBytes(officialFromGif[0].bytes, bytesA);
      detail.officialReadsOursPassword = officialFromPw.length === 1 && sameBytes(officialFromPw[0].bytes, bytesA);

      // ② 原版打的图 → 我们解
      const payloadPlain = format.buildPayload([{ name: '原版.txt', bytes: bytesA }, { name: '原版.bin', bytes: bytesB }]);
      const officialPngBytes = await oracle.oracleEmbedPng(APP_DIR, { width: 64, height: 48, rgba: buildPng(64, 48, 7), payload: payloadPlain });
      const officialPng = path.join(WORK, '原版打的.png');
      await fsp.writeFile(officialPng, officialPngBytes);
      const ourOut = await engine.unpackImage({ imagePath: officialPng, outputDir: path.join(WORK, 'from-official') });
      detail.weReadOfficialPng = ourOut.files.length === 2
        && await sameFile(ourOut.files[0].path, bytesA)
        && await sameFile(ourOut.files[1].path, bytesB);

      const officialGifBytes = await oracle.oracleEmbedGif(APP_DIR, { gifBytes, payload: payloadPlain });
      const officialGif = path.join(WORK, '原版打的.gif');
      await fsp.writeFile(officialGif, officialGifBytes);
      const ourOutGif = await engine.unpackImage({ imagePath: officialGif, outputDir: path.join(WORK, 'from-official-gif') });
      detail.weReadOfficialGif = ourOutGif.files.length === 2 && await sameFile(ourOutGif.files[0].path, bytesA);

      // ③ 原版加密的密文 → 我们解（反过来：我们加密 → 原版解密）
      const officialEnc = await oracle.oracleEncrypt(APP_DIR, payloadPlain, 'pw-原版');
      const encDecoded = format.parsePayload(cryptoLayer.decryptPayload(officialEnc, 'pw-原版'));
      detail.weReadOfficialCipher = encDecoded.length === 2 && sameBytes(encDecoded[0].bytes, bytesA);

      checks.interop = {
        ok: Object.values(detail).every(Boolean),
        oracle: 'used',
        oracleFile: loaded.file,
        detail
      };
      log(`互通验证：${checks.interop.ok ? '✅ 双向全通' : '❌ 有子项失败'}（${JSON.stringify(detail)}）`);
    }
  }

  // —— ⑤ 容错与安全 ——
  {
    const plainOut = path.join(WORK, 'out-plain');
    let plainMessage = '';
    try {
      await engine.unpackImage({ imagePath: coverPng, outputDir: plainOut });
    } catch (err) {
      plainMessage = err.message;
    }
    let jpgMessage = '';
    try {
      await engine.unpackImage({ imagePath: coverJpg, outputDir: path.join(WORK, 'out-jpg') });
    } catch (err) {
      jpgMessage = err.message;
    }
    let cutMessage = '';
    const cut = path.join(WORK, 'cut.png');
    await fsp.writeFile(cut, pngBytes.subarray(0, 20));
    try {
      await engine.unpackImage({ imagePath: cut, outputDir: path.join(WORK, 'out-cut') });
    } catch (err) {
      cutMessage = err.message;
    }
    // 路径穿越：条目名带 ../ 也必须落在输出目录里
    const packed = await engine.packImage({
      coverPath: coverPng,
      items: [{ path: fileA, name: '../../逃逸.txt' }],
      outputDir: WORK,
      baseName: '穿越'
    });
    const escapeOut = path.join(WORK, 'out-escape');
    const escaped = await engine.unpackImage({ imagePath: packed.path, outputDir: escapeOut });
    const inside = path.dirname(escaped.files[0].path) === escapeOut && !fs.existsSync(path.join(WORK, '逃逸.txt'));

    checks.errors = {
      ok: /不是图夹图|被压缩/.test(plainMessage)
        && /不是图夹图/.test(jpgMessage)
        && cutMessage.length > 0
        && inside,
      plainMessage,
      jpgMessage,
      cutMessage,
      escapeInside: inside
    };
    log(`容错与安全：${checks.errors.ok ? '✅' : '❌'}（普通图「${plainMessage}」/ JPG「${jpgMessage}」/ 截断「${cutMessage}」）`);
  }

  // —— ⑥ 进度回调 ——
  {
    const seen = [];
    await engine.packImage({
      coverPath: coverPng,
      items: [{ path: fileA }],
      outputDir: WORK,
      baseName: '进度',
      onProgress: (p) => seen.push(p.percent)
    });
    checks.progress = { ok: seen.length > 0 && seen[seen.length - 1] === 100, samples: seen.length };
    log(`进度回调：${checks.progress.ok ? '✅' : '❌'}（${seen.length} 次，末次 ${seen[seen.length - 1]}%）`);
  }

  // —— 收尾 ——
  await ensureFixtures(TEST_DIR, portableDir || APP_DIR); // 界面自动测试要用同一套夹具
  await fsp.rm(WORK, { recursive: true, force: true });

  const ok = Object.values(checks).every((c) => c.ok);
  // ok 与 verified 分开报：ok = 跑过的项全过；verified = 且没有任何一项因缺裁判被跳过。
  // 打包产物上裁判不随包分发（那是对方客户端的代码），interop 必然 skipped → ok:true 但
  // verified:false，这是预期状态；交付前必须在带裁判的开发树上跑到 verified:true。
  const skipped = Object.entries(checks).filter(([, c]) => c.skipped).map(([k]) => k);
  const verified = ok && skipped.length === 0;
  const result = {
    ok,
    verified,
    skipped,
    checks,
    notes,
    ms: Date.now() - t00,
    at: new Date().toISOString()
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf8');
  const verdict = !ok
    ? '❌ 有失败项'
    : (skipped.length
      ? `⚠️ 跑过的项全过，但 ${skipped.length} 项未验证（${skipped.join(', ')}）——不算完整验证`
      : '✅ 全部通过（含原版互通验证）');
  log(`结果：${verdict} → ${OUT_JSON}`);
  return result;
}

module.exports = { runImgHideTest, ensureFixtures, cleanFixtures, WORK, OUT_JSON, TEST_DIR };

// 直接 `node tests/imghide-test.js` 时自动执行（开发期快速迭代用）
if (require.main === module) {
  runImgHideTest()
    .then((r) => {
      console.log(`\nIMGHIDE_TEST ${JSON.stringify({ ok: r.ok, verified: r.verified, skipped: r.skipped })}`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      console.log(`\nIMGHIDE_TEST_FAIL ${err.message}\n${err.stack}`);
      process.exit(1);
    });
}