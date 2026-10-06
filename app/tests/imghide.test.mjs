// 「文件藏图」工具 —— 纯逻辑单测（不需要 Electron）
// 运行：cd app && node tests/imghide.test.mjs
// 覆盖：载荷往返与容错、GIF 嵌入/回读、PNG 切分公式与 IDAT 重建、CRC32 与 Node 对齐、
//       密码往返与错误密码、条目名净化（防路径穿越）、输出命名、载体识别。
// 规格与格式证据：spec/modules/imghide.md
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  MAGIC, MAGIC_PREFIX, FINGERPRINT, PASSWORD_SALT_TEXT,
  crc32, crc32Of, concatBytes, buildPayload, parsePayload, detectCoverKind,
  embedPayloadInGif, extractPayloadFromGif,
  parsePngChunks, pngInfo, pngCompatError, concatIdatData,
  extractPayloadFromInflatedPng, writePngWithIdat, buildFingerprintChunk,
  safeEntryName, uniqueEntryName, humanBytes, sizeWarning, WEB_SAFE_BYTES,
  makeDynamicDelimiter, buildDynamicPayload, parseDynamicPayload, appendDynamicPayload,
  base64ToBytes, bytesToBase64, OLD_DELIMITER_TEXT, OLD_FILENAME_DELIMITER_TEXT, OLD_FILE_DELIMITER_TEXT,
  indexOfBytes, DYNAMIC_PREFIX
} from '../src/tools/imghide/core/format.mjs';
import { encryptPayload, decryptPayload } from '../src/tools/imghide/core/crypto.mjs';
import { packImage, unpackImage, uniqueTargetPath, uniqueTargetDir } from '../src/tools/imghide/core/engine.mjs';

let pass = 0;
let fail = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    results.push(`  ✅ ${name}`);
  } catch (err) {
    fail += 1;
    results.push(`  ❌ ${name}\n       ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    results.push(`  ✅ ${name}`);
  } catch (err) {
    fail += 1;
    results.push(`  ❌ ${name}\n       ${err.message}`);
  }
}

const WORK = path.join(os.tmpdir(), 'tomato-imghide-unit');

// —— 夹具构造 ——

/** 8 位 RGBA、非隔行的最小 PNG（与官方 canvas 输出同构：逐行 filter 0） */
function buildPng(width, height, pixels) {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0;
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const chunk = (type, data) => {
    const typeBytes = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length, false);
    out.set(typeBytes, 4);
    out.set(data, 8);
    new DataView(out.buffer).setUint32(8 + data.length, crc32Of([typeBytes, data]), false);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(zlib.deflateSync(raw))),
    chunk('IEND', new Uint8Array(0))
  ]);
}

/** 1×1 的最小合法 GIF89a */
function buildGif() {
  return new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    1, 0, 1, 0, // 宽 1 高 1
    0x80, 0, 0, // 有全局色表、2 色
    0, 0, 0, 255, 255, 255, // 色表
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, // 图像描述符
    0x02, 0x02, 0x44, 0x01, 0x00, // LZW：最小码长 2 + 数据子块 + 结束
    0x3b // 结束符
  ]);
}

function rgbaPixels(width, height, seed = 7) {
  const px = new Uint8Array(width * height * 4);
  let v = seed;
  for (let i = 0; i < px.length; i += 1) {
    v = (v * 1103515245 + 12345) & 0x7fffffff;
    px[i] = v % 256;
  }
  return px;
}

function fakeCover(kind, width = 24, height = 16) {
  return kind === 'gif' ? buildGif() : buildPng(width, height, rgbaPixels(width, height));
}

console.log('「文件藏图」纯逻辑测试\n');

// —— 一、常量与基础工具 ——

test('魔数/前缀/盐与官方一致（互通的前提）', () => {
  assert.equal(new TextDecoder().decode(MAGIC), 'STEGDATA V6');
  assert.deepEqual([...MAGIC_PREFIX], [0x21, 0xff, 0x0b]);
  assert.equal(FINGERPRINT.length, 16);
  assert.equal(FINGERPRINT[0], 1);
  assert.equal(FINGERPRINT[15], 16);
  assert.equal(PASSWORD_SALT_TEXT, 'xcn2025');
});

test('CRC32 与 Node zlib.crc32 完全一致', () => {
  const samples = [new Uint8Array(0), new Uint8Array([0]), new Uint8Array([1, 2, 3, 4, 5]), rgbaPixels(9, 5)];
  for (const s of samples) {
    if (typeof zlib.crc32 === 'function') {
      assert.equal(crc32(s), zlib.crc32(s) >>> 0, `长度 ${s.length} 的 CRC 不一致`);
    }
  }
  assert.equal(crc32Of([new Uint8Array([1, 2]), new Uint8Array([3, 4])]), crc32(new Uint8Array([1, 2, 3, 4])));
});

test('载体识别：GIF / PNG / 其它', () => {
  assert.equal(detectCoverKind(buildGif()), 'gif');
  assert.equal(detectCoverKind(fakeCover('png')), 'png');
  assert.equal(detectCoverKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'other');
  assert.equal(detectCoverKind(new Uint8Array(0)), 'other');
});

// —— 二、载荷（文件表） ——

test('载荷往返：中文名 / 空文件 / 多文件', () => {
  const files = [
    { name: '中文名字.txt', bytes: new TextEncoder().encode('你好，图夹') },
    { name: 'empty.bin', bytes: new Uint8Array(0) },
    { name: 'a/b/路径名.dat', bytes: new Uint8Array([1, 2, 3]) }
  ];
  const payload = buildPayload(files);
  const back = parsePayload(payload);
  assert.equal(back.length, 3);
  assert.equal(back[0].name, '中文名字.txt');
  assert.equal(new TextDecoder().decode(back[0].bytes), '你好，图夹');
  assert.equal(back[1].bytes.length, 0);
  assert.equal(back[2].name, 'a/b/路径名.dat');
  assert.deepEqual([...back[2].bytes], [1, 2, 3]);
});

test('载荷往返：1MB 随机内容逐字节一致', () => {
  const big = rgbaPixels(512, 512);
  const payload = buildPayload([{ name: 'big.bin', bytes: big }]);
  const back = parsePayload(payload);
  assert.equal(back[0].bytes.length, big.length);
  assert.deepEqual([...back[0].bytes.subarray(0, 64)], [...big.subarray(0, 64)]);
  assert.deepEqual([...back[0].bytes.subarray(-64)], [...big.subarray(-64)]);
});

test('载荷结构：首 4 字节是文件数，名字长度/大小都是大端', () => {
  const payload = buildPayload([{ name: 'ab', bytes: new Uint8Array([9]) }]);
  const view = new DataView(payload.buffer);
  assert.equal(view.getUint32(0, false), 1);
  assert.equal(view.getUint32(4, false), 2);
  assert.equal(payload[8], 0x61);
  assert.equal(payload[9], 0x62);
  assert.equal(view.getBigUint64(10, false), 1n);
  assert.equal(payload[18], 9);
});

test('载荷容错：截断 / 计数异常 / 名字超长都给可读错误', () => {
  assert.throws(() => parsePayload(new Uint8Array([0, 0, 0])), /不完整/);
  const badCount = new Uint8Array(4);
  new DataView(badCount.buffer).setUint32(0, 0, false);
  assert.throws(() => parsePayload(badCount), /数量异常/);
  const hugeName = buildPayload([{ name: 'x', bytes: new Uint8Array(0) }]);
  new DataView(hugeName.buffer).setUint32(4, 99999, false);
  assert.throws(() => parsePayload(hugeName), /不完整/);
  const truncated = buildPayload([{ name: 'x', bytes: new Uint8Array([1, 2, 3, 4]) }]).subarray(0, 12);
  assert.throws(() => parsePayload(truncated), /不完整/);
});

// —— 三、GIF 载体 ——

test('GIF：嵌入后原字节不变、尾部有魔数块与指纹块', () => {
  const gif = buildGif();
  const payload = buildPayload([{ name: 'x.txt', bytes: new TextEncoder().encode('hi') }]);
  const packed = embedPayloadInGif(gif, payload);
  assert.deepEqual([...packed.subarray(0, gif.length)], [...gif], '原 GIF 字节必须零改动');
  assert.deepEqual(
    [...packed.subarray(gif.length, gif.length + 3 + MAGIC.length)],
    [...MAGIC_PREFIX, ...MAGIC],
    '尾部应先出现 21 FF 0B + 魔数'
  );
  assert.ok(packed.length > gif.length + payload.length, '尾部还要有指纹块');
  // 指纹注释块 21 FE 10 + 01..10 + 00
  const fp = concatBytes([new Uint8Array([0x21, 0xfe, 16]), FINGERPRINT, new Uint8Array([0])]);
  assert.deepEqual([...packed.subarray(packed.length - fp.length)], [...fp]);
});

test('GIF：嵌入 → 回读逐字节一致（含长度前缀）', () => {
  const payload = buildPayload([
    { name: '中文.txt', bytes: rgbaPixels(64, 8) },
    { name: 'b.bin', bytes: new Uint8Array(0) }
  ]);
  const packed = embedPayloadInGif(buildGif(), payload);
  const back = extractPayloadFromGif(packed);
  assert.deepEqual([...back], [...payload]);
});

test('GIF：载荷里混入假魔数也不影响定位（官方反向扫描最多容忍 20 个候选）', () => {
  const payload = buildPayload([{ name: 'fake.bin', bytes: concatBytes([MAGIC_PREFIX, new Uint8Array([1, 2, 3])]) }]);
  const packed = embedPayloadInGif(buildGif(), payload);
  assert.deepEqual([...extractPayloadFromGif(packed)], [...payload]);
});

test('GIF：非图夹 / 非 GIF 都给可读错误', () => {
  assert.throws(() => extractPayloadFromGif(buildGif()), /不是图夹图/);
  assert.throws(() => extractPayloadFromGif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /不是有效的 GIF/);
});

// —— 四、PNG 载体 ——

test('PNG：切分公式 = 高 × (1 + 宽 × 每像素字节)（官方口径）', () => {
  const png = buildPng(24, 16, rgbaPixels(24, 16));
  const info = pngInfo(png);
  assert.equal(info.width, 24);
  assert.equal(info.height, 16);
  assert.equal(info.bytesPerPixel, 4);
  assert.equal(info.rawSize, 16 * (1 + 24 * 4));
  assert.equal(pngCompatError(info), null, '8 位非隔行应可直接手术');
});

test('PNG：位深/隔行不合规时给出重编码原因', () => {
  const png = buildPng(8, 8, rgbaPixels(8, 8));
  const info = pngInfo(png);
  assert.ok(/位深/.test(pngCompatError({ ...info, bitDepth: 16 })));
  assert.ok(/隔行/.test(pngCompatError({ ...info, interlace: 1 })));
});

test('PNG：IDAT 拼接 → 解压 → 切分隐藏数据', () => {
  const png = buildPng(16, 8, rgbaPixels(16, 8));
  const info = pngInfo(png);
  const inflated = zlib.inflateSync(concatIdatData(png, parsePngChunks(png)));
  assert.equal(inflated.length, info.rawSize, '干净 PNG 的解压流应正好是扫描线数据');
  assert.throws(() => extractPayloadFromInflatedPng(inflated, info), /不是图夹图/);
});

test('PNG：重建后单 IDAT + 指纹块 + 解压流尾部就是载荷', () => {
  const png = buildPng(16, 8, rgbaPixels(16, 8));
  const info = pngInfo(png);
  const payload = buildPayload([{ name: 'x.txt', bytes: new TextEncoder().encode('图夹') }]);
  const inflated = zlib.inflateSync(concatIdatData(png, parsePngChunks(png)));
  const rebuilt = writePngWithIdat(png, new Uint8Array(zlib.deflateSync(concatBytes([inflated, payload]))));

  const chunks = parsePngChunks(rebuilt);
  assert.equal(chunks.filter((c) => c.type === 'IDAT').length, 1, '应只剩一个 IDAT');
  assert.equal(chunks[chunks.length - 1].type, 'IEND');
  assert.equal(chunks[chunks.length - 2].type, 'iTXt', 'IEND 前应是指纹块');
  const textChunk = chunks[chunks.length - 2];
  const text = rebuilt.subarray(textChunk.dataStart, textChunk.dataStart + textChunk.dataLength);
  assert.deepEqual(
    [...text.subarray(text.length - FINGERPRINT.length)],
    [...FINGERPRINT],
    'iTXt 文本尾部应含 01..10 指纹'
  );
  const back = zlib.inflateSync(concatIdatData(rebuilt, parsePngChunks(rebuilt)));
  assert.deepEqual([...extractPayloadFromInflatedPng(back, pngInfo(rebuilt))], [...payload]);
  // 像素数据没被动过
  assert.deepEqual([...back.subarray(0, info.rawSize)], [...inflated]);
});

test('PNG：指纹块自洽（长度/CRC 可被解析器接受）', () => {
  const chunk = buildFingerprintChunk();
  const type = new TextDecoder().decode(chunk.subarray(4, 8));
  assert.equal(type, 'iTXt');
  const length = new DataView(chunk.buffer).getUint32(0, false);
  assert.equal(length, chunk.length - 12);
  assert.equal(new DataView(chunk.buffer).getUint32(chunk.length - 4, false), crc32Of([chunk.subarray(4, chunk.length - 4)]));
});

// —— 五、密码 ——

test('密码：加解密往返一致，密文 = 12 字节 IV + 密文 + 16 字节 tag', () => {
  const payload = buildPayload([{ name: 's.txt', bytes: new TextEncoder().encode('secret') }]);
  const enc = encryptPayload(payload, '密码Pass123');
  assert.equal(enc.length, payload.length + 12 + 16);
  assert.deepEqual([...decryptPayload(enc, '密码Pass123')], [...payload]);
});

test('密码：错误密码报「密码错误」', () => {
  const payload = buildPayload([{ name: 's.txt', bytes: new TextEncoder().encode('secret') }]);
  const enc = encryptPayload(payload, 'right');
  assert.throws(() => decryptPayload(enc, 'wrong'), /密码错误/);
  assert.throws(() => decryptPayload(enc.subarray(0, 5), 'right'), /密码错误/);
});

test('密码：同一口令两次加密的 IV 不同（不会出现相同密文）', () => {
  const payload = buildPayload([{ name: 's.txt', bytes: new Uint8Array([1]) }]);
  const a = encryptPayload(payload, 'pw');
  const b = encryptPayload(payload, 'pw');
  assert.notDeepEqual([...a], [...b]);
  assert.deepEqual([...decryptPayload(a, 'pw')], [...decryptPayload(b, 'pw')]);
});

// —— 五之二、动态混淆（极速）容器 ——

test('动态格式：分隔符必须「以 ||| 结尾且长度 > 3」（照抄官方解析器的硬要求）', () => {
  const delimiter = makeDynamicDelimiter(() => 0.5);
  assert.ok(delimiter.endsWith('|||'), delimiter);
  assert.ok(delimiter.length > 3, delimiter);
  assert.ok(!delimiter.startsWith('|||'), `不能以 ||| 开头（那样官方只会取到 |||、长度 3、判为非图夹）：${delimiter}`);
});

test('动态格式：载荷往返（中文名 / 空文件 / 多文件）', () => {
  const files = [
    { name: '中文名字.txt', bytes: new TextEncoder().encode('动态混淆的内容') },
    { name: 'empty.bin', bytes: new Uint8Array(0) },
    { name: 'sub/路径.bin', bytes: new Uint8Array([9, 8, 7]) }
  ];
  const payload = buildDynamicPayload(files, 'AbCd1234Ef|||');
  const back = parseDynamicPayload(payload);
  assert.ok(back, '应能解析');
  assert.equal(back.dynamic, true);
  assert.equal(back.delimiter, 'AbCd1234Ef|||');
  assert.deepEqual(back.files.map((f) => f.name), ['中文名字.txt', 'empty.bin', 'sub/路径.bin']);
  assert.equal(new TextDecoder().decode(back.files[0].bytes), '动态混淆的内容');
  assert.equal(back.files[1].bytes.length, 0);
});

test('动态格式：整文件（图片 + 尾部载荷）也能解析，且表图前缀零改动', () => {
  const cover = fakeCover('png');
  const payload = buildDynamicPayload([{ name: 'a.txt', bytes: new TextEncoder().encode('x') }]);
  const whole = appendDynamicPayload(cover, payload);
  assert.deepEqual([...whole.subarray(0, cover.length)], [...cover], '表图字节必须零改动');
  const parsed = parseDynamicPayload(whole);
  assert.ok(parsed);
  assert.equal(parsed.files[0].name, 'a.txt');
  // 官方就是拿整份文件字节来找前缀：载荷可以不在文件最末尾，也能被找到
  const withTail = concatBytes([whole, new Uint8Array(1024)]);
  assert.equal(parseDynamicPayload(withTail).files[0].name, 'a.txt');
});

test('动态格式：非图夹文件返回 null，损坏载荷不崩', () => {
  assert.equal(parseDynamicPayload(fakeCover('png')), null);
  assert.equal(parseDynamicPayload(new Uint8Array(0)), null);
  const broken = concatBytes([new TextEncoder().encode('DYNAMIC_V2_'), new Uint8Array([1, 2, 3])]);
  assert.equal(parseDynamicPayload(broken), null, '没有分隔符就该判非图夹');
});

test('动态格式：兼容更老的固定分隔符版本（OLD_DELIMITER）', () => {
  const enc = (s) => new TextEncoder().encode(s);
  const payload = concatBytes([
    enc(OLD_DELIMITER_TEXT),
    enc(OLD_FILENAME_DELIMITER_TEXT),
    enc('老格式.txt'),
    enc(OLD_FILENAME_DELIMITER_TEXT),
    enc(OLD_FILE_DELIMITER_TEXT),
    enc('old-content')
  ]);
  const parsed = parseDynamicPayload(payload);
  assert.ok(parsed);
  assert.equal(parsed.dynamic, false);
  assert.equal(parsed.files[0].name, '老格式.txt');
  assert.equal(new TextDecoder().decode(parsed.files[0].bytes), 'old-content');
});

test('动态格式：base64 工具自洽（含中文与填充）', () => {
  for (const text of ['a', 'ab', 'abc', '中文名字.txt', 'x'.repeat(50)]) {
    const bytes = new TextEncoder().encode(text);
    const back = base64ToBytes(bytesToBase64(bytes));
    assert.equal(new TextDecoder().decode(back), text);
  }
});

// —— 六、条目名净化与命名 ——

test('条目名净化：剥掉路径、只留 basename（防路径穿越）', () => {
  assert.equal(safeEntryName('../../evil.txt'), 'evil.txt');
  assert.equal(safeEntryName('..\\..\\windows\\system32\\evil.dll'), 'evil.dll');
  assert.equal(safeEntryName('C:\\abs\\name.txt'), 'name.txt');
  assert.equal(safeEntryName('/etc/passwd'), 'passwd');
  assert.equal(safeEntryName('..'), '未命名文件');
  assert.equal(safeEntryName(''), '未命名文件');
  assert.equal(safeEntryName('a:b?c.txt'), 'a_b_c.txt');
});

test('条目名净化：拦 Windows 保留设备名（v2.8.1）', () => {
  // 纯保留名（大小写不敏感）与带扩展名的形态都要避让
  assert.equal(safeEntryName('CON'), '_CON');
  assert.equal(safeEntryName('con'), '_con');
  assert.equal(safeEntryName('NUL.txt'), '_NUL.txt');
  assert.equal(safeEntryName('com1.dat'), '_com1.dat');
  assert.equal(safeEntryName('LPT9'), '_LPT9');
  assert.equal(safeEntryName('aux.cfg'), '_aux.cfg');
  assert.equal(safeEntryName('prn'), '_prn');
  // 不该误伤的：正常名里含这些子串
  assert.equal(safeEntryName('console.log'), 'console.log');
  assert.equal(safeEntryName('contact.txt'), 'contact.txt');
  assert.equal(safeEntryName('comedy.mp4'), 'comedy.mp4');
  assert.equal(safeEntryName('nulpaper.doc'), 'nulpaper.doc');
});

test('条目名净化：结尾点与空格剥掉（Windows 落盘行为对齐）', () => {
  assert.equal(safeEntryName('evil.'), 'evil');
  assert.equal(safeEntryName('evil...  '), 'evil');
  assert.equal(safeEntryName('name.txt. '), 'name.txt');
  assert.equal(safeEntryName('. '), '未命名文件'); // 剥完为空 → 兜底名
  assert.equal(safeEntryName('...'), '未命名文件');
});

test('重名条目自动加序号', () => {
  const used = new Set();
  assert.equal(uniqueEntryName(used, 'a.txt'), 'a.txt');
  assert.equal(uniqueEntryName(used, 'a.txt'), 'a(2).txt');
  assert.equal(uniqueEntryName(used, 'a.txt'), 'a(3).txt');
  assert.equal(uniqueEntryName(used, '无扩展名'), '无扩展名');
  assert.equal(uniqueEntryName(used, '无扩展名'), '无扩展名(2)');
});

test('重名条目：Windows 大小写不敏感，Photo.jpg 与 photo.jpg 不互相覆盖', () => {
  // 官方客户端打的包里完全可能同时有这两种写法；解包落到 Windows 磁盘上是同一个文件，
  // 不拦就会后写覆盖先写，而界面照样列两条（用户以为都解出来了）。
  const used = new Set();
  const a = uniqueEntryName(used, 'Photo.jpg');
  const b = uniqueEntryName(used, 'photo.jpg');
  const c = uniqueEntryName(used, 'PHOTO.JPG');
  assert.equal(a, 'Photo.jpg');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.equal(b, 'photo(2).jpg');
    assert.equal(c, 'PHOTO(3).JPG');
    const folded = new Set([a, b, c].map((n) => n.toLowerCase()));
    assert.equal(folded.size, 3, '三个条目必须落到三个不同文件上，否则就是静默覆盖');
  } else {
    // 大小写敏感的文件系统上三者本就是不同文件，不该改名
    assert.equal(b, 'photo.jpg');
    assert.equal(c, 'PHOTO.JPG');
  }
});

test('输出命名：重名加序号，目录同理', async () => {
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });
  const first = uniqueTargetPath(WORK, 'a_图夹', '.png');
  assert.equal(first, path.join(WORK, 'a_图夹.png'));
  await fsp.writeFile(first, new Uint8Array([1]));
  assert.equal(uniqueTargetPath(WORK, 'a_图夹', '.png'), path.join(WORK, 'a_图夹(2).png'));
  const dir = uniqueTargetDir(WORK, 'x_解出');
  await fsp.mkdir(dir);
  assert.equal(uniqueTargetDir(WORK, 'x_解出'), path.join(WORK, 'x_解出(2)'));
});

test('humanBytes 三档单位', () => {
  assert.equal(humanBytes(512), '512 B');
  assert.equal(humanBytes(2048), '2 KB');
  assert.equal(humanBytes(5 * 1024 * 1024), '5.00 MB');
});

test('体积提示：按门槛给出如实提醒（用户实测：788MB 的图网站打不开）', () => {
  const tiny = sizeWarning(200 * 1024, 100 * 1024);
  assert.equal(tiny.level, 'ok');
  assert.equal(tiny.text, '');

  const platform = sizeWarning(2 * 1024 * 1024, 2 * 1024 * 1024);
  assert.equal(platform.level, 'hint');
  assert.ok(/3MB|文件/.test(platform.text), platform.text);

  // 「防查」才需要整张图解压 → 超大文件警告它；「极速」只是提醒传输不便
  const web = sizeWarning(60 * 1024 * 1024, 512 * 1024, 'pro');
  assert.equal(web.level, 'warn');
  assert.ok(/打不开/.test(web.text), web.text);
  const fast = sizeWarning(60 * 1024 * 1024, 512 * 1024, 'fast');
  assert.equal(fast.level, 'hint');
  assert.ok(/网盘|传不动/.test(fast.text), fast.text);

  // 门槛：50MB 整不算超（与实现口径一致）
  assert.equal(sizeWarning(WEB_SAFE_BYTES, 0, 'pro').level, 'hint');
  assert.equal(sizeWarning(WEB_SAFE_BYTES + 1, 0, 'pro').level, 'warn');
});

// —— 七、引擎端到端（直接调 Node 侧引擎，不经界面） ——

await testAsync('引擎：极速模式（动态混淆）任意格式表图都能打包 → 解包逐字节一致', async () => {
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });
  const item = path.join(WORK, 'fast.txt');
  const content = new TextEncoder().encode('极速模式的内容');
  await fsp.writeFile(item, content);

  // PNG 表图
  const coverPng = path.join(WORK, 'fast-cover.png');
  await fsp.writeFile(coverPng, fakeCover('png'));
  const packedPng = await packImage({ mode: 'fast', coverPath: coverPng, items: [{ path: item }], outputDir: WORK });
  assert.ok(packedPng.path.endsWith('_图夹.png'), packedPng.path);
  const pngBytes = new Uint8Array(await fsp.readFile(packedPng.path));
  assert.deepEqual([...pngBytes.subarray(0, (await fsp.readFile(coverPng)).length)], [...await fsp.readFile(coverPng)], '表图零改动');
  assert.ok(indexOfBytes(pngBytes, DYNAMIC_PREFIX) !== -1, '尾部应有 DYNAMIC_V2_ 前缀');
  const outPng = await unpackImage({ imagePath: packedPng.path, outputDir: path.join(WORK, 'fast-out-png') });
  assert.equal(outPng.files.length, 1);
  assert.deepEqual([...await fsp.readFile(outPng.files[0].path)], [...content]);

  // 「其它格式」的表图（用字节冒充 JPG 头即可：极速模式不解码表图）
  const coverJpg = path.join(WORK, 'fast-cover.jpg');
  await fsp.writeFile(coverJpg, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]));
  const packedJpg = await packImage({ mode: 'fast', coverPath: coverJpg, items: [{ path: item }], outputDir: WORK });
  assert.ok(packedJpg.path.endsWith('_图夹.jpg'), `应保留表图扩展名：${packedJpg.path}`);
  const outJpg = await unpackImage({ imagePath: packedJpg.path, outputDir: path.join(WORK, 'fast-out-jpg') });
  assert.deepEqual([...await fsp.readFile(outJpg.files[0].path)], [...content]);

  // 极速文件里不该有 PRO 指纹（否则网页版会弹密码框）
  assert.equal(indexOfBytes(new Uint8Array(await fsp.readFile(packedPng.path)), FINGERPRINT), -1);
});

await testAsync('引擎：PNG 表图 打包 → 解包 逐字节一致', async () => {
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });
  const cover = path.join(WORK, 'cover.png');
  await fsp.writeFile(cover, fakeCover('png'));
  const item1 = path.join(WORK, '报告.txt');
  const item2 = path.join(WORK, 'data.bin');
  const payload1 = new TextEncoder().encode('藏起来的内容');
  const payload2 = rgbaPixels(128, 32, 99);
  await fsp.writeFile(item1, payload1);
  await fsp.writeFile(item2, payload2);

  const packed = await packImage({
    mode: 'pro',
    coverPath: cover,
    items: [{ path: item1 }, { path: item2 }],
    outputDir: WORK
  });
  assert.equal(packed.ok, true);
  assert.ok(fs.existsSync(packed.path), '产物应存在');
  assert.ok(packed.path.endsWith('_图夹.png'), packed.path);
  assert.ok(packed.size > fs.statSync(cover).size, '产物应比表图大');

  const unpacked = await unpackImage({ imagePath: packed.path, outputDir: path.join(WORK, 'out') });
  assert.equal(unpacked.ok, true);
  assert.equal(unpacked.files.length, 2);
  assert.deepEqual([...await fsp.readFile(path.join(unpacked.dir, '报告.txt'))], [...payload1]);
  assert.deepEqual([...await fsp.readFile(path.join(unpacked.dir, 'data.bin'))], [...payload2]);
});

await testAsync('引擎：GIF 表图 打包 → 解包 逐字节一致，且原 GIF 部分零改动', async () => {
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });
  const cover = path.join(WORK, 'cover.gif');
  const gifBytes = fakeCover('gif');
  await fsp.writeFile(cover, gifBytes);
  const item = path.join(WORK, 'a.txt');
  await fsp.writeFile(item, new TextEncoder().encode('gif 里的小秘密'));

  const packed = await packImage({ mode: 'pro', coverPath: cover, items: [{ path: item }], outputDir: WORK });
  assert.ok(packed.path.endsWith('_图夹.gif'), packed.path);
  const packedBytes = await fsp.readFile(packed.path);
  assert.deepEqual([...packedBytes.subarray(0, gifBytes.length)], [...gifBytes]);

  const unpacked = await unpackImage({ imagePath: packed.path, outputDir: path.join(WORK, 'out') });
  assert.equal(unpacked.files.length, 1);
  assert.equal(await fsp.readFile(path.join(unpacked.dir, 'a.txt'), 'utf8'), 'gif 里的小秘密');
});

await testAsync('引擎：带密码往返成功，错误密码给「密码错误」且不落盘', async () => {
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });
  const cover = path.join(WORK, 'c.png');
  await fsp.writeFile(cover, fakeCover('png'));
  const item = path.join(WORK, 's.txt');
  await fsp.writeFile(item, new TextEncoder().encode('secret'));

  const packed = await packImage({ mode: 'pro', coverPath: cover, items: [{ path: item }], password: 'pw123', outputDir: WORK });
  const okOut = path.join(WORK, 'ok');
  const ok = await unpackImage({ imagePath: packed.path, password: 'pw123', outputDir: okOut });
  assert.equal(ok.encrypted, true);
  assert.equal(await fsp.readFile(path.join(ok.dir, 's.txt'), 'utf8'), 'secret', '正确密码应能解开');

  const badOut = path.join(WORK, 'bad');
  await assert.rejects(
    () => unpackImage({ imagePath: packed.path, password: 'nope', outputDir: badOut }),
    /密码错误/
  );
  assert.equal(fs.existsSync(badOut), false, '密码错误不应留下目录/垃圾');

  // 不带密码去解带密码的图：给「可能设了密码」的可读提示
  await assert.rejects(
    () => unpackImage({ imagePath: packed.path, outputDir: path.join(WORK, 'none') }),
    /可能设了密码/
  );
});

await testAsync('引擎：非图夹图 / 损坏文件都给可读错误', async () => {
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });
  const plain = path.join(WORK, 'plain.png');
  await fsp.writeFile(plain, fakeCover('png'));
  await assert.rejects(() => unpackImage({ imagePath: plain }), /不是图夹图|被压缩/);

  const jpeg = path.join(WORK, 'photo.jpg');
  await fsp.writeFile(jpeg, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  await assert.rejects(() => unpackImage({ imagePath: jpeg }), /不是图夹图/);

  const broken = path.join(WORK, 'broken.png');
  await fsp.writeFile(broken, fakeCover('png').subarray(0, 30));
  await assert.rejects(() => unpackImage({ imagePath: broken }), /分块不完整|不是图夹图/);
});

await testAsync('引擎：里图带路径穿越名 → 落盘时已被净化在同一目录', async () => {
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });
  const cover = path.join(WORK, 'c.png');
  await fsp.writeFile(cover, fakeCover('png'));
  const item = path.join(WORK, 'x.bin');
  await fsp.writeFile(item, new Uint8Array([7]));

  const packed = await packImage({
    coverPath: cover,
    items: [{ path: item, name: '../../逃逸.txt' }],
    outputDir: WORK
  });
  const out = path.join(WORK, 'out');
  const unpacked = await unpackImage({ imagePath: packed.path, outputDir: out });
  assert.equal(path.dirname(unpacked.files[0].path), out, '必须落在输出目录内');
  assert.ok(!fs.existsSync(path.join(WORK, '逃逸.txt')));
});

await testAsync('引擎：随机表图路径（只给 coverBytes，没有源文件）也能打包落盘', async () => {
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });
  const item = path.join(WORK, 'random.txt');
  await fsp.writeFile(item, new TextEncoder().encode('随机表图路径下的内容'));

  const packed = await packImage({
    coverBytes: fakeCover('png'),      // 界面进程生成的封面（内存里，没有磁盘来源）
    coverKind: 'png',
    items: [{ path: item }],
    outputDir: WORK,
    baseName: '随机表图-测试'
  });
  assert.equal(packed.ok, true);
  assert.ok(packed.path.endsWith('随机表图-测试_图夹.png'), packed.path);
  const out = await unpackImage({ imagePath: packed.path, outputDir: path.join(WORK, 'out-random') });
  assert.equal(await fsp.readFile(out.files[0].path, 'utf8'), '随机表图路径下的内容');

  // outputPath：给死路径时按用户选的位置写（保存对话框场景）
  const exact = path.join(WORK, '指定位置.png');
  const packed2 = await packImage({ coverBytes: fakeCover('png'), coverKind: 'png', items: [{ path: item }], outputPath: exact });
  assert.equal(packed2.path, exact);
  assert.ok(fs.existsSync(exact));
});

await testAsync('引擎：没有里图时报错，表图非 PNG/GIF 时报错', async () => {
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });
  const cover = path.join(WORK, 'c.png');
  await fsp.writeFile(cover, fakeCover('png'));
  await assert.rejects(() => packImage({ coverPath: cover, items: [], outputDir: WORK }), /还没有要藏进去的文件/);
  // 「防查」模式才限制表图格式；「极速」什么格式都行（数据追加在尾部）
  await assert.rejects(
    () => packImage({ mode: 'pro', coverBytes: new Uint8Array([0xff, 0xd8, 0xff]), items: [{ path: cover }], outputDir: WORK }),
    /只支持 PNG \/ GIF/
  );
});

// —— 汇总 ——

await fsp.rm(WORK, { recursive: true, force: true });

console.log(results.join('\n'));
console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
if (fail > 0) process.exit(1);