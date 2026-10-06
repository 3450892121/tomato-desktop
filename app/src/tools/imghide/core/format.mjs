// 「文件藏图」的容器格式（原版「图夹」V6）——纯逻辑：无 DOM、无 Node 专属依赖，
// 渲染进程（ui.js）、主进程（core/engine.mjs 动态 import）与测试共用。
// 规格与格式证据：spec/modules/imghide.md（含原版 decryptWorker.js 的对应函数名）。
//
// 格式速览（与原版逐字节一致，互通的前提）：
//   载荷      uint32 文件数 + 每文件 [uint32 名字长度 + UTF-8 名字 + uint64 大小 + 原始字节]（大端、不压缩）
//   GIF 载体  原字节零改动，尾部追加 21 FF 0B + 'STEGDATA V6' + 数据子块 + 指纹注释块；载荷前带 4 字节长度前缀
//   PNG 载体  载荷拼到 IDAT 解压流（扫描线数据）尾部，整体重压为单个 IDAT，并在 IEND 前插 iTXt 指纹块
//   密码      PBKDF2-SHA256(盐 'xcn2025', 10 万轮) → AES-256-GCM（12 字节 IV 前置、16 字节 tag 尾随）

/** 魔数 'STEGDATA V6'（原版常量名 STEG_DATA_V6） */
export const MAGIC = new Uint8Array([0x53, 0x54, 0x45, 0x47, 0x44, 0x41, 0x54, 0x41, 0x20, 0x56, 0x36]);
/** 魔数前的 3 字节（在 GIF 里即应用扩展块头 21 FF 0B） */
export const MAGIC_PREFIX = new Uint8Array([0x21, 0xff, 0x0b]);
/** 原版写在文件里的指纹（GIF 注释扩展 / PNG iTXt 的文本） */
export const FINGERPRINT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 原版写死的 PBKDF2 盐（互通必须一致） */
export const PASSWORD_SALT_TEXT = 'xcn2025';

/** GIF 子块最大 255 字节（原版分块步长） */
const GIF_BLOCK_MAX = 255;
/** 从文件尾反向扫描时容忍的候选块个数（原版 maxAppExtCount） */
const GIF_SCAN_CANDIDATES = 20;
/** 单个条目名长度上限（防御畸形载荷） */
const MAX_NAME_LENGTH = 4096;
/** 文件条目数上限（原版同样限制 10000） */
const MAX_FILE_COUNT = 10000;
/** 未命名条目的兜底名 */
export const UNNAMED = '未命名文件';

export function concatBytes(list) {
  let total = 0;
  for (const part of list) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of list) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// —— CRC32（PNG 分块用；表与原版/Node 的 crc32 一致） ——

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  return crc32Of([bytes]);
}

/** 分片计算 CRC32（避免为拼接数据额外复制一份大缓冲） */
export function crc32Of(parts) {
  let c = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) c = CRC_TABLE[(c ^ part[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 4 字节大端写入 */
function u32be(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

// —— 载荷（文件表） ——

/**
 * 生成载荷字节（原版 streamPrepareEmbedData 的输出；加密由 crypto 层另做）
 * @param {{name: string, bytes: Uint8Array}[]} files
 * @returns {Uint8Array}
 */
export function buildPayload(files) {
  const encoder = new TextEncoder();
  const entries = files.map((file) => {
    const nameBytes = encoder.encode(String(file.name || UNNAMED));
    return { nameBytes, bytes: file.bytes };
  });
  let total = 4;
  for (const entry of entries) total += 4 + entry.nameBytes.length + 8 + entry.bytes.length;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, entries.length, false);
  offset += 4;
  for (const entry of entries) {
    view.setUint32(offset, entry.nameBytes.length, false);
    offset += 4;
    out.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
    view.setBigUint64(offset, BigInt(entry.bytes.length), false);
    offset += 8;
    out.set(entry.bytes, offset);
    offset += entry.bytes.length;
  }
  return out;
}

/**
 * 解析载荷（原版 parseExtractedData 的结构部分）；数据不完整时给可读错误
 * @param {Uint8Array} bytes
 * @returns {{name: string, bytes: Uint8Array}[]}
 */
export function parsePayload(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4) throw new Error('图夹数据不完整');
  const count = view.getUint32(0, false);
  if (count === 0 || count > MAX_FILE_COUNT) throw new Error(`文件数量异常（${count}）`);
  let offset = 4;
  const files = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 4 > bytes.length) throw new Error('图夹数据不完整');
    const nameLength = view.getUint32(offset, false);
    offset += 4;
    if (nameLength > MAX_NAME_LENGTH || offset + nameLength > bytes.length) throw new Error('图夹数据不完整');
    const name = new TextDecoder('utf-8').decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    if (offset + 8 > bytes.length) throw new Error('图夹数据不完整');
    const size = Number(view.getBigUint64(offset, false));
    offset += 8;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length) throw new Error('图夹数据不完整');
    files.push({ name, bytes: bytes.subarray(offset, offset + size) });
    offset += size;
  }
  return files;
}

// —— 载体识别 ——

/** @returns {'gif'|'png'|'other'} */
export function detectCoverKind(bytes) {
  if (bytes.length >= 6) {
    const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'png';
  return 'other';
}

// —— GIF 载体 ——

/**
 * 把载荷追加进 GIF（原版 streamEmbedDataInGIF 的等价实现）
 * @param {Uint8Array} gifBytes 原 GIF 字节（动图同样适用）
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
export function embedPayloadInGif(gifBytes, payload) {
  if (detectCoverKind(gifBytes) !== 'gif') throw new Error('不是有效的 GIF 文件');
  const withHeader = new Uint8Array(4 + payload.length);
  new DataView(withHeader.buffer).setUint32(0, payload.length, false);
  withHeader.set(payload, 4);

  const parts = [gifBytes, MAGIC_PREFIX, MAGIC];
  for (let i = 0; i < withHeader.length; i += GIF_BLOCK_MAX) {
    const size = Math.min(GIF_BLOCK_MAX, withHeader.length - i);
    parts.push(new Uint8Array([size]), withHeader.subarray(i, i + size));
  }
  parts.push(new Uint8Array([0])); // 子块结束
  parts.push(new Uint8Array([0x21, 0xfe, FINGERPRINT.length]), FINGERPRINT, new Uint8Array([0])); // 指纹注释块
  return concatBytes(parts);
}

/**
 * 从 GIF 取载荷（原版 extractDataFromGIF 的等价实现：从文件尾反向找魔数，最多容忍 20 个候选块）
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 载荷（已去掉 4 字节长度前缀）
 */
export function extractPayloadFromGif(bytes) {
  if (detectCoverKind(bytes) !== 'gif') throw new Error('不是有效的 GIF 文件');
  let blockStart = -1;
  let candidates = 0;
  for (let i = bytes.length - 3; i >= 0; i -= 1) {
    if (bytes[i] !== MAGIC_PREFIX[0] || bytes[i + 1] !== MAGIC_PREFIX[1] || bytes[i + 2] !== MAGIC_PREFIX[2]) continue;
    candidates += 1;
    const markerStart = i + 3;
    let matched = true;
    for (let j = 0; j < MAGIC.length; j += 1) {
      if (markerStart + j >= bytes.length || bytes[markerStart + j] !== MAGIC[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      blockStart = i;
      break;
    }
    if (candidates >= GIF_SCAN_CANDIDATES) break;
  }
  if (blockStart === -1) throw new Error('不是图夹图，或图片被压缩过（数据已丢失）');

  let offset = blockStart + 3 + MAGIC.length;
  const chunks = [];
  let total = 0;
  while (offset < bytes.length) {
    const size = bytes[offset];
    if (size === 0) break;
    if (offset + 1 + size > bytes.length) throw new Error('图夹数据不完整（图片可能被截断）');
    chunks.push(bytes.subarray(offset + 1, offset + 1 + size));
    total += size;
    offset += 1 + size;
  }
  if (total === 0) throw new Error('不是图夹图，或图片被压缩过（数据已丢失）');
  const hidden = concatBytes(chunks);
  if (hidden.length >= 4) {
    const declared = new DataView(hidden.buffer, hidden.byteOffset, hidden.byteLength).getUint32(0, false);
    if (declared > 0 && declared === hidden.length - 4) return hidden.slice(4);
  }
  return hidden;
}

// —— PNG 载体 ——

/**
 * 遍历 PNG 分块（只读，不做校验之外的解析）
 * @param {Uint8Array} bytes
 * @returns {{type: string, start: number, end: number, dataStart: number, dataLength: number}[]}
 */
export function parsePngChunks(bytes) {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('不是有效的 PNG 文件');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const end = dataStart + length + 4; // 数据 + CRC
    if (end > bytes.length) throw new Error('PNG 分块不完整（文件可能被截断）');
    chunks.push({ type, start: offset, end, dataStart, dataLength: length });
    offset = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

/**
 * PNG 头信息与「原版解包公式」所需的每像素字节数
 * 原版按 height*(1+width*bpp) 切分隐藏数据，因此只有 8 位深、非隔行的 PNG 才能直接用
 * @param {Uint8Array} bytes
 */
export function pngInfo(bytes) {
  const chunks = parsePngChunks(bytes);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG 缺少 IHDR 分块');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(ihdr.dataStart, false);
  const height = view.getUint32(ihdr.dataStart + 4, false);
  const bitDepth = bytes[ihdr.dataStart + 8];
  const colorType = bytes[ihdr.dataStart + 9];
  const interlace = bytes[ihdr.dataStart + 12];
  let bytesPerPixel;
  switch (colorType) {
    case 0: bytesPerPixel = 1; break;
    case 2: bytesPerPixel = 3; break;
    case 3: bytesPerPixel = 1; break;
    case 4: bytesPerPixel = 2; break;
    case 6: bytesPerPixel = 4; break;
    default: bytesPerPixel = 4;
  }
  return {
    width,
    height,
    bitDepth,
    colorType,
    interlace,
    bytesPerPixel,
    rawSize: height * (1 + width * bytesPerPixel)
  };
}

/** 该 PNG 能否直接做 IDAT 手术；返回 null 表示可以，否则返回原因（中文，可直接显示给用户） */
export function pngCompatError(info) {
  if (info.bitDepth !== 8) return `位深 ${info.bitDepth} 位（需重编码为 8 位）`;
  if (info.interlace !== 0) return '隔行扫描（需重编码）';
  if (![0, 2, 3, 4, 6].includes(info.colorType)) return `色彩类型 ${info.colorType}（需重编码）`;
  return null;
}

/** 把多个 IDAT 的数据段拼成一份（原版同样先 concat 再解压） */
export function concatIdatData(bytes, chunks) {
  const parts = chunks.filter((c) => c.type === 'IDAT').map((c) => bytes.subarray(c.dataStart, c.dataStart + c.dataLength));
  if (parts.length === 0) throw new Error('PNG 缺少 IDAT 分块');
  return concatBytes(parts);
}

/**
 * 从 IDAT 解压流里切出隐藏数据（原版 extractDataFromPNG 的等价实现）
 * @param {Uint8Array} inflated IDAT 解压后的扫描线数据
 * @param {{rawSize: number}} info pngInfo 的结果
 */
export function extractPayloadFromInflatedPng(inflated, info) {
  if (inflated.length <= info.rawSize) throw new Error('不是图夹图，或图片被压缩过（数据已丢失）');
  const hidden = inflated.subarray(info.rawSize);
  if (hidden.length === 0) throw new Error('不是图夹图，或图片被压缩过（数据已丢失）');
  return hidden;
}

/** 构造 iTXt(Software) 指纹分块（原版在 IEND 前插入的那一块） */
export function buildFingerprintChunk() {
  const encoder = new TextEncoder();
  const keyword = encoder.encode('Software');
  const body = concatBytes([
    keyword,
    new Uint8Array([0]), // 关键字结束
    new Uint8Array([0, 0]), // 压缩标志 + 压缩方法
    new Uint8Array([0]), // 语言标签结束
    new Uint8Array([0]), // 翻译关键字结束
    FINGERPRINT
  ]);
  const type = encoder.encode('iTXt');
  const out = new Uint8Array(8 + body.length + 4);
  out.set(u32be(body.length), 0);
  out.set(type, 4);
  out.set(body, 8);
  out.set(u32be(crc32Of([type, body])), 8 + body.length);
  return out;
}

/**
 * 用新的 IDAT 数据重建 PNG（其余分块原样保留），并在 IEND 前插入指纹块
 * @param {Uint8Array} bytes 原 PNG
 * @param {Uint8Array} idatData 新的 zlib 压缩数据
 * @returns {Uint8Array}
 */
export function writePngWithIdat(bytes, idatData) {
  const chunks = parsePngChunks(bytes);
  const idatType = new TextEncoder().encode('IDAT');
  const newIdat = concatBytes([u32be(idatData.length), idatType, idatData, u32be(crc32Of([idatType, idatData]))]);

  const parts = [PNG_SIGNATURE];
  let idatWritten = false;
  for (const chunk of chunks) {
    if (chunk.type === 'IDAT') {
      if (!idatWritten) {
        parts.push(newIdat);
        idatWritten = true;
      }
      continue;
    }
    if (chunk.type === 'IEND') parts.push(buildFingerprintChunk());
    parts.push(bytes.subarray(chunk.start, chunk.end));
  }
  if (!idatWritten) throw new Error('PNG 缺少 IDAT 分块');
  return concatBytes(parts);
}

// —— 条目名净化（防路径穿越；解包落盘前的最后一道关） ——

/** Windows 保留设备名（大小写不敏感；带扩展名的形态同样保留，如 CON.txt） */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** 取 basename 并清掉非法字符；空名给兜底名 */
export function safeEntryName(raw) {
  const flat = String(raw || '').replace(/\\/g, '/');
  let name = flat.split('/').pop() || '';
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  // Windows 会剥掉文件名结尾的点与空格（剥完可能变成另一个名字甚至空名），先自己剥掉
  name = name.replace(/[. ]+$/, '').trim();
  if (name === '' || name === '.' || name === '..') name = UNNAMED;
  // Windows 保留设备名（CON/NUL/COM1…）：直接落盘会失败或打到设备上，加前缀避让（v2.8.1）
  if (WIN_RESERVED.test(name)) name = `_${name}`;
  return name;
}

/**
 * 目录内重名时加序号（名字.txt → 名字(2).txt）。
 * Windows / macOS 的文件系统大小写不敏感：容器里同时有 `Photo.jpg` 与 `photo.jpg` 时
 * （原版客户端打的包完全可能这样），两个名字会落到同一个文件上——后写的静默覆盖先写的，
 * 而界面照样列两条，用户以为都解出来了。所以判重时按平台把大小写折起来。
 * 只在解包落盘这一步用；打包时不改名，容器内容与原版实现保持一致。
 */
// 注意：本模块也会被界面进程引入（imghide/ui.js），而渲染进程是 sandbox:true、**没有 process**。
// 顶层直接读 process.platform 会抛 ReferenceError，进而拖垮整个 shell（所有工具都加载不出来）。
// uniqueEntryName 只在主进程解包落盘时调用，所以这里取不到 process 就按大小写敏感处理。
const CASE_INSENSITIVE_FS = typeof process !== 'undefined'
  && (process.platform === 'win32' || process.platform === 'darwin');
const nameKey = (n) => (CASE_INSENSITIVE_FS ? String(n).toLowerCase() : n);

export function uniqueEntryName(usedNames, name) {
  if (!usedNames.has(nameKey(name))) {
    usedNames.add(nameKey(name));
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${base}(${i})${ext}`;
    if (!usedNames.has(nameKey(candidate))) {
      usedNames.add(nameKey(candidate));
      return candidate;
    }
  }
  const fallback = `${base}(${Date.now()})${ext}`;
  usedNames.add(nameKey(fallback));
  return fallback;
}

// —— 动态混淆（极速）容器：原版「动态混淆」用的另一套格式 ——
//
// 互通要点：原版有两套容器，走「极速」打法时对方会要求密码 ——
//   ① 动态混淆（极速）：载荷是**明文分隔符格式**，直接追加在图片尾部，靠全文件字节扫描定位；
//      不解压、不需密码、多大文件都能开（原版 `handleLegacyDecrypt` 就是全文件里找 `DYNAMIC_V2_`）。
//   ② 图夹 PRO（防查）：就是上面的 V6（含 16 字节指纹 + 可选密码）；原版客户端一看到指纹就弹密码框。
// 我们第一版只做了 ②，所以原版客户端把我们打的图当 PRO、要密码。两套都支持才叫真互通。
//
// 布局（与原版解析器逐条对齐）：
//   DYNAMIC_V2_ + <分隔符> + [<分隔符>filename<分隔符> + base64(UTF-8 文件名) +
//     <分隔符>filename<分隔符> + <分隔符>file<分隔符> + 原始数据] ...（最后一项数据一直到文件尾）
// 其中分隔符形如 `|||xxxxxx|||`（必须以 ||| 结尾，长度 > 3）。
// 另兼容更老的固定分隔符版本：`|||ENCRYPT_DELIMITER|||` / `|||FILENAME_DELIMITER|||` / `|||FILE_DELIMITER|||`。

/** 动态格式的固定前缀（原版 DYNAMIC_DELIMITER_PREFIX_V2） */
export const DYNAMIC_PREFIX_TEXT = 'DYNAMIC_V2_';
export const DYNAMIC_PREFIX = new TextEncoder().encode(DYNAMIC_PREFIX_TEXT);
/** 老版固定分隔符（原版 OLD_DELIMITER 等常量） */
export const OLD_DELIMITER_TEXT = '|||ENCRYPT_DELIMITER|||';
export const OLD_FILENAME_DELIMITER_TEXT = '|||FILENAME_DELIMITER|||';
export const OLD_FILE_DELIMITER_TEXT = '|||FILE_DELIMITER|||';

/**
 * 生成一个随机分隔符：随机串 + `|||`（**必须以 ||| 结尾、整体长度 > 3**）。
 * 注意不能写成 `|||xxxx|||`：原版解析器是从 `DYNAMIC_V2_` 之后取到「第一个 ||| 为止」作为分隔符，
 * 那样只会取到 `|||`（长度 3）而被判为「非图夹」（实测踩过）。
 */
export function makeDynamicDelimiter(rand = Math.random) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let mid = '';
  for (let i = 0; i < 10; i += 1) mid += alphabet[Math.floor(rand() * alphabet.length)] || 'x';
  return `${mid}|||`;
}

function bytesOf(text) {
  return new TextEncoder().encode(text);
}

/** 在字节流里找子串（朴素扫描；分隔符只有几十字节，够用且无依赖） */
export function indexOfBytes(haystack, needle, from = 0) {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  const first = needle[0];
  const last = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    if (haystack[i] !== first) continue;
    let k = 1;
    while (k < needle.length && haystack[i + k] === needle[k]) k += 1;
    if (k === needle.length) return i;
  }
  return -1;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** base64 → 字节（自己实现，渲染进程/Node 都能用） */
export function base64ToBytes(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    if (ch === '=') break;
    const value = B64_LOOKUP[ch.charCodeAt(0)];
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** 字节 → base64（同样自己实现） */
export function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 || 0) >> 4)];
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 15) << 2) | ((b2 || 0) >> 6)];
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 63];
  }
  return out;
}

/**
 * 生成「动态混淆（极速）」载荷
 * @param {{name: string, bytes: Uint8Array}[]} files
 * @param {string} [delimiter]
 */
export function buildDynamicPayload(files, delimiter = makeDynamicDelimiter()) {
  const parts = [bytesOf(DYNAMIC_PREFIX_TEXT + delimiter)];
  const fnDelim = bytesOf(`${delimiter}filename${delimiter}`);
  const fileDelim = bytesOf(`${delimiter}file${delimiter}`);
  for (const file of files) {
    // 名字走 base64（原版要求的形态）；必须转成字节再拼，直接塞字符串会被 Uint8Array.set 按字符码写坏（踩过）
    const nameB64Bytes = bytesOf(bytesToBase64(bytesOf(String(file.name || UNNAMED))));
    parts.push(fnDelim, nameB64Bytes, fnDelim, fileDelim, file.bytes);
  }
  return concatBytes(parts);
}

/**
 * 解析「动态混淆」载荷（与原版 handleLegacyDecrypt 的判定顺序一致：先 V2，再老版固定分隔符）
 * @param {Uint8Array} bytes 图片文件字节（原版就是拿整份文件字节来找前缀）
 * @returns {{files: {name: string, bytes: Uint8Array}[], dynamic: boolean, delimiter: string} | null}
 */
export function parseDynamicPayload(bytes) {
  let delimiter = '';
  let dynamic = false;
  let start = -1;

  const prefixIndex = indexOfBytes(bytes, DYNAMIC_PREFIX);
  if (prefixIndex !== -1) {
    const delimiterStart = prefixIndex + DYNAMIC_PREFIX.length;
    const marker = bytesOf('|||');
    const markerIndex = indexOfBytes(bytes, marker, delimiterStart);
    if (markerIndex === -1) return null;
    delimiter = new TextDecoder().decode(bytes.subarray(delimiterStart, markerIndex + marker.length));
    if (delimiter.length <= 3) return null;
    dynamic = true;
    start = prefixIndex;
  } else {
    const oldIndex = indexOfBytes(bytes, bytesOf(OLD_DELIMITER_TEXT));
    if (oldIndex === -1) return null;
    delimiter = OLD_DELIMITER_TEXT;
    start = oldIndex;
  }

  const fnDelim = bytesOf(dynamic ? `${delimiter}filename${delimiter}` : OLD_FILENAME_DELIMITER_TEXT);
  const fileDelim = bytesOf(dynamic ? `${delimiter}file${delimiter}` : OLD_FILE_DELIMITER_TEXT);
  const delimiterBytes = bytesOf(delimiter);

  let offset = start + delimiterBytes.length;
  const files = [];
  while (offset < bytes.length) {
    const nameStart = indexOfBytes(bytes, fnDelim, offset);
    if (nameStart === -1) break;
    offset = nameStart + fnDelim.length;
    const nameEnd = indexOfBytes(bytes, fnDelim, offset);
    if (nameEnd === -1) break;
    const rawName = bytes.subarray(offset, nameEnd);
    const name = dynamic
      ? new TextDecoder('utf-8').decode(base64ToBytes(new TextDecoder().decode(rawName)))
      : new TextDecoder('utf-8').decode(rawName);
    offset = nameEnd + fnDelim.length;
    const dataStart = indexOfBytes(bytes, fileDelim, offset);
    if (dataStart === -1) break;
    offset = dataStart + fileDelim.length;
    let nextFile = indexOfBytes(bytes, fnDelim, offset);
    if (nextFile === -1) nextFile = bytes.length;
    files.push({ name, bytes: bytes.subarray(offset, nextFile) });
    offset = nextFile;
  }
  if (files.length === 0) return null;
  return { files, dynamic, delimiter };
}

/** 把动态载荷追加到图片尾部（原版就是靠全文件扫描定位，放尾部最稳） */
export function appendDynamicPayload(imageBytes, payload) {
  return concatBytes([imageBytes, payload]);
}

// —— 体积提示：超大图夹在网站 / 手机端打不开 ——

/** 贴吧等平台的建议上限（原版口径：表图控制在 3MB 以内更好发） */
export const PLATFORM_HINT_BYTES = 3 * 1024 * 1024;
/** 网页版/手机端的安全线：超过这个体积，浏览器一页里放不下（实测解 788MB 的图要 2.3GB 内存） */
export const WEB_SAFE_BYTES = 50 * 1024 * 1024;

/**
 * 按「要藏的文件合计体积」给一条如实提示
 * @param {number} totalBytes 要藏进去的文件合计
 * @returns {{level: 'ok'|'hint'|'warn', text: string}}
 */
export function sizeWarning(totalBytes, coverBytes = 0, mode = 'fast') {
  const total = Number(totalBytes) || 0;
  const product = total + (Number(coverBytes) || 0);
  if (total > WEB_SAFE_BYTES && mode === 'pro') {
    // 只有 PRO（V6）那条路才要把整张图解压出来，网页版/手机端扛不住
    return {
      level: 'warn',
      text: `合计 ${humanBytes(total)}：太大了 —— 「防查」格式要整张图解压，网页版/手机 APP 多半打不开；`
        + '建议改用「极速」格式，或分批藏。'
    };
  }
  if (total > WEB_SAFE_BYTES) {
    return {
      level: 'hint',
      text: `合计 ${humanBytes(total)}：文件很大 —— 「极速」格式网站和手机都能解，但微信/QQ 传不动，建议用网盘或当面拷。`
    };
  }
  if (product > PLATFORM_HINT_BYTES) {
    return {
      level: 'hint',
      text: `预计产物约 ${humanBytes(product)}：微信/QQ 要按「文件」发送，贴吧要用原图链接（平台建议 3MB 以内更稳）。`
    };
  }
  return { level: 'ok', text: '' };
}

/** 人类可读体积（界面与结果行共用；与既有工具同一口径） */
export function humanBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}