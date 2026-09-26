// 视频下载 · 纯逻辑单测（Node 直接跑，无需 Electron / 无需联网；挂 npm test）
// 覆盖：URL 提取与站点识别、文件名净化、速度/剩余时间格式、yt-dlp 行解析、错误分类、
//       B站参数、央视频解析、引擎安装/读取与「校验不过必须拒绝」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  extractUrl, safeFileName, formatSpeed, formatEta, isDouyinUrl, isYouTubeUrl,
  isXiaohongshuUrl, extractDouyinVideoId, parseYtdlpLine,
} from '../src/tools/videodl/core/pure.mjs';
import { describeDownloadError } from '../src/tools/videodl/core/errors.mjs';
import { isBilibiliUrl, attemptArgs, isConnectionFailure } from '../src/tools/videodl/core/bilibili.mjs';
import { isYangshipinUrl, normalizeUrl, makeCKey, parsePage, parsePlayback } from '../src/tools/videodl/core/yangshipin.mjs';
import { checkLatestEngine, downloadEngine, installEngine, readInstalledEngine, sha256File } from '../src/tools/videodl/core/engine-update.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass += 1; console.log(`  ✓ ${name}`); })
    .catch((err) => { fail += 1; failures.push({ name, message: err.message }); console.log(`  ✗ ${name}\n      ${err.message}`); });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'videodl-test-'));
console.log('视频下载 · 纯逻辑单测');

// —— 1) URL 提取与站点识别 ——
await test('extractUrl：从各种粘贴文本里抠链接', () => {
  assert.equal(extractUrl('https://www.bilibili.com/video/BV1xx411c7mD'), 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(extractUrl('看看这个 https://v.douyin.com/abc123/ 很有意思'), 'https://v.douyin.com/abc123/');
  assert.equal(extractUrl('https://youtu.be/abc，'), 'https://youtu.be/abc');
  assert.equal(extractUrl('（https://v.douyin.com/x）'), 'https://v.douyin.com/x');
  assert.equal(extractUrl('没有链接'), '');
  assert.equal(extractUrl(''), '');
});
await test('站点识别：抖音 / YouTube / 小红书 / B站 / 央视频（含拒识别的坑）', () => {
  assert.equal(isDouyinUrl('https://www.douyin.com/video/123'), true);
  assert.equal(isDouyinUrl('https://v.douyin.com/abc/'), true);
  assert.equal(isDouyinUrl('https://www.iesdouyin.com/share/video/1/'), true);
  assert.equal(isDouyinUrl('https://notdouyin.com/video/1'), false);
  assert.equal(isYouTubeUrl('https://youtu.be/x'), true);
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=x'), true);
  assert.equal(isYouTubeUrl('https://notyoutube.com/watch'), false);
  assert.equal(isXiaohongshuUrl('https://xhslink.com/a1b2'), true);
  assert.equal(isXiaohongshuUrl('https://www.xiaohongshu.com/explore/x'), true);
  assert.equal(isBilibiliUrl('https://www.bilibili.com/video/BV1x'), true);
  assert.equal(isBilibiliUrl('https://b23.tv/abc'), true);
  assert.equal(isBilibiliUrl('https://bilibili.com.evil.com/video'), false);
  assert.equal(isYangshipinUrl('https://w.yangshipin.cn/video?cid=abc12345'), true);
  assert.equal(isYangshipinUrl('https://www.youtube.com/watch'), false);
});
await test('extractDouyinVideoId：路径 / modal_id / 无', () => {
  assert.equal(extractDouyinVideoId('https://www.douyin.com/video/7412345678901234567'), '7412345678901234567');
  assert.equal(extractDouyinVideoId('https://www.douyin.com/?modal_id=7412345678901234567'), '7412345678901234567');
  assert.equal(extractDouyinVideoId('https://v.douyin.com/abc/'), '');
});

// —— 2) 文件名净化 / 速度 / 剩余时间 ——
await test('safeFileName：非法字符、尾点、长度、空值兜底', () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(safeFileName('  标题  '), '标题');
  assert.equal(safeFileName('标题...'), '标题');
  assert.equal(safeFileName(''), '抖音视频');
  assert.equal(safeFileName(null), '抖音视频');
  assert.equal(safeFileName('长'.repeat(200)).length, 80);
});
await test('formatSpeed / formatEta', () => {
  assert.equal(formatSpeed(2 * 1024 * 1024), '2.0MiB/s');
  assert.equal(formatSpeed(512 * 1024), '512KiB/s');
  assert.equal(formatSpeed(0), '');
  assert.equal(formatSpeed(-5), '');
  assert.equal(formatEta(65), '01:05');
  assert.equal(formatEta(5), '00:05');
  assert.equal(formatEta(-1), '');
  assert.equal(formatEta(NaN), '');
});

// —— 3) yt-dlp 输出行解析 ——
await test('parseYtdlpLine：Destination / Merger / 进度 / 完成文件 / 已下载过', () => {
  assert.deepEqual(parseYtdlpLine('随便一行'), {});
  const video = parseYtdlpLine('[download] Destination: D:\\视频\\标题 [abc].f137.mp4');
  assert.equal(video.name, '标题 [abc].f137.mp4');
  assert.equal(video.phase, '下载视频轨');
  const audio = parseYtdlpLine('[download] Destination: D:\\视频\\标题 [abc].f140.m4a');
  assert.equal(audio.phase, '下载音频轨');
  const merger = parseYtdlpLine('[Merger] Merging formats into "D:\\视频\\标题 [abc].mp4"');
  assert.equal(merger.merging, true);
  assert.equal(merger.phase, '合并音视频');
  const pct = parseYtdlpLine('[download]  42.3% of 10.00MiB at 1.20MiB/s ETA 00:05');
  assert.equal(pct.pct, 42.3);
  assert.equal(pct.speed, '1.20MiB/s');
  assert.equal(pct.eta, '00:05');
  const fin = parseYtdlpLine('__FINAL_FILE__D:\\视频\\标题 [abc].mp4');
  assert.equal(fin.file, 'D:\\视频\\标题 [abc].mp4');
  const dup = parseYtdlpLine('[download] D:\\x.mp4 has already been downloaded');
  assert.equal(dup.pct, 100);
  assert.equal(dup.note, '此前已下载过');
});

// —— 4) 错误分类 ——
await test('describeDownloadError：分类命中与原文兜底', () => {
  assert.match(describeDownloadError('ERROR: Unsupported URL: https://x'), /无法解析这个网页/);
  assert.match(describeDownloadError('HTTP Error 404: Not Found'), /不存在|已下架/);
  assert.match(describeDownloadError('HTTP Error 429'), /限制了请求频率/);
  assert.match(describeDownloadError('login required'), /要求登录/);
  assert.match(describeDownloadError('read ECONNRESET'), /read ECONNRESET/); // 未命中分类：原样返回
});

// —— 5) B站参数 ——
await test('attemptArgs：首轮带代理、重试清代理、挂插件目录', () => {
  const first = attemptArgs('C:\\app\\plugins', 'http://127.0.0.1:7897', 1);
  assert.ok(first.includes('--plugin-dirs') && first.includes('C:\\app\\plugins'));
  assert.ok(first.includes('--no-plugin-dirs'));
  assert.equal(first[first.indexOf('--proxy') + 1], 'http://127.0.0.1:7897');
  const retry = attemptArgs('C:\\app\\plugins', 'http://127.0.0.1:7897', 2);
  assert.equal(retry[retry.indexOf('--proxy') + 1], ''); // 重试切直连
  assert.equal(isConnectionFailure('Unable to download video data: HTTP Error 403'), true);
  assert.equal(isConnectionFailure('Unsupported URL'), false);
});

// —— 6) 央视频解析 ——
await test('normalizeUrl：只认官方点播分享链接', () => {
  const page = normalizeUrl('https://m.yangshipin.cn/video?cid=abcdefgh12345678&type=0');
  assert.equal(page.hostname, 'w.yangshipin.cn');
  assert.equal(page.searchParams.get('cid'), 'abcdefgh12345678');
  assert.throws(() => normalizeUrl('https://w.yangshipin.cn/video?vid=short'), /缺少有效的视频编号/);
  assert.throws(() => normalizeUrl('https://www.yangshipin.cn/live?cid=abcdefgh12345678'), /点播/);
  assert.throws(() => normalizeUrl('https://user:pw@w.yangshipin.cn/video?cid=abcdefgh12345678'), /官方分享链接/);
});
await test('parsePage / parsePlayback：从页面与播放信息里取到地址和校验值', () => {
  const html = '<script>window.__STATE_video__ = {"payloads":{"sharevideo":{"vid":"abcdefgh12345678","title":"测试视频"}}}</script>';
  const meta = parsePage(html, '');
  assert.equal(meta.id, 'abcdefgh12345678');
  assert.equal(meta.title, '测试视频');
  assert.throws(() => parsePage('<script>window.__STATE_other__ = {}</script>'), /没有返回视频信息/);
  const info = {
    vl: { vi: [{ vid: 'abcdefgh12345678', td: 30, fn: 'abcdefgh12345678.p2p.mp4', fs: 12345,
      fmd5: 'a'.repeat(32), fvkey: 'KEY123', vw: 1920, vh: 1080, ul: { ui: [{ url: 'https://vhot1.ysp.cctv.cn/' }] } }] },
    fl: { fi: [{ sl: 1, lmt: 0 }] },
    dltype: 1, preview: 0,
  };
  const playback = parsePlayback(JSON.stringify(info), meta, 'https://w.yangshipin.cn/video?cid=abcdefgh12345678', 'GUID1');
  assert.equal(playback.size, 12345);
  assert.equal(playback.md5, 'a'.repeat(32));
  assert.equal(playback.height, 1080);
  assert.ok(playback.url.startsWith('https://vhot1.ysp.cctv.cn/abcdefgh12345678.p2p.mp4?'));
  // DRM/试看 → 明确拒绝
  const drm = JSON.parse(JSON.stringify(info));
  drm.vl.vi[0].drm = 1;
  assert.throws(() => parsePlayback(JSON.stringify(drm), meta, 'https://w.yangshipin.cn/video', 'G'), /试看|受保护/);
  // 非官方视频地址 → 拒绝
  const bad = JSON.parse(JSON.stringify(info));
  bad.vl.vi[0].ul.ui[0].url = 'https://evil.example.com/';
  assert.throws(() => parsePlayback(JSON.stringify(bad), meta, 'https://w.yangshipin.cn/video', 'G'), /非官方/);
});
await test('makeCKey：稳定格式（--01 + 十六进制）', () => {
  const key = makeCKey('abcdefgh12345678', '1700000000', 'abcdef0123456789abcdef0123456789', 'https://w.yangshipin.cn/video');
  assert.match(key, /^--01[0-9A-F]+$/);
  assert.equal(key, makeCKey('abcdefgh12345678', '1700000000', 'abcdef0123456789abcdef0123456789', 'https://w.yangshipin.cn/video'));
});

// —— 7) 引擎：检查（digest 必需）、下载校验、安装/读取 ——
await test('checkLatestEngine：没有官方 digest 一律拒绝', async () => {
  const mk = (assets) => async () => ({ ok: true, status: 200, json: async () => ({ tag_name: '2026.01.01', assets }) });
  await assert.rejects(
    checkLatestEngine({ fetchImpl: mk([{ name: 'yt-dlp.exe', browser_download_url: 'https://x/yt-dlp.exe' }]) }),
    /缺少 sha256 校验值/);
  const ok = await checkLatestEngine({ fetchImpl: mk([{ name: 'yt-dlp.exe', browser_download_url: 'https://x/yt-dlp.exe', digest: 'sha256:' + 'b'.repeat(64) }]) });
  assert.equal(ok.sha256, 'b'.repeat(64));
  assert.equal(ok.version, '2026.01.01');
});
await test('downloadEngine：指纹不符必须丢弃；相符才落盘', async () => {
  const hasCurl = spawnSync('where', ['curl.exe'], { windowsHide: true }).status === 0;
  if (!hasCurl) { console.log('    （本机无 curl.exe，跳过下载校验用例）'); return; }
  const src = path.join(tmpRoot, 'engine-src.bin');
  fs.writeFileSync(src, Buffer.from('fake-engine-bytes'));
  const url = 'file:///' + src.replace(/\\/g, '/');
  const good = sha256File(src);
  const dest = path.join(tmpRoot, 'engine-good.exe');
  await downloadEngine({ url, sha256: good, destFile: dest });
  assert.equal(sha256File(dest), good);
  const badDest = path.join(tmpRoot, 'engine-bad.exe');
  await assert.rejects(downloadEngine({ url, sha256: 'c'.repeat(64), destFile: badDest }), /校验不通过/);
  assert.equal(fs.existsSync(badDest), false);
  assert.equal(fs.existsSync(badDest + '.part'), false); // 坏包连半成品都不留
});
await test('installEngine / readInstalledEngine：安装可读回，文件被改动即视为无效', () => {
  const engineDir = path.join(tmpRoot, 'engine-dir');
  const src = path.join(tmpRoot, 'install-src.exe');
  fs.writeFileSync(src, Buffer.from('engine-v2'));
  const sha = sha256File(src);
  const installed = installEngine({ srcFile: src, engineDir, version: '2026.02.02', sha256: sha });
  assert.equal(installed.version, '2026.02.02');
  const read = readInstalledEngine(engineDir);
  assert.equal(read.version, '2026.02.02');
  assert.equal(read.sha256, sha);
  // 篡改：manifest 还在，但文件内容变了 → 视为没有（不信任本地文件）
  fs.writeFileSync(read.path, Buffer.from('tampered'));
  assert.equal(readInstalledEngine(engineDir), null);
});

// —— 收尾 ——
try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 临时目录留给系统清 */ }

console.log(`\n视频下载 · 纯逻辑单测：通过 ${pass} / 共 ${pass + fail}${fail ? `（失败 ${fail}）` : ''}`);
for (const f of failures) console.log(`  ✗ ${f.name}：${f.message}`);
process.exit(fail === 0 ? 0 : 1);
