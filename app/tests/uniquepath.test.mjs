// 输出文件名分配器（src/shared/unique-target-path.cjs）—— 纯逻辑单测
// 运行：cd app && node tests/uniquepath.test.mjs（已挂进 npm test）
//
// 为什么要单独钉这个函数：它管的是「存到用户目录的产物叫什么名字」。
// 旧实现只用 existsSync 探测，而「探测」与「落盘」之间隔着 await——任务队列 io 通道
// 并发 2 时，两个任务会拿到同一个名字，后写的静默覆盖先写的，两条都报成功。
// 用户看到的就是「转了 10 张图，目录里只有 9 张」，且没有任何报错。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mod from '../src/shared/unique-target-path.cjs';

const { uniqueTargetPath } = mod;

let pass = 0;
let fail = 0;
const results = [];
const roots = [];

/** 每个用例一个独立临时目录，收尾统一清掉（不污染仓库、不留垃圾） */
function tempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-uniquepath-'));
  roots.push(root);
  return root;
}

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

console.log('输出文件名分配器（绝不覆盖已有文件）单测\n');

test('空目录：第一次分配得到原名', () => {
  const dir = tempDir();
  const got = uniqueTargetPath(dir, 'IMG_01', '.jpg');
  assert.equal(got, path.join(dir, 'IMG_01.jpg'));
});

test('★ 连续分配两次（中间不落盘）必须拿到不同名字——并发覆盖的回归钉子', () => {
  const dir = tempDir();
  // 旧实现（只 existsSync 探测）在这里会返回两个完全相同的路径：
  // 第一次分配后文件还没写，第二次探测自然还是「不存在」。
  const a = uniqueTargetPath(dir, 'IMG_01', '.jpg');
  const b = uniqueTargetPath(dir, 'IMG_01', '.jpg');
  assert.notEqual(a, b, '两个并发任务拿到了同一个输出名，后写的会静默覆盖先写的');
  assert.equal(path.basename(a), 'IMG_01.jpg');
  assert.equal(path.basename(b), 'IMG_01(1).jpg');
});

test('★ 模拟 io 通道并发：同时分配 20 个名字互不重复', () => {
  const dir = tempDir();
  const got = Array.from({ length: 20 }, () => uniqueTargetPath(dir, '照片', '.png'));
  const unique = new Set(got);
  assert.equal(unique.size, 20, `出现重名：${got.length - unique.size} 个`);
  assert.equal(fs.readdirSync(dir).length, 20, '每个名字都应已被占位');
});

test('目录里已有同名文件：自动加序号，且原文件内容分毫不动', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, '报告.txt'), '用户原来的内容', 'utf8');
  const got = uniqueTargetPath(dir, '报告', '.txt');
  assert.equal(path.basename(got), '报告(1).txt');
  fs.writeFileSync(got, '新产物', 'utf8');
  assert.equal(fs.readFileSync(path.join(dir, '报告.txt'), 'utf8'), '用户原来的内容', '原文件被覆盖了');
});

test('序号连续递增：原名 → (1) → (2) → (3)', () => {
  const dir = tempDir();
  const names = Array.from({ length: 4 }, () => path.basename(uniqueTargetPath(dir, 'a', '.bin')));
  assert.deepEqual(names, ['a.bin', 'a(1).bin', 'a(2).bin', 'a(3).bin']);
});

test('序号不跳号：中间的空位会被重新用上', () => {
  const dir = tempDir();
  const first = uniqueTargetPath(dir, 'a', '.bin');
  uniqueTargetPath(dir, 'a', '.bin');            // a(1).bin
  fs.rmSync(first, { force: true });              // 腾出 a.bin
  assert.equal(path.basename(uniqueTargetPath(dir, 'a', '.bin')), 'a.bin');
});

test('目标目录不存在：自动建出来（openSync 不会替你建目录）', () => {
  const root = tempDir();
  const dir = path.join(root, '还没建的子目录', '再深一层');
  const got = uniqueTargetPath(dir, 'x', '.dat');
  assert.ok(fs.existsSync(dir), '目录应被自动创建');
  assert.equal(path.dirname(got), dir);
});

test('占位文件是 0 字节：等调用方把真正的产物写进去', () => {
  const dir = tempDir();
  const got = uniqueTargetPath(dir, 'x', '.dat');
  assert.equal(fs.statSync(got).size, 0);
});

test('ext 带不带前导点结果一致', () => {
  const a = uniqueTargetPath(tempDir(), 'x', '.mp4');
  const b = uniqueTargetPath(tempDir(), 'x', 'mp4');
  assert.equal(path.basename(a), path.basename(b));
  assert.equal(path.basename(a), 'x.mp4');
});

test('文件名里带括号/空格/中文也能正常分配', () => {
  const dir = tempDir();
  const a = uniqueTargetPath(dir, '我的 照片 ( final )', '.jpeg');
  const b = uniqueTargetPath(dir, '我的 照片 ( final )', '.jpeg');
  assert.notEqual(a, b);
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
});

test('目录不可写时抛错，而不是死循环或返回一个写不进去的路径', () => {
  // 用一个「已存在的文件」当目录传进去：mkdirSync 会以 ENOTDIR/EEXIST 失败并抛出
  const root = tempDir();
  const notADir = path.join(root, 'iam-a-file');
  fs.writeFileSync(notADir, 'x', 'utf8');
  assert.throws(() => uniqueTargetPath(notADir, 'x', '.dat'));
});

// —— 汇总 ——

console.log(results.join('\n'));
console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
for (const r of roots) {
  try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}
if (fail > 0) process.exit(1);
