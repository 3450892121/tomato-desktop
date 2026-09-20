// 「文件藏图」的容器格式（官方「图夹」V6）——纯逻辑：无 DOM、无 Node 专属依赖，
// 渲染进程（ui.js）、主进程（core/engine.mjs 动态 import）与测试共用。
// 规格与格式证据：spec/modules/imghide.md（含官方 decryptWorker.js 的对应函数名）。
//
// 格式速览（与官方逐字节一致，互通的前提）：
//   载荷      uint32 文件数 + 每文件 [uint32 名字长度 + UTF-8 名字 + uint64 大小 + 原始字节]（大端、不压缩）
//   GIF 载体  原字节零改动，尾部追加 21 FF 0B + 'STEGDATA V6' + 数据子块 + 指纹注释块；载荷前带 4 字节长度前缀
//   PNG 载体  载荷拼到 IDAT 解压流（扫描线数据）尾部，整体重压为单个 IDAT，并在 IEND 前插 iTXt 指纹块
//   密码      PBKDF2-SHA256(盐 'xcn2025', 10 万轮) → AES-256-GCM（12 字节 IV 前置、16 字节 tag 尾随）

/** 魔数 'STEGDATA V6'（官方常量名 STEG_DATA_V6） */
export const MAGIC = new Uint8Array([0x53, 0x54, 0x45, 0x47, 0x44, 0x41, 0x54, 0x41, 0x20, 0x56, 0x36]);
/** 魔数前的 3 字节（在 GIF 里即应用扩展块头 21 FF 0B） */
export const MAGIC_PREFIX = new Uint8Array([0x21, 0xff, 0x0b]);
/** 官方写在文件里的指纹（GIF 注释扩展 / PNG iTXt 的文本） */
export const FINGERPRINT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 官方写死的 PBKDF2 盐（互通必须一致） */
export const PASSWORD_SALT_TEXT = 'xcn2025';

/** GIF 子块最大 255 字节（官方分块步长） */
const GIF_BLOCK_MAX = 255;
/** 从文件尾反向扫描时容忍的候选块个数（官方 maxAppExtCount） */
const GIF_SCAN_CANDIDATES = 20;
/** 单个条目名长度上限（防御畸形载荷） */
const MAX_NAME_LENGTH = 4096;
/** 文件条目数上限（官方同样限制 10000） */
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

// —— CRC32（PNG 分块用；表与官方/Node 的 crc32 一致） ——

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
 * 生成载荷字节（官方 streamPrepareEmbedData 的输出；加密由 crypto 层另做）
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
 * 解析载荷（官方 parseExtractedData 的结构部分）；数据不完整时给可读错误
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
 * 把载荷追加进 GIF（官方 streamEmbedDataInGIF 的等价实现）
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
 * 从 GIF 取载荷（官方 extractDataFromGIF 的等价实现：从文件尾反向找魔数，最多容忍 20 个候选块）
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
 * PNG 头信息与「官方解包公式」所需的每像素字节数
 * 官方按 height*(1+width*bpp) 切分隐藏数据，因此只有 8 位深、非隔行的 PNG 才能直接用
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

/** 把多个 IDAT 的数据段拼成一份（官方同样先 concat 再解压） */
export function concatIdatData(bytes, chunks) {
  const parts = chunks.filter((c) => c.type === 'IDAT').map((c) => bytes.subarray(c.dataStart, c.dataStart + c.dataLength));
  if (parts.length === 0) throw new Error('PNG 缺少 IDAT 分块');
  return concatBytes(parts);
}

/**
 * 从 IDAT 解压流里切出隐藏数据（官方 extractDataFromPNG 的等价实现）
 * @param {Uint8Array} inflated IDAT 解压后的扫描线数据
 * @param {{rawSize: number}} info pngInfo 的结果
 */
export function extractPayloadFromInflatedPng(inflated, info) {
  if (inflated.length <= info.rawSize) throw new Error('不是图夹图，或图片被压缩过（数据已丢失）');
  const hidden = inflated.subarray(info.rawSize);
  if (hidden.length === 0) throw new Error('不是图夹图，或图片被压缩过（数据已丢失）');
  return hidden;
}

/** 构造 iTXt(Software) 指纹分块（官方在 IEND 前插入的那一块） */
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

/** 取 basename 并清掉非法字符；空名给兜底名 */
export function safeEntryName(raw) {
  const flat = String(raw || '').replace(/\\/g, '/');
  let name = flat.split('/').pop() || '';
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  if (name === '' || name === '.' || name === '..') name = UNNAMED;
  return name;
}

/** 目录内重名时加序号（名字.txt → 名字(2).txt） */
export function uniqueEntryName(usedNames, name) {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${base}(${i})${ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  const fallback = `${base}(${Date.now()})${ext}`;
  usedNames.add(fallback);
  return fallback;
}

/** 人类可读体积（界面与结果行共用；与既有工具同一口径） */
export function humanBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}