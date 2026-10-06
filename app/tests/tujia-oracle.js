// 互通验证的「裁判」：直接跑原版实现（tj.qdqqd.com 的 decryptWorker.js）
//
// 为什么这样做：「文件藏图」的验收核心是**双向互通**，光靠自家往返只能证明自洽。
// 把原版那份**未混淆的明文 worker**（人工从 https://tj.qdqqd.com/decryptWorker.js 取回）
// 放在 `.tools/tujia-oracle/decryptWorker.js` 当裁判，才能证明：
//   ① 我们打的图，原版能解（→ 网站/APP/同族工具也能解）；
//   ② 原版打的图，我们能解。
//
// 纪律：
//   · 该文件是**对方的代码**，只作本机验证用 —— 放在 `.tools/`（.gitignore 已忽略）：不进 git、不随包分发。
//   · 文件缺失时本模块如实返回「不可用」，调用方跳过互通断言并标注，绝不因此让整轮自检变红。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 原版 worker 的存放位置（仓库根的 .tools 下） */
function oracleFile(appDir) {
  return path.join(appDir, '..', '.tools', 'tujia-oracle', 'decryptWorker.js');
}

let cached = null;

/**
 * 加载原版实现（进程内只加载一次）
 * @param {string} appDir app 目录（__dirname/.. 之类）
 * @returns {{ok: true, core: object, file: string} | {ok: false, reason: string}}
 */
function loadOracle(appDir) {
  if (cached) return cached;
  const file = oracleFile(appDir);
  if (!fs.existsSync(file)) {
    cached = { ok: false, reason: `未放原版实现（放到 ${file} 后可开启互通验证）` };
    return cached;
  }
  const src = fs.readFileSync(file, 'utf8');
  // 原版 worker 是给浏览器 Worker 用的脚本：脚本顶部有 `self.onmessage = ...`，
  // 且自带的 fflate 是 UMD 结尾（`(typeof self!=='undefined'?self:this).fflate = f()`）。
  // 所以 self 垫片必须指向 globalThis 本身：既让 self.onmessage 可赋值，也让 fflate 落到全局，
  // 否则脚本里的裸标识符 `fflate` 找不到（实测过：垫成空对象会报 fflate is not defined）。
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  try {
    const factory = new Function(`${src}\n;return SteganographyCore;`);
    const SteganographyCore = factory();
    cached = { ok: true, core: new SteganographyCore(), file };
  } catch (err) {
    cached = { ok: false, reason: `加载原版实现失败：${err.message}` };
  }
  return cached;
}

function requireOracle(appDir) {
  const loaded = loadOracle(appDir);
  if (!loaded.ok) throw new Error(loaded.reason);
  return loaded.core;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}

/** 用原版实现解一张图夹图（含密码）→ [{name, bytes}] */
async function oracleExtractFiles(appDir, bytes, password = '') {
  const core = requireOracle(appDir);
  const data = toBytes(bytes);
  const isGif = data.length >= 6 && String.fromCharCode(...data.subarray(0, 3)) === 'GIF';
  const hidden = isGif ? await core.extractDataFromGIF(data) : await core.extractDataFromPNG(data);
  const files = await core.parseExtractedData(hidden, password);
  return files.map((f) => ({ name: f.name, bytes: toBytes(f.data) }));
}

/** 用原版实现打一张 PNG 图夹（canvas 用 {width,height,data} 垫片即可，原版只取这三个字段） */
async function oracleEmbedPng(appDir, { width, height, rgba, payload }) {
  const core = requireOracle(appDir);
  return toBytes(await core.embedDataInPNG({ width, height, data: toBytes(rgba) }, toBytes(payload)));
}

/** 用原版实现打一张 GIF 图夹（原字节尾部追加扩展块） */
async function oracleEmbedGif(appDir, { gifBytes, payload }) {
  const core = requireOracle(appDir);
  return toBytes(await core.embedDataInGIF(toBytes(gifBytes), toBytes(payload)));
}

/**
 * 用原版实现走「动态混淆（极速）」那条路解一份**整文件字节**
 * （原版客户端就是这么干的：把整个文件丢给 action='decrypt'，它先在文件里找 16 字节 PRO 指纹，
 *  没找到才按 DYNAMIC_V2_ 分隔符格式解析 —— 所以这个函数同时验证了「不带指纹、不弹密码框」）
 */
function oracleLegacyDecrypt(appDir, bytes) {
  loadOracle(appDir);
  const selfObj = globalThis.self;
  const previous = selfObj.postMessage;
  return new Promise((resolve, reject) => {
    let settled = false;
    const restore = () => { selfObj.postMessage = previous; };
    selfObj.postMessage = (msg) => {
      if (settled) return;
      if (msg && msg.type === 'done') {
        settled = true;
        restore();
        resolve((msg.files || []).map((f) => ({ name: f.name, bytes: toBytes(f.data) })));
      } else if (msg && msg.type === 'error') {
        settled = true;
        restore();
        reject(new Error(msg.error || '未知错误'));
      }
    };
    try {
      selfObj.onmessage({ data: { taskId: 'oracle-legacy', action: 'decrypt', payload: { encryptedData: toBytes(bytes) } } });
    } catch (err) {
      settled = true;
      restore();
      reject(err);
    }
  });
}

/** 用原版实现加密载荷（验证我们的解密能读原版密文） */
async function oracleEncrypt(appDir, payload, password) {
  const core = requireOracle(appDir);
  return toBytes(await core.encryptData(toBytes(payload), password));
}

module.exports = { loadOracle, oracleExtractFiles, oracleLegacyDecrypt, oracleEmbedPng, oracleEmbedGif, oracleEncrypt, oracleFile };