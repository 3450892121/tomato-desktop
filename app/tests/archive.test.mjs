// 「文件压缩与解压」工具 —— 纯逻辑单测（不需要 Electron、不需要 7-Zip）
// 运行：cd app && node tests/archive.test.mjs
// 覆盖：格式矩阵自洽性、级别映射、分卷参数、参数拼装、输出解析、路径安全、计划生成、命名与文案。
// 计划与规格：spec/modules/archive.md
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BIDIRECTIONAL, EXTRACT_ONLY, ALL_FORMATS, LEVELS, VOLUME_SIZES,
  formatById, formatByExt, supportsPassword, supportsVolume, isNodeFormat,
  isCompound, compoundOuter, isTarFlavored, extractOnlyByExt,
  looksLikeFirstVolume, looksLikeVolumePart, firstVolumeName, ARCHIVE_EXTS
} from '../src/tools/archive/core/formats.mjs';
import {
  createArgs, extractArgs, listArgs, sevenZipLevel, zstdLevel, brotliQuality,
  volumeArg, parseListOutput, parseArchiveMeta, splitListOutput, findSuspiciousEntries,
  parseProgressPercent, parseCurrentEntry, findInnerTar, checkSingleEntryOnly,
  translateSevenZipError
} from '../src/tools/archive/core/params.mjs';
import {
  baseNameOf, dirNameOf, stripArchiveExt, suggestArchiveBase, suggestArchiveName,
  validateCreate, validateExtract, buildCreatePlan, buildExtractPlan, humanBytes, ratioText
} from '../src/tools/archive/core/plan.mjs';
import { cleanupFailedOutput } from '../src/tools/archive/core/engine.mjs';

let pass = 0;
let fail = 0;
const results = [];
const pending = [];

// 同步与异步用例共用一个登记器：异步用例（失败清理要碰真实临时目录）先入队，汇总前统一 await。
function test(name, fn) {
  pending.push((async () => {
    try {
      await fn();
      pass += 1;
      results.push(`  ✅ ${name}`);
    } catch (err) {
      fail += 1;
      results.push(`  ❌ ${name}\n       ${err.message}`);
    }
  })());
}

console.log('「文件压缩与解压」纯逻辑测试\n');

// —— 一、格式矩阵自洽性 ——

test('主流格式全部双向（ZIP / 7Z / TAR / GZIP）', () => {
  for (const id of ['zip', '7z', 'tar', 'gzip']) {
    const f = formatById(id);
    assert.ok(f, `缺少主流格式 ${id}`);
    assert.ok(f.password !== undefined, `${id} 应为双向格式`);
  }
});

test('非主流双向格式 ≥2 种（BZIP2 / XZ / ZSTANDARD / BROTLI）', () => {
  const alt = BIDIRECTIONAL.filter((f) => f.group === 'alt' && !isCompound(f) && f.ext.split('.').length === 2);
  const ids = alt.map((f) => f.id);
  for (const id of ['bz2', 'xz', 'zst', 'br']) assert.ok(ids.includes(id), `缺少 ${id}`);
  assert.ok(ids.length >= 2, `非主流格式只有 ${ids.length} 种`);
});

test('双向格式的 id / ext / type 唯一且非空', () => {
  const ids = new Set();
  const exts = new Set();
  for (const f of BIDIRECTIONAL) {
    assert.ok(f.id && f.name && f.ext && f.group && f.engine, `${f.id} 字段不完整`);
    assert.ok(!ids.has(f.id), `id 重复：${f.id}`);
    assert.ok(!exts.has(f.ext), `ext 重复：${f.ext}`);
    ids.add(f.id);
    exts.add(f.ext);
  }
});

test('仅解压格式不含 RAR 之外的重复，且都不带 password 字段', () => {
  for (const f of EXTRACT_ONLY) {
    assert.equal(f.password, undefined, `${f.id} 不应有 password（它是仅解压）`);
    assert.ok(f.name && f.ext, `${f.id} 字段不完整`);
  }
  assert.ok(EXTRACT_ONLY.some((f) => f.id === 'rar'), 'RAR 应在仅解压清单里');
});

test('RAR 绝不出现为可创建格式（专有格式限制）', () => {
  assert.equal(formatById('rar').password, undefined);
  assert.ok(!BIDIRECTIONAL.some((f) => /rar/i.test(f.id) || /rar/i.test(f.ext)), 'BI_DIR 里不应有 rar');
});

test('ALL_FORMATS = 双向 + 仅解压', () => {
  assert.equal(ALL_FORMATS.length, BIDIRECTIONAL.length + EXTRACT_ONLY.length);
});

test('formatByExt 按后缀命中，且取最长匹配（.tar.gz 不能被 .gz 抢走）', () => {
  assert.equal(formatByExt('.zip').id, 'zip');
  assert.equal(formatByExt('.7z').id, '7z');
  assert.equal(formatByExt('.tar').id, 'tar');
  assert.equal(formatByExt('.gz').id, 'gzip');
  assert.equal(formatByExt('.tar.gz').id, 'tar.gz', '必须最长匹配');
  assert.equal(formatByExt('.tar.xz').id, 'tar.xz');
  assert.equal(formatByExt('.TAR.XZ').id, 'tar.xz');
  assert.equal(formatByExt('.rar'), null, 'rar 不是双向格式');
});

test('extractOnlyByExt 也取最长匹配（.xz 不能被 .z 抢走）', () => {
  assert.equal(extractOnlyByExt('.xz'), null, '.xz 是双向格式，不属于仅解压');
  assert.equal(extractOnlyByExt('.z').id, 'z');
  assert.equal(extractOnlyByExt('.rar').id, 'rar');
  assert.equal(extractOnlyByExt('.iso').id, 'iso');
});

test('分卷卷号识别：.NNN 结尾即分卷的一部分', () => {
  assert.equal(looksLikeVolumePart('a.7z.001'), true);
  assert.equal(looksLikeVolumePart('a.zip.012'), true);
  assert.equal(looksLikeVolumePart('a.zip'), false);
  assert.equal(looksLikeVolumePart('a.zip.1'), false, '不足三位不算');
});

test('密码能力矩阵：只有 7z 与 zip 支持密码', () => {
  assert.equal(supportsPassword(formatById('7z'), '7z'), true);
  assert.equal(supportsPassword(formatById('zip'), 'zip-aes256'), true);
  assert.equal(supportsPassword(formatById('zip'), 'zipcrypto'), true);
  assert.equal(supportsPassword(formatById('tar'), null), true, 'tar 无密码时可用');
  assert.equal(supportsPassword(formatById('tar'), '7z'), false, 'tar 不支持密码');
  assert.equal(supportsPassword(formatById('gzip'), 'zip-aes256'), false);
});

test('分卷能力：zip / 7z / tar 支持，流式与复合格式不支持', () => {
  for (const id of ['zip', '7z', 'tar']) assert.equal(supportsVolume(formatById(id)), true, `${id} 应支持分卷`);
  for (const id of ['gzip', 'bz2', 'xz', 'zst', 'br', 'tar.gz', 'tar.zst']) {
    assert.equal(supportsVolume(formatById(id)), false, `${id} 不应支持分卷`);
  }
});

test('Node 原生格式标记：zst / br 走内置 zlib（没装 7-Zip 也能用）', () => {
  assert.equal(isNodeFormat(formatById('zst')), true);
  assert.equal(isNodeFormat(formatById('br')), true);
  assert.equal(isNodeFormat(formatById('zip')), false);
});

test('复合格式清单与外层算法正确', () => {
  const map = { 'tar.gz': 'gzip', 'tar.bz2': 'bzip2', 'tar.xz': 'xz', 'tar.zst': 'zst', 'tar.br': 'br' };
  for (const [id, outer] of Object.entries(map)) {
    const f = formatById(id);
    assert.ok(isCompound(f), `${id} 应是复合格式`);
    assert.equal(compoundOuter(f), outer);
  }
  assert.equal(isCompound(formatById('tar')), false);
});

test('isTarFlavored 只认 tar.* 家族', () => {
  for (const e of ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tar.br']) assert.equal(isTarFlavored(e), true, e);
  for (const e of ['.tar', '.gz', '.zip', '.7z']) assert.equal(isTarFlavored(e), false, e);
});

test('extractOnlyByExt 识别 RAR / ISO 等', () => {
  assert.equal(extractOnlyByExt('.rar').id, 'rar');
  assert.equal(extractOnlyByExt('.ISO').id, 'iso');
  assert.equal(extractOnlyByExt('.zip'), null);
});

test('ARCHIVE_EXTS 覆盖全部格式且不带点', () => {
  for (const e of ARCHIVE_EXTS) assert.ok(!e.startsWith('.'), `${e} 不应带点`);
  assert.ok(ARCHIVE_EXTS.includes('tar.gz'), '应含复合后缀');
  assert.ok(ARCHIVE_EXTS.includes('rar'));
});

test('分卷首卷名判定与归一', () => {
  assert.equal(looksLikeFirstVolume('a.7z.001'), true);
  assert.equal(looksLikeFirstVolume('a.zip.001'), true);
  assert.equal(looksLikeFirstVolume('a.zip.002'), false, '只有 .001 是首卷');
  assert.equal(looksLikeFirstVolume('a.zip'), false);
  assert.equal(firstVolumeName('a.7z.002'), 'a.7z.001');
  assert.equal(firstVolumeName('a.7z'), 'a.7z.001');
  assert.equal(firstVolumeName('a.7z.001'), 'a.7z.001');
});

// —— 二、级别与参数映射 ——

test('级别清单含 store→extreme 六档，默认 normal', () => {
  const ids = LEVELS.map((l) => l.id);
  assert.deepEqual(ids, ['store', 'fastest', 'fast', 'normal', 'small', 'extreme']);
});

test('级别 → 7-Zip -mx 映射（store=0 不压缩）', () => {
  assert.equal(sevenZipLevel('store'), 0);
  assert.equal(sevenZipLevel('fastest'), 1);
  assert.equal(sevenZipLevel('fast'), 3);
  assert.equal(sevenZipLevel('normal'), 5);
  assert.equal(sevenZipLevel('small'), 7);
  assert.equal(sevenZipLevel('extreme'), 9);
  assert.equal(sevenZipLevel('不存在'), 5, '未知级别回落 normal');
});

test('级别 → Node zstd / brotli 参数映射（越大越慢越小）', () => {
  const zs = ['store', 'fastest', 'fast', 'normal', 'small', 'extreme'].map(zstdLevel);
  const bq = ['store', 'fastest', 'fast', 'normal', 'small', 'extreme'].map(brotliQuality);
  for (let i = 1; i < zs.length; i += 1) assert.ok(zs[i] >= zs[i - 1], 'zstd 级别应单调不减');
  for (let i = 1; i < bq.length; i += 1) assert.ok(bq[i] >= bq[i - 1], 'brotli 质量应单调不减');
  assert.equal(zstdLevel('extreme'), 19);
  assert.equal(brotliQuality('extreme'), 11);
  assert.equal(brotliQuality('fastest'), 1);
});

test('分卷参数体积换算（m / g / k）', () => {
  assert.equal(volumeArg(0), null);
  assert.equal(volumeArg(-1), null);
  assert.equal(volumeArg(10 * 1024 * 1024), '10m');
  assert.equal(volumeArg(100 * 1024 * 1024), '100m');
  assert.equal(volumeArg(1024 * 1024 * 1024), '1g');
  assert.equal(volumeArg(4 * 1024 * 1024 * 1024), '4g');
  assert.equal(volumeArg(2048), '2k');
  assert.equal(VOLUME_SIZES[0].id, 0, '第一档应为不分卷');
});

test('压缩参数：zip 无密码', () => {
  const args = createArgs({ format: formatById('zip'), level: 'normal', archivePath: 'C:\\o\\a.zip', names: ['x.txt'] });
  assert.ok(args.includes('-tzip'));
  assert.ok(args.includes('-mx=5'));
  assert.ok(args.includes('-bsp1') && args.includes('-bb1') && args.includes('-y'));
  assert.ok(!args.some((a) => a === '-p' || a.startsWith('-p')), '无密码时不能出现 -p（空 -p 会被当成真加密）');
  assert.ok(!args.some((a) => a.startsWith('-mem=')), '无密码时不该给 -mem');
  assert.equal(args[args.length - 1], 'x.txt');
  assert.equal(args[args.length - 2], 'C:\\o\\a.zip');
});

test('压缩参数：7z 密码 → AES-256 + 加密文件名', () => {
  const args = createArgs({ format: formatById('7z'), level: 'small', password: 'p@ss', archivePath: 'a.7z', names: ['x'] });
  assert.ok(args.includes('-pp@ss'), '密码原样拼在 -p 后面');
  assert.ok(args.includes('-mhe=on'), '7z 必须加密文件名');
  assert.ok(!args.some((a) => a.startsWith('-mem=')), '7z 不用 -mem（那是 zip 的）');
  assert.ok(args.includes('-mx=7'));
});

test('压缩参数：zip 密码两种方案（AES256 默认 / ZipCrypto 兼容）', () => {
  const aes = createArgs({ format: formatById('zip'), level: 'normal', password: 'k', archivePath: 'a.zip', names: ['x'] });
  assert.ok(aes.includes('-mem=AES256'));
  const zc = createArgs({ format: formatById('zip'), level: 'normal', password: 'k', encrypt: 'zipcrypto', archivePath: 'a.zip', names: ['x'] });
  assert.ok(zc.includes('-mem=ZipCrypto'));
});

test('压缩参数：tar 只打包（-mx=0），且不给密码', () => {
  const args = createArgs({ format: formatById('tar'), level: 'extreme', password: '', archivePath: 'a.tar', names: ['x'] });
  assert.ok(args.includes('-ttar'));
  assert.ok(args.includes('-mx=0'), 'tar 不压缩');
  assert.ok(!args.some((a) => a.startsWith('-p')));
});

test('压缩参数：分卷只对支持的格式生效', () => {
  const z = createArgs({ format: formatById('zip'), level: 'normal', volumeBytes: 100 * 1024 * 1024, archivePath: 'a.zip', names: ['x'] });
  assert.ok(z.includes('-v100m'));
  const g = createArgs({ format: formatById('gzip'), level: 'normal', volumeBytes: 100 * 1024 * 1024, archivePath: 'a.gz', names: ['x'] });
  assert.ok(!g.some((a) => a.startsWith('-v')), 'gzip 不支持分卷');
});

test('压缩参数：外层复合步骤用 overrideType=tar 且 -mx=0', () => {
  const args = createArgs({ format: formatById('tar'), overrideType: 'tar', level: 'extreme', archivePath: 'inner.tar', names: ['x'] });
  assert.ok(args.includes('-ttar'));
  assert.ok(args.includes('-mx=0'));
});

test('压缩参数：缺省条目名用 "." （打整个 cwd）', () => {
  const args = createArgs({ format: formatById('zip'), level: 'normal', archivePath: 'a.zip' });
  assert.equal(args[args.length - 1], '.');
});

// —— 三、解压 / 列表参数 ——

test('解压参数：保留结构 = x，平铺 = e', () => {
  const keep = extractArgs({ archivePath: 'a.zip', outputDir: 'D:\\o' });
  assert.equal(keep[0], 'x');
  const flat = extractArgs({ archivePath: 'a.zip', outputDir: 'D:\\o', flatten: true });
  assert.equal(flat[0], 'e');
});

test('解压参数：**始终**带 -p（空密码也要）——否则 7-Zip 交互式索要密码会挂起', () => {
  const noPw = extractArgs({ archivePath: 'a.zip', outputDir: 'D:\\o' });
  assert.ok(noPw.includes('-p'), '没有密码时也要给空 -p');
  const withPw = extractArgs({ archivePath: 'a.zip', outputDir: 'D:\\o', password: 'abc' });
  assert.ok(withPw.includes('-pabc'));
});

test('解压参数：覆盖策略与 UTF-8 输出编码', () => {
  const skip = extractArgs({ archivePath: 'a.zip', outputDir: 'D:\\o', overwrite: 'skip' });
  assert.ok(skip.includes('-aos'));
  const rep = extractArgs({ archivePath: 'a.zip', outputDir: 'D:\\o', overwrite: 'replace' });
  assert.ok(rep.includes('-aoa'));
  assert.ok(skip.includes('-sccUTF-8'), '中文条目名必须靠 -sccUTF-8 才不会乱码');
  assert.ok(skip.includes('-oD:\\o'));
});

test('列表参数：l -slt -ba 且总是带 -p（含 -sccUTF-8）', () => {
  const args = listArgs({ archivePath: 'a.7z' });
  assert.ok(args.includes('l') && args.includes('-slt') && args.includes('-ba'));
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('-sccUTF-8'));
});

// —— 四、输出解析 ——

const SAMPLE_LIST = [
  '',
  '7-Zip 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-09-03',
  '',
  'Scanning the drive for archives:',
  '1 file, 488 bytes (1 KiB)',
  '',
  'Listing archive: u.zip',
  '',
  '--',
  'Path = u.zip',
  'Type = zip',
  'Physical Size = 488',
  'Headers Size = 150',
  '',
  '----------',
  'Path = src',
  'Folder = +',
  'Size = 0',
  'Packed Size = 0',
  'Modified = 2026-09-19 21:30:21.6792487',
  'Attributes = D',
  'Encrypted = -',
  'Method = Store',
  '',
  'Path = src\\a.txt',
  'Folder = -',
  'Size = 12',
  'Packed Size = 12',
  'Modified = 2026-09-19 21:30:21.6792487',
  'Encrypted = -',
  'CRC = 5E241A9F',
  'Method = Store',
  '',
  'Path = src\\中文名.txt',
  'Folder = -',
  'Size = 12',
  'Packed Size = 30',
  'Encrypted = +',
  'CRC = D4490EF8',
  'Method = AES-256 Store',
  ''
].join('\r\n');

test('splitListOutput：跳过归档头，只把条目区交给条目解析', () => {
  const { metaText, entriesText } = splitListOutput(SAMPLE_LIST);
  assert.ok(metaText.includes('Type = zip'));
  assert.ok(!metaText.includes('src\\a.txt'), '元信息块里不该有条目');
  assert.ok(entriesText.includes('src\\a.txt'));
  assert.ok(!entriesText.includes('Physical Size'), '条目块里不该有归档元信息');
});

test('parseListOutput：条目数/目录标记/中文名/加密标记全部正确', () => {
  const entries = parseListOutput(SAMPLE_LIST);
  assert.equal(entries.length, 3, '应解析出 3 个条目（归档头不能被算成条目）');
  assert.deepEqual(entries.map((e) => e.path), ['src', 'src\\a.txt', 'src\\中文名.txt']);
  assert.equal(entries[0].folder, true);
  assert.equal(entries[1].folder, false);
  assert.equal(entries[1].size, 12);
  assert.equal(entries[2].encrypted, true);
  assert.equal(entries[2].method, 'AES-256 Store');
  assert.equal(entries[2].crc, 'D4490EF8');
});

test('parseArchiveMeta：取 Type / Physical Size / Headers Size', () => {
  const meta = parseArchiveMeta(SAMPLE_LIST);
  assert.equal(meta.type, 'zip');
  assert.equal(meta.physicalSize, 488);
  assert.equal(meta.headersSize, 150);
});

test('parseListOutput：真实 7z -mhe 输出（条目无 Folder 行）也能解析', () => {
  const text = [
    '--', 'Path = e.7z', 'Type = 7z', 'Physical Size = 302', '',
    '----------',
    'Path = src\\a.txt', 'Size = 12', 'Packed Size = 48', 'Encrypted = +', 'CRC = 5E241A9F', 'Method = LZMA2:12 7zAES:19', 'Block = 0', ''
  ].join('\n');
  const entries = parseListOutput(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].folder, undefined, '缺 Folder 行时不应误判为目录');
  assert.equal(entries[0].size, 12);
});

test('parseListOutput：空输出不抛错', () => {
  assert.deepEqual(parseListOutput(''), []);
  assert.deepEqual(parseListOutput(null), []);
});

test('路径安全：识别 .. 与绝对路径（zip-slip 防护）', () => {
  const entries = [
    { path: 'good/a.txt' },
    { path: '..\\evil.txt' },
    { path: '../../etc/passwd' },
    { path: 'C:\\Windows\\system32\\x.dll' },
    { path: 'ok\\..\\still-evilt' }
  ];
  const bad = findSuspiciousEntries(entries);
  assert.equal(bad.length, 4, `应识别 4 条可疑，实际 ${bad.length}：${bad.map((b) => b.path).join(', ')}`);
  assert.ok(!bad.some((b) => b.path === 'good/a.txt'), '正常相对路径不应误报');
});

test('进度解析：从覆盖式输出里取最后一个百分比', () => {
  assert.equal(parseProgressPercent('  0%\r    \r'), 0);
  assert.equal(parseProgressPercent('  0%\r\n  0% 1\r\n 50% 2\r\n'), 50);
  assert.equal(parseProgressPercent('100%\r\n'), 100);
  assert.equal(parseProgressPercent('no percent here'), null);
  assert.equal(parseProgressPercent(''), null);
});

test('进度解析：取当前处理的条目名', () => {
  assert.equal(parseCurrentEntry('- src\\a.txt\r\n'), 'src\\a.txt');
  assert.equal(parseCurrentEntry('- src\\\r\n- src\\中文名.txt\r\n'), 'src\\中文名.txt', '应取最后一个');
  assert.equal(parseCurrentEntry('nothing'), '');
});

test('两趟解压：复合格式解出唯一 .tar 才继续', () => {
  assert.equal(findInnerTar('a.tar.gz', ['inner.tar']), 'inner.tar');
  assert.equal(findInnerTar('a.tar.xz', ['a.tar', 'readme.txt']), 'a.tar');
  assert.equal(findInnerTar('a.tar.gz', ['t1.tar', 't2.tar']), null, '多个 tar 时不猜');
  assert.equal(findInnerTar('a.tar.gz', ['src']), null, '没有 tar 时返回 null');
  assert.equal(findInnerTar('a.zip', ['x.tar']), null, '非 tar.* 格式不做第二趟');
});

test('单文件格式限制提示：多文件 / 文件夹给出可操作建议', () => {
  const multi = checkSingleEntryOnly(formatById('gzip'), 2);
  assert.equal(multi.ok, false);
  assert.ok(/TAR\.GZIP/.test(multi.message), `提示应建议 TAR.GZIP，实际：${multi.message}`);
  assert.equal(checkSingleEntryOnly(formatById('gzip'), 1).ok, true);
  assert.equal(checkSingleEntryOnly(formatById('tar.gz'), 5).ok, true, '复合格式不受单文件限制');
  assert.equal(checkSingleEntryOnly(formatById('zip'), 99).ok, true);
});

test('错误翻译：密码错误优先于通用兜底', () => {
  const m1 = translateSevenZipError({ code: 2, stderr: 'ERROR: Wrong password : a.txt' });
  assert.ok(/密码/.test(m1), m1);
  const m2 = translateSevenZipError({ code: 2, stderr: 'ERROR: e.7z : Cannot open encrypted archive. Wrong password?' });
  assert.ok(/密码/.test(m2), m2);
  const m3 = translateSevenZipError({ code: 2, stderr: 'ERROR: 系统找不到指定的文件。' });
  assert.ok(/找不到文件/.test(m3), m3);
  const m4 = translateSevenZipError({ code: 255, stderr: 'Break signaled' });
  assert.ok(m4.length > 0);
  const m5 = translateSevenZipError({ code: 0, stderr: '' });
  assert.ok(m5.length > 0, '未知情况也要有别能看的兜底文案');
});

// —— 五、计划生成（压缩） ——

test('路径工具：baseNameOf / dirNameOf / stripArchiveExt', () => {
  assert.equal(baseNameOf('C:\\a\\b\\c.txt'), 'c.txt');
  assert.equal(baseNameOf('/a/b/c.txt'), 'c.txt');
  assert.equal(dirNameOf('C:\\a\\b\\c.txt'), 'C:\\a\\b');
  assert.equal(dirNameOf('c.txt'), '');
  assert.equal(stripArchiveExt('photo.tar.gz'), 'photo');
  assert.equal(stripArchiveExt('data.zip'), 'data');
  assert.equal(stripArchiveExt('备份.7z'), '备份');
  assert.equal(stripArchiveExt('unknown.xyz'), 'unknown');
  assert.equal(stripArchiveExt('noext'), 'noext');
});

test('默认压缩包名：单文件去扩展名 / 文件夹用名 / 多个取首个', () => {
  assert.equal(suggestArchiveName([{ path: 'C:\\p\\photo.jpg', isDirectory: false }], formatById('zip')), 'photo.zip');
  assert.equal(suggestArchiveName([{ path: 'C:\\p\\相册', isDirectory: true }], formatById('7z')), '相册.7z');
  assert.equal(
    suggestArchiveName([{ path: 'C:\\p\\a.txt', isDirectory: false }, { path: 'C:\\p\\b.txt', isDirectory: false }], formatById('tar.gz')),
    'a.tar.gz'
  );
  assert.equal(suggestArchiveBase([]), '压缩包');
});

test('校验：仅解压格式（RAR）必须被拒绝并说明原因', () => {
  const r = validateCreate({ formatId: 'rar', inputs: [{ path: 'a.txt', isDirectory: false }] });
  assert.equal(r.ok, false);
  assert.ok(/只能解压/.test(r.message), r.message);
  assert.ok(/专有格式/.test(r.message), '应说明 RAR 是专有格式');
});

test('校验：单文件流式格式不能压多文件 / 文件夹', () => {
  assert.equal(validateCreate({ formatId: 'gzip', inputs: [] }).ok, false);
  assert.equal(validateCreate({ formatId: 'gzip', inputs: [{ path: 'a', isDirectory: false }, { path: 'b', isDirectory: false }] }).ok, false);
  assert.equal(validateCreate({ formatId: 'br', inputs: [{ path: 'd', isDirectory: true }] }).ok, false);
  assert.equal(validateCreate({ formatId: 'gzip', inputs: [{ path: 'a', isDirectory: false }] }).ok, true);
  assert.equal(validateCreate({ formatId: 'tar.gz', inputs: [{ path: 'd', isDirectory: true }] }).ok, true);
});

test('校验：给不支持的格式设密码要报错（gzip 不能加密）', () => {
  const r = validateCreate({ formatId: 'gzip', inputs: [{ path: 'a.txt', isDirectory: false }], password: 'x' });
  assert.equal(r.ok, false);
  assert.ok(/不支持密码/.test(r.message), r.message);
  assert.equal(validateCreate({ formatId: 'zip', inputs: [{ path: 'a.txt', isDirectory: false }], password: 'x' }).ok, true);
  assert.equal(validateCreate({ formatId: '7z', inputs: [{ path: 'a.txt', isDirectory: false }], password: 'x' }).ok, true);
});

test('计划：单容器格式一步到位，cwd 按来源目录分组', () => {
  const plan = buildCreatePlan({
    inputs: [{ path: 'C:\\p\\a.txt', isDirectory: false }, { path: 'C:\\p\\b.txt', isDirectory: false }],
    formatId: 'zip', level: 'normal', outputDir: 'C:\\out', baseName: 'pack'
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.archivePath, 'C:\\out\\pack.zip');
  assert.equal(plan.steps.length, 1, '同一目录只应产生一步');
  assert.deepEqual(plan.steps[0].names, ['a.txt', 'b.txt']);
  assert.equal(plan.steps[0].cwd, 'C:\\p');
  assert.equal(plan.steps[0].kind, '7z');
});

test('计划：不给输出目录时产物落在源文件旁边，且必须是绝对路径', () => {
  const plan = buildCreatePlan({
    inputs: [{ path: 'C:\\p\\a.txt', isDirectory: false }], formatId: 'zip', baseName: 'a'
  });
  assert.equal(plan.archivePath, 'C:\\p\\a.zip',
    '7-Zip 的 cwd 是来源目录，相对路径会写错地方并导致「找不到产物」');
  assert.ok(/^[A-Za-z]:/.test(plan.archivePath), '必须是绝对路径');
});

test('计划：不同来源目录 → 多步（7-Zip 的 cwd 只能一个）', () => {
  const plan = buildCreatePlan({
    inputs: [{ path: 'C:\\p\\a.txt', isDirectory: false }, { path: 'D:\\q\\b.txt', isDirectory: false }],
    formatId: 'zip', outputDir: 'C:\\out', baseName: 'pack'
  });
  assert.equal(plan.groupedDirs, 2);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].cwd, 'C:\\p');
  assert.equal(plan.steps[1].cwd, 'D:\\q');
});

test('计划：文件夹输入用其父目录做 cwd、名字进 names（保证包内有顶层文件夹）', () => {
  const plan = buildCreatePlan({
    inputs: [{ path: 'C:\\p\\相册', isDirectory: true }],
    formatId: '7z', outputDir: 'C:\\out', baseName: '相册'
  });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].cwd, 'C:\\p');
  assert.deepEqual(plan.steps[0].names, ['相册']);
  assert.equal(plan.archivePath, 'C:\\out\\相册.7z');
});

test('计划：复合格式（tar.gz）拆两步——先 tar（放临时目录）再压外层', () => {
  const plan = buildCreatePlan({
    inputs: [{ path: 'C:\\p\\a.txt', isDirectory: false }],
    formatId: 'tar.gz', level: 'small', outputDir: 'C:\\out', baseName: 'pack', tempDir: 'C:\\tmp'
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].overrideType, 'tar', '第一步必须 overrideType=tar');
  assert.equal(plan.steps[0].target, 'C:\\tmp\\pack.tar', '中间 tar 放临时目录，不污染输出目录');
  assert.equal(plan.steps[0].level, 'store');
  assert.equal(plan.steps[1].action, 'compress');
  assert.equal(plan.steps[1].engine, 'gzip');
  assert.equal(plan.steps[1].kind, '7z', 'gzip 外层走 7-Zip');
  assert.equal(plan.steps[1].target, 'C:\\out\\pack.tar.gz');
  assert.equal(plan.steps[1].name, 'pack.tar', '外层压缩要用文件名而不是全路径');
  assert.equal(plan.innerTar, 'C:\\tmp\\pack.tar');
});

test('计划：tar.zst / tar.br 的外层走 Node 内置 zlib（不依赖 7-Zip）', () => {
  for (const [id, engine] of [['tar.zst', 'zst'], ['tar.br', 'br']]) {
    const plan = buildCreatePlan({
      inputs: [{ path: 'C:\\p\\a.txt', isDirectory: false }],
      formatId: id, outputDir: 'C:\\out', baseName: 'pack', tempDir: 'C:\\tmp'
    });
    assert.equal(plan.steps.length, 2, id);
    assert.equal(plan.steps[1].kind, 'node', `${id} 外层应走 Node`);
    assert.equal(plan.steps[1].engine, engine);
  }
});

test('计划：zst / br 单文件格式一步走 Node', () => {
  for (const [id, engine] of [['zst', 'zst'], ['br', 'br']]) {
    const plan = buildCreatePlan({
      inputs: [{ path: 'C:\\p\\a.bin', isDirectory: false }],
      formatId: id, outputDir: 'C:\\out', baseName: 'a'
    });
    assert.equal(plan.steps.length, 1, id);
    assert.equal(plan.steps[0].kind, 'node');
    assert.equal(plan.steps[0].action, 'create');
    assert.equal(plan.steps[0].target, `C:\\out\\a.${id}`);
  }
});

test('计划：分卷只对支持格式生效，其余静默降为不分卷', () => {
  const z = buildCreatePlan({
    inputs: [{ path: 'C:\\p\\a.txt', isDirectory: false }],
    formatId: 'zip', volumeBytes: 1024 * 1024, outputDir: 'C:\\out', baseName: 'p'
  });
  assert.equal(z.steps[0].volumeBytes, 1024 * 1024);
  const g = buildCreatePlan({
    inputs: [{ path: 'C:\\p\\a.txt', isDirectory: false }],
    formatId: 'gzip', volumeBytes: 1024 * 1024, outputDir: 'C:\\out', baseName: 'p'
  });
  assert.equal(g.steps[0].volumeBytes, 0, 'gzip 不支持分卷，应降为 0');
});

test('计划：校验不过时返回 ok:false 且不产步骤', () => {
  const r = buildCreatePlan({ inputs: [], formatId: 'zip', outputDir: 'C:\\out' });
  assert.equal(r.ok, false);
  assert.ok(!r.steps);
});

// —— 六、计划生成（解压） ——

test('解压校验：空列表拒绝', () => {
  assert.equal(validateExtract({ archives: [] }).ok, false);
  assert.equal(validateExtract({ archives: [{ path: 'a.zip' }] }).ok, true);
  const long = validateExtract({ archives: [{ path: 'a.zip' }], password: 'x'.repeat(201) });
  assert.equal(long.ok, false);
  assert.ok(/密码过长/.test(long.message));
});

test('解压计划：输出目录默认在压缩包旁边、名为压缩包名（去后缀）', () => {
  const plan = buildExtractPlan({ archives: [{ path: 'D:\\data\\photo.zip' }] });
  assert.equal(plan.ok, true);
  assert.equal(plan.steps[0].outputDir, 'D:\\data\\photo');
  assert.equal(plan.steps[0].action, 'extract');
  assert.equal(plan.steps[0].flatten, false);
});

test('解压计划：复合格式目录名整体去后缀（photo.tar.gz → photo）', () => {
  const plan = buildExtractPlan({ archives: [{ path: 'D:\\data\\photo.tar.gz' }] });
  assert.equal(plan.steps[0].outputDir, 'D:\\data\\photo');
});

test('解压计划：指定输出目录时在其下建同名子目录', () => {
  const plan = buildExtractPlan({ archives: [{ path: 'D:\\data\\photo.zip' }], outputDir: 'E:\\out' });
  assert.equal(plan.steps[0].outputDir, 'E:\\out\\photo');
});

test('解压计划：平铺模式下 flatten=true（对应 7-Zip 的 e 命令）', () => {
  const plan = buildExtractPlan({ archives: [{ path: 'D:\\data\\photo.zip' }], tree: 'flatten' });
  assert.equal(plan.steps[0].flatten, true);
});

test('解压计划：覆盖策略透传', () => {
  assert.equal(buildExtractPlan({ archives: [{ path: 'a.zip' }], overwrite: 'replace' }).steps[0].overwrite, 'replace');
  assert.equal(buildExtractPlan({ archives: [{ path: 'a.zip' }], overwrite: 'skip' }).steps[0].overwrite, 'skip');
});

test('解压计划：仅解压格式标注 note（界面要如实提示）', () => {
  const plan = buildExtractPlan({ archives: [{ path: 'D:\\data\\x.rar' }] });
  assert.ok(/仅解压/.test(plan.steps[0].note), plan.steps[0].note);
  const plan2 = buildExtractPlan({ archives: [{ path: 'D:\\data\\x.zip' }] });
  assert.equal(plan2.steps[0].note, '');
});

test('解压计划：多个压缩包各生成一步', () => {
  const plan = buildExtractPlan({ archives: [{ path: 'D:\\a.zip' }, { path: 'D:\\b.7z' }] });
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1].outputDir, 'D:\\b');
});

test('解压计划：密码透传到每一步', () => {
  const plan = buildExtractPlan({ archives: [{ path: 'a.7z' }, { path: 'b.zip' }], password: 'pw' });
  assert.equal(plan.steps[0].password, 'pw');
  assert.equal(plan.steps[1].password, 'pw');
});

// —— 七、展示文案 ——

test('humanBytes：三档单位', () => {
  assert.equal(humanBytes(512), '512 B');
  assert.equal(humanBytes(2048), '2 KB');
  assert.equal(humanBytes(5 * 1024 * 1024), '5.00 MB');
  assert.equal(humanBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
});

test('ratioText：压小为负、变大为正、无输入为空', () => {
  assert.equal(ratioText(1000, 400), '-60%');
  assert.equal(ratioText(1000, 1200), '+20%');
  assert.equal(ratioText(0, 100), '');
});

// —— 八、失败清理（cleanupFailedOutput）：绝不能碰用户原有的东西 ——
// 回归钉子：tar.zst / tar.br 的第二趟解压失败时曾传入空快照，导致「已存在的输出目录」被整个删光。

/** 建一个真实临时目录，返回 { dir, cleanup }；fill 为「用户原本就有的内容」 */
async function makeTempOutput(fill) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-archive-test-'));
  const dir = path.join(root, 'out');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, kind] of Object.entries(fill)) {
    if (kind === 'dir') {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, '里面.txt'), '用户原有的子目录内容');
    } else {
      fs.writeFileSync(path.join(dir, name), '用户原有的文件');
    }
  }
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('失败清理：目录原本不存在 → 整个删掉，不留垃圾', async () => {
  const { root, dir, cleanup } = await makeTempOutput({});
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '半成品.txt'), 'x');
    await cleanupFailedOutput(dir, false, new Set());
    assert.equal(fs.existsSync(dir), false, '目录本来不存在时应被整个删掉');
  } finally { cleanup(); }
});

test('失败清理：目录原本存在 → 只删本次新增的顶层项', async () => {
  const { dir, cleanup } = await makeTempOutput({ '原有.txt': 'file', '原有文件夹': 'dir' });
  try {
    const namesBefore = new Set(fs.readdirSync(dir));
    fs.writeFileSync(path.join(dir, '半成品.txt'), 'x');
    fs.mkdirSync(path.join(dir, '半成品夹'), { recursive: true });
    await cleanupFailedOutput(dir, true, namesBefore);
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, ['原有.txt', '原有文件夹'].sort(), `应只剩原有内容，实际：${left.join(',')}`);
    assert.ok(fs.existsSync(path.join(dir, '原有文件夹', '里面.txt')), '原有子目录的内容不应被动到');
  } finally { cleanup(); }
});

test('失败清理：目录原本存在却没给快照 → 一个都不删（宁可留半成品）', async () => {
  const { dir, cleanup } = await makeTempOutput({ '原有.txt': 'file', '原有文件夹': 'dir' });
  try {
    fs.writeFileSync(path.join(dir, '半成品.txt'), 'x');
    // 注意：空 Set 不在此列——那是「目录原本就是空的」的合法快照，此时删掉半成品才对。
    for (const bad of [undefined, null]) {
      await cleanupFailedOutput(dir, true, bad);
      assert.ok(fs.existsSync(path.join(dir, '原有.txt')), `快照缺失（${String(bad)}）时不得删用户原有文件`);
      assert.ok(fs.existsSync(path.join(dir, '原有文件夹', '里面.txt')), '快照缺失时不得删用户原有子目录');
    }
  } finally { cleanup(); }
});

// —— 汇总 ——

await Promise.all(pending);
console.log(results.join('\n'));
console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
if (fail > 0) process.exit(1);