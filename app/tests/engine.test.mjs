// 算法引擎自动测试（Node 直接运行，无需界面）
// 运行：cd app && npm test        （或 node tests/engine.test.mjs）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { md5Hex } from '../src/tools/obfuscate/core/md5.js';
import { shuffleWithKey } from '../src/tools/obfuscate/core/shuffle.js';
import { gilbert2d } from '../src/tools/obfuscate/core/gilbert.js';
import { processPixels, outputSize, validateKey } from '../src/tools/obfuscate/core/engine.js';

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function makeImage(w, h, seed = 12345) {
  const px = new Uint8ClampedArray(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < px.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    px[i] = (s >>> 16) & 0xff;
  }
  return px;
}

function sameBuffer(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 比较解密结果与原图（方块模式解密结果为填充后尺寸，只比较原始区域并检查填充区为透明黑） */
function assertRestored(dec, w, h, src, label) {
  const pw = dec.width;
  if (pw === w && dec.height === h) {
    assert.ok(sameBuffer(dec.pixels, src), `${label}：往返结果与原图不一致`);
    return;
  }
  for (let j = 0; j < h; j++) {
    const dstOff = j * pw * 4;
    const srcOff = j * w * 4;
    for (let k = 0; k < w * 4; k++) {
      assert.equal(dec.pixels[dstOff + k], src[srcOff + k], `${label}：第 ${j} 行第 ${k} 字节不一致`);
    }
  }
  // 填充区应为透明黑
  for (let j = 0; j < dec.height; j++) {
    for (let i = 0; i < pw; i++) {
      if (i < w && j < h) continue;
      const off = (i + j * pw) * 4;
      for (let k = 0; k < 4; k++) {
        assert.equal(dec.pixels[off + k], 0, `${label}：填充区 (${i},${j}) 应为透明黑`);
      }
    }
  }
}

const KEY_STR = 'test密钥123';
const KEY_NUM = 0.666;

const MODES = [
  { mode: 'gilbert', key: undefined },
  { mode: 'b', key: KEY_STR },
  { mode: 'c', key: KEY_STR },
  { mode: 'c2', key: KEY_STR },
  { mode: 'pe1', key: KEY_NUM },
  { mode: 'pe2', key: KEY_NUM }
];

const SIZES = [
  [37, 19],
  [64, 64],
  [100, 50],
  [1, 1],
  [3, 5],
  [32, 32],
  [96, 64]
];

console.log('\n[1] MD5');
test('与 Node 内置 MD5 完全一致（含中文与 emoji，验证 UTF-8 编码）', () => {
  const samples = ['', 'a', 'abc', '密钥', 'test密钥123', '🍅番茄', 'abc123!@#', '中文English混合', 'x'.repeat(200)];
  for (const s of samples) {
    assert.equal(md5Hex(s), createHash('md5').update(s, 'utf8').digest('hex'), `MD5 不一致：${s}`);
  }
});

console.log('\n[2] 密钥洗牌');
test('洗牌表是合法排列（每个下标恰好出现一次）', () => {
  for (const n of [1, 2, 31, 32, 33, 100, 999]) {
    const arr = shuffleWithKey(n, KEY_STR);
    assert.equal(arr.length, n, `长度不符：${n}`);
    const seen = new Set(arr);
    assert.equal(seen.size, n, `存在重复下标：${n}`);
    for (const v of arr) assert.ok(v >= 0 && v < n, `越界下标：${v}`);
  }
});

test('同密钥结果稳定、不同密钥结果不同', () => {
  const a = shuffleWithKey(64, 'key-A');
  const b = shuffleWithKey(64, 'key-A');
  const c = shuffleWithKey(64, 'key-B');
  assert.ok(sameBuffer(a, b), '同密钥结果应一致');
  assert.ok(!sameBuffer(a, c), '不同密钥结果应不同');
});

console.log('\n[3] Gilbert 曲线');
test('覆盖全部像素且不重复（1~40 各尺寸）', () => {
  for (let w = 1; w <= 40; w++) {
    for (let h = 1; h <= 40; h++) {
      const pos = gilbert2d(w, h, 'trunc');
      assert.equal(pos.length, w * h, `尺寸 ${w}x${h} 访问点数不符`);
      const seen = new Set(pos);
      assert.equal(seen.size, w * h, `尺寸 ${w}x${h} 存在重复或缺失`);
      for (const v of pos) assert.ok(v >= 0 && v < w * h, `尺寸 ${w}x${h} 出现越界下标`);
    }
  }
});

test('两种取整方式差异统计（信息项，不作失败判定）', () => {
  let diff = 0;
  const examples = [];
  for (let w = 1; w <= 40; w++) {
    for (let h = 1; h <= 40; h++) {
      const a = gilbert2d(w, h, 'trunc');
      const b = gilbert2d(w, h, 'floor');
      if (a.length !== b.length || !sameBuffer(a, b)) {
        diff++;
        if (examples.length < 6) examples.push(`${w}x${h}`);
      }
    }
  }
  console.log(`      （trunc 与 floor 不同的尺寸：${diff}/1600${examples.length ? '，例如 ' + examples.join('、') : ''}）`);
});

console.log('\n[4] 六种模式往返一致（混淆 → 解混淆 = 原图）');
for (const { mode, key } of MODES) {
  for (const [w, h] of SIZES) {
    test(`${mode} ${w}x${h}`, () => {
      const src = makeImage(w, h);
      const enc = processPixels({ mode, key, direction: 'encrypt', width: w, height: h, pixels: src });
      const dec = processPixels({
        mode,
        key,
        direction: 'decrypt',
        width: enc.width,
        height: enc.height,
        pixels: enc.pixels
      });
      assert.equal(dec.width, enc.width, '解密宽度与加密输出不一致');
      assert.equal(dec.height, enc.height, '解密高度与加密输出不一致');
      assertRestored(dec, w, h, src, `${mode} ${w}x${h}`);
    });
  }
}

console.log('\n[5] 尺寸与填充规则');
test('方块模式输出尺寸为 32 的倍数（100x50 → 128x64）', () => {
  const s = outputSize('b', 100, 50);
  assert.equal(s.width, 128);
  assert.equal(s.height, 64);
  assert.equal(s.padded, true);
  const s2 = outputSize('b', 64, 96);
  assert.equal(s2.width, 64);
  assert.equal(s2.height, 96);
  assert.equal(s2.padded, false);
});

test('非方块模式输出尺寸不变', () => {
  for (const mode of ['gilbert', 'c', 'c2', 'pe1', 'pe2']) {
    const s = outputSize(mode, 100, 50);
    assert.equal(s.width, 100);
    assert.equal(s.height, 50);
    assert.equal(s.padded, false);
  }
});

test('方块模式加密输出的实际尺寸符合填充规则', () => {
  const src = makeImage(100, 50);
  const enc = processPixels({ mode: 'b', key: KEY_STR, direction: 'encrypt', width: 100, height: 50, pixels: src });
  assert.equal(enc.width, 128);
  assert.equal(enc.height, 64);
});

console.log('\n[6] 行为性质');
test('混淆确实改变图像（非单位置换）', () => {
  const w = 64;
  const h = 64;
  const src = makeImage(w, h);
  for (const { mode, key } of MODES) {
    const enc = processPixels({ mode, key, direction: 'encrypt', width: w, height: h, pixels: src });
    assert.ok(!sameBuffer(enc.pixels, src), `${mode} 混淆后与原图完全相同`);
  }
});

test('确定性：同输入同密钥结果一致', () => {
  const w = 48;
  const h = 33;
  const src = makeImage(w, h, 777);
  for (const { mode, key } of MODES) {
    const a = processPixels({ mode, key, direction: 'encrypt', width: w, height: h, pixels: src });
    const b = processPixels({ mode, key, direction: 'encrypt', width: w, height: h, pixels: src });
    assert.ok(sameBuffer(a.pixels, b.pixels), `${mode} 两次结果不一致`);
  }
});

test('不同密钥产生不同结果（字符串与小数密钥各测一种）', () => {
  const w = 40;
  const h = 24;
  const src = makeImage(w, h, 999);
  const c1 = processPixels({ mode: 'c', key: 'key-A', direction: 'encrypt', width: w, height: h, pixels: src });
  const c2 = processPixels({ mode: 'c', key: 'key-B', direction: 'encrypt', width: w, height: h, pixels: src });
  assert.ok(!sameBuffer(c1.pixels, c2.pixels), '像素混淆：不同密钥结果相同');
  const p1 = processPixels({ mode: 'pe1', key: 0.666, direction: 'encrypt', width: w, height: h, pixels: src });
  const p2 = processPixels({ mode: 'pe1', key: 0.321, direction: 'encrypt', width: w, height: h, pixels: src });
  assert.ok(!sameBuffer(p1.pixels, p2.pixels), 'PE1：不同密钥结果相同');
});

console.log('\n[7] 密钥校验规则（与手机版一致）');
test('PE1/PE2 必须是 0~1 之间的小数', () => {
  assert.equal(validateKey('pe1', 0.666).ok, true);
  assert.equal(validateKey('pe2', '0.5').ok, true);
  assert.equal(validateKey('pe1', 0).ok, false);
  assert.equal(validateKey('pe1', 1).ok, false);
  assert.equal(validateKey('pe1', 1.5).ok, false);
  assert.equal(validateKey('pe1', 'abc').ok, false);
});

test('B/C/C2 接受任意字符串、gilbert 无需密钥', () => {
  assert.equal(validateKey('b', '').ok, true);
  assert.equal(validateKey('c', '任意中文密钥').ok, true);
  assert.equal(validateKey('c2', 'k').ok, true);
  assert.equal(validateKey('gilbert', undefined).ok, true);
});

// —— 汇总 ——
console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
if (fail > 0) {
  console.log('失败明细：');
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}