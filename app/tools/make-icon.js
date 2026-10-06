// 生成应用图标（纯 Node，不依赖任何第三方库）
// 产出：
//   app/src/assets/icon.png  —— 窗口图标（256×256）
//   app/build/icon.ico       —— 打包进 exe 的图标（ICO 容器内嵌 256×256 PNG）
// 设计：浅色圆角底 + 番茄（红果 + 绿叶）
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 4; // 4× 超采样，边缘更平滑

function mix(base, over, alpha) {
  return Math.round(base * (1 - alpha) + over * alpha);
}

/** 判断某点属于哪个图形（在 4× 超采样网格上求平均） */
function renderIcon() {
  const px = new Uint8Array(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const cx = SIZE / 2;
          const cy = SIZE / 2;

          // 1) 圆角方形底（浅灰白）
          const inset = 8;
          const radius = 56;
          const insideRounded =
            fx > inset && fx < SIZE - inset && fy > inset && fy < SIZE - inset &&
            (Math.min(fx - inset, SIZE - inset - fx) > radius - 1 || Math.min(fy - inset, SIZE - inset - fy) > radius - 1 ||
              Math.hypot(Math.max(0, Math.abs(fx - cx) - (SIZE / 2 - inset - radius)), Math.max(0, Math.abs(fy - cy) - (SIZE / 2 - inset - radius))) <= radius);

          let cr = 0, cg = 0, cb = 0, ca = 0;

          // 2) 番茄果（红色圆，底部略宽）
          const bodyR = 74;
          const bodyY = cy + 10;
          const dBody = Math.hypot((fx - cx) / 1.06, fy - bodyY);
          const inBody = dBody <= bodyR;
          // 高光
          const dGloss = Math.hypot(fx - (cx - 26), fy - (bodyY - 28));
          const inGloss = dGloss <= 22;

          // 3) 叶子（顶部三片小叶：用椭圆近似）
          const leaf = (lx, ly, rx, ry, ang) => {
            const dx = fx - lx;
            const dy = fy - ly;
            const c = Math.cos(-ang);
            const s = Math.sin(-ang);
            const ux = dx * c - dy * s;
            const uy = dx * s + dy * c;
            return (ux * ux) / (rx * rx) + (uy * uy) / (ry * ry) <= 1;
          };
          const inLeaf =
            leaf(cx, cy - 62, 34, 15, -0.35) ||
            leaf(cx, cy - 62, 34, 15, 0.35) ||
            leaf(cx, cy - 70, 12, 26, 0);

          if (inLeaf) {
            cr = 62; cg = 150; cb = 80; ca = 1;
          } else if (inBody) {
            cr = inGloss ? 244 : 226;
            cg = inGloss ? 138 : 82;
            cb = inGloss ? 128 : 70;
            ca = 1;
          } else if (insideRounded) {
            cr = 244; cg = 245; cb = 247; ca = 1;
          }

          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
          n += 1;
        }
      }

      const i = (x + y * SIZE) * 4;
      const alpha = a / n;
      px[i] = alpha > 0 ? mix(255, r / a, 1) : 0;
      px[i + 1] = alpha > 0 ? mix(255, g / a, 1) : 0;
      px[i + 2] = alpha > 0 ? mix(255, b / a, 1) : 0;
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

/** 最小 PNG 编码（RGBA、无隔行） */
function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ICO 容器（单条目，内嵌 PNG，Windows Vista+ 支持） */
function makeIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(1, 4);      // count
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width (0 = 256)
  entry[1] = size >= 256 ? 0 : size; // height
  entry[2] = 0;                       // palette
  entry[3] = 0;                       // reserved
  entry.writeUInt16LE(1, 4);          // planes
  entry.writeUInt16LE(32, 6);         // bpp
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(6 + 16, 12);    // offset
  return Buffer.concat([header, entry, pngBuffer]);
}

function main() {
  const png = encodePng(renderIcon(), SIZE);
  const assetsDir = path.join(__dirname, '..', 'src', 'assets');
  const buildDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), png);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), makeIco(png, SIZE));
  console.log(`icon.png ${png.length} bytes -> ${path.join(assetsDir, 'icon.png')}`);
  console.log(`icon.ico -> ${path.join(buildDir, 'icon.ico')}`);
}

main();