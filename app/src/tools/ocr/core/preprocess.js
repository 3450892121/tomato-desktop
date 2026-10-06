// 工具：文字识别 —— 纯逻辑层（扫描件预处理）
//
// 目的：扫描件常常灰底、脏点、轻微倾斜，直接影响识别率。这里把常见几招做成
//       **纯像素算法**（输入输出都是像素数组，不碰 DOM / canvas），既能被 node 单测，
//       也能在界面进程对渲染出来的整页位图直接处理。
//
// 处理顺序（固定，见 plan.steps，界面按此展示）：
//   灰度化 → 反色（可选）→ 纠偏（投影方差搜索微角度）→ 中值去噪（可选，默认关）→ 锐化（USM）→ 黑白化/去灰底
//
// 关于「中值去噪」默认关：实测（1000×320 中文夹具，灰底 + 6% 椒盐噪声 + 倾斜 3°）
//   只做自适应阈值 → 字符召回 100%；中值 + 阈值 → 召回降到 61%（第二行整行丢失）。
//   所以默认不走去噪，保留能力供以后按需开启（例如噪点极密的传真件）。
//
// 坐标说明：纠偏是「绕图像中心旋转、裁回原尺寸」，所以旋转后的图与旋转前**同尺寸**，
//          识别框要回到原图坐标只需再做一次绕中心的反向旋转（见 unrotateBox）。

/** 默认参数（界面上的勾选项对应这里的字段） */
export const PREPROCESS_DEFAULTS = {
  grayscale: true,      // 灰度化（始终执行，除非整条链路都没开）
  invert: false,        // 反色：深底浅字的扫描件
  deskew: false,        // 纠偏
  maxAngle: 5,          // 纠偏搜索范围（±度）
  minAngle: 0.4,        // 小于这个角度就不转了（免得把好图转坏）
  median: false,        // 中值去噪（3×3）：实测会拉低识别率，默认关
  sharpen: false,       // 锐化
  sharpenAmount: 0.6,   // 锐化强度
  binarize: true,       // 黑白化 / 去灰底
  method: 'adaptive',   // 'adaptive' 自适应阈值（去灰底）| 'otsu' 大津法 | 'manual' 手动阈值
  window: 31,           // 自适应阈值窗口（奇数）
  c: 12,                // 自适应阈值偏移：像素 > 局部均值 - c 判为背景
  threshold: null       // method === 'manual' 时的阈值（0~255）
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const oddClamp = (v, def, lo, hi) => {
  const n = Number.isFinite(v) ? Math.round(v) : def;
  const odd = n % 2 === 0 ? n + 1 : n;
  return clamp(odd, lo, hi);
};

/**
 * 勾选项 → 规范化处理计划（纯函数；界面也用它生成「将执行哪些步骤」的说明）
 * @param {object} options 见 PREPROCESS_DEFAULTS
 * @returns {{grayscale:boolean,invert:boolean,deskew:boolean,maxAngle:number,minAngle:number,
 *            median:boolean,sharpen:boolean,sharpenAmount:number,binarize:boolean,method:string,
 *            window:number,c:number,threshold:(number|null),steps:string[]}}
 */
export function planPreprocess(options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  const method = o.method === 'otsu' || o.method === 'manual' ? o.method : 'adaptive';
  const plan = {
    grayscale: o.grayscale !== false,
    invert: !!o.invert,
    deskew: !!o.deskew,
    maxAngle: Number.isFinite(o.maxAngle) ? clamp(Number(o.maxAngle), 0, 15) : PREPROCESS_DEFAULTS.maxAngle,
    minAngle: Number.isFinite(o.minAngle) ? Math.max(0, Number(o.minAngle)) : PREPROCESS_DEFAULTS.minAngle,
    median: o.median === true,
    sharpen: !!o.sharpen,
    sharpenAmount: Number.isFinite(o.sharpenAmount) ? clamp(Number(o.sharpenAmount), 0, 3) : PREPROCESS_DEFAULTS.sharpenAmount,
    binarize: o.binarize !== false,
    method,
    window: oddClamp(o.window, PREPROCESS_DEFAULTS.window, 3, 199),
    c: Number.isFinite(o.c) ? Number(o.c) : PREPROCESS_DEFAULTS.c,
    threshold: Number.isFinite(o.threshold) ? clamp(Number(o.threshold), 0, 255) : null
  };

  plan.steps = [];
  if (plan.grayscale) plan.steps.push('灰度化');
  if (plan.invert) plan.steps.push('反色（深底浅字）');
  if (plan.deskew) plan.steps.push(`纠偏（±${plan.maxAngle}° 自动检测）`);
  if (plan.median) plan.steps.push('中值去噪');
  if (plan.sharpen) plan.steps.push(`锐化（USM ${plan.sharpenAmount}）`);
  if (plan.binarize) {
    plan.steps.push(plan.method === 'otsu' ? '黑白化（大津法）'
      : plan.method === 'manual' ? `黑白化（阈值 ${plan.threshold == null ? 160 : plan.threshold}）`
        : '去灰底（自适应阈值）');
  }
  return plan;
}

// —— 基础算子（都对「单通道灰度 Uint8ClampedArray（长度 w*h）」操作） ——

/** 取像素缓冲：兼容 {pixels,w,h} 与 ImageData（.data） */
function pixelsOf(imageDataLike) {
  const o = imageDataLike || {};
  const px = o.pixels || o.data;
  const width = Math.round(o.width || 0);
  const height = Math.round(o.height || 0);
  if (!px || width <= 0 || height <= 0) throw new Error('像素数据无效（需要 {pixels,width,height}）');
  return { px, width, height };
}

/** RGBA → 单通道灰度 */
export function toGray(pixels, width, height, invert = false) {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j += 1) {
    const v = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    out[j] = invert ? 255 - v : v;
  }
  return out;
}

/**
 * 灰度 → RGBA（就地写回原缓冲，alpha 拉满）
 * 说明：预处理的产物本身就是灰度/黑白图（扫描件增强的常规做法），
 *       所以无论勾没勾「灰度化」，写回的都是处理后的亮度值。
 */
function writeGrayBack(pixels, gray) {
  for (let i = 0, j = 0; j < gray.length; i += 4, j += 1) {
    pixels[i] = gray[j];
    pixels[i + 1] = gray[j];
    pixels[i + 2] = gray[j];
    pixels[i + 3] = 255;
  }
}

/** 双线性采样（越界取最近边缘像素） */
function sampleBilinear(src, w, h, x, y) {
  const x0 = clamp(Math.floor(x), 0, w - 1);
  const y0 = clamp(Math.floor(y), 0, h - 1);
  const x1 = clamp(x0 + 1, 0, w - 1);
  const y1 = clamp(y0 + 1, 0, h - 1);
  const fx = clamp(x - x0, 0, 1);
  const fy = clamp(y - y0, 0, 1);
  const a = src[y0 * w + x0];
  const b = src[y0 * w + x1];
  const c = src[y1 * w + x0];
  const d = src[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * 绕图像中心旋转灰度图（正角度 = 顺时针，图像坐标 y 向下），旋转后裁回原尺寸。
 * @param {Uint8ClampedArray} src
 * @param {number} width
 * @param {number} height
 * @param {number} angleDeg
 * @returns {Uint8ClampedArray}
 */
export function rotateGray(src, width, height, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      // 反向映射：输出点 ← 源点 R(-a)·(点-中心)+中心
      const sx = cx + dx * cos + dy * sin - 0.5;
      const sy = cy - dx * sin + dy * cos - 0.5;
      out[y * width + x] = sampleBilinear(src, width, height, sx, sy);
    }
  }
  return out;
}

/**
 * 识别框坐标回映射：把「纠偏后的图」上的框换算回「纠偏前的原图」坐标。
 * 由于纠偏是绕中心同尺寸旋转，逆变换就是把四个角绕中心反向转回去，再取外接矩形。
 * @param {{x,y,width,height}} box
 * @param {{angleDeg:number,width:number,height:number}} info angleDeg 为纠偏时实际旋转的角度
 * @returns {{x,y,width,height}}
 */
export function unrotateBox(box, { angleDeg = 0, width = 0, height = 0 } = {}) {
  if (!box || !angleDeg) return box ? { ...box } : { x: 0, y: 0, width: 0, height: 0 };
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  const corners = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height]
  ].map(([px, py]) => {
    const dx = px - cx;
    const dy = py - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
}

/** 大津法阈值（0~255） */
export function otsuThreshold(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best;
}

/** 3×3 中值去噪（就地） */
export function median3(gray, width, height) {
  const src = new Uint8ClampedArray(gray);
  const buf = new Array(9);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = clamp(x + dx, 0, width - 1);
          const yy = clamp(y + dy, 0, height - 1);
          buf[n] = src[yy * width + xx];
          n += 1;
        }
      }
      buf.sort((a, b) => a - b);
      gray[y * width + x] = buf[4];
    }
  }
  return gray;
}

/** USM 锐化（就地）：原图 + 强度 ×(原图 - 高斯模糊) */
export function unsharp(gray, width, height, amount = 0.6) {
  const src = new Uint8ClampedArray(gray);
  const K = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = clamp(x + dx, 0, width - 1);
          const yy = clamp(y + dy, 0, height - 1);
          sum += src[yy * width + xx] * K[k];
          k += 1;
        }
      }
      const blur = sum / 16;
      const v = src[y * width + x];
      gray[y * width + x] = clamp(v + amount * (v - blur), 0, 255);
    }
  }
  return gray;
}

/** 自适应阈值（积分图 + 局部均值）：压掉不均匀灰底 */
function adaptiveBinarize(gray, width, height, win, c) {
  const w1 = width + 1;
  const integral = new Uint32Array(w1 * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * w1 + (x + 1)] = integral[y * w1 + (x + 1)] + rowSum;
    }
  }
  const r = Math.max(1, Math.floor(win / 2));
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height - 1, y + r);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * w1 + (x1 + 1)] - integral[y0 * w1 + (x1 + 1)]
        - integral[(y1 + 1) * w1 + x0] + integral[y0 * w1 + x0];
      const mean = sum / area;
      gray[y * width + x] = gray[y * width + x] > mean - c ? 255 : 0;
    }
  }
  return gray;
}

/** 按计划做黑白化（就地） */
export function binarize(gray, width, height, plan) {
  const p = plan || {};
  const method = p.method || 'adaptive';
  if (method === 'adaptive') return adaptiveBinarize(gray, width, height, p.window || 31, Number.isFinite(p.c) ? p.c : 12);
  const t = method === 'manual'
    ? (Number.isFinite(p.threshold) ? p.threshold : 160)
    : otsuThreshold(gray);
  for (let i = 0; i < gray.length; i += 1) gray[i] = gray[i] > t ? 255 : 0;
  return gray;
}

// —— 纠偏角度检测 ——

/** 把灰度图按整数倍降采样到长边不超过 maxDim（盒平均），供角度搜索用（全尺寸搜索太慢） */
function downsample(gray, width, height, maxDim) {
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / maxDim));
  if (factor === 1) return { gray, width, height };
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        const yy = y * factor + dy;
        if (yy >= height) break;
        for (let dx = 0; dx < factor; dx += 1) {
          const xx = x * factor + dx;
          if (xx >= width) break;
          sum += gray[yy * width + xx];
          n += 1;
        }
      }
      out[y * w + x] = n ? sum / n : 255;
    }
  }
  return { gray: out, width: w, height: h };
}

/** 行投影方差：文字行越水平，行灰度和的方差越大 */
function projectionVariance(gray, width, height) {
  const rows = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    let s = 0;
    const base = y * width;
    for (let x = 0; x < width; x += 1) s += 255 - gray[base + x]; // 取「墨的多少」
    rows[y] = s;
  }
  let mean = 0;
  for (let y = 0; y < height; y += 1) mean += rows[y];
  mean /= height;
  let v = 0;
  for (let y = 0; y < height; y += 1) v += (rows[y] - mean) * (rows[y] - mean);
  return v / height;
}

/**
 * 估计纠偏角度：在 ±maxAngle 内按 step 逐个小角度试转，取「行投影方差最大」的角度。
 * @param {{pixels: Uint8ClampedArray, width: number, height: number}} image 单通道灰度图
 * @param {{maxAngle?: number, step?: number, maxDim?: number}} [options]
 * @returns {number} 需要旋转的角度（度，正=顺时针）；不倾斜时接近 0
 */
export function estimateDeskewAngle(image, options = {}) {
  const { maxAngle = 5, step = 0.5, maxDim = 600 } = options;
  const { px, width, height } = pixelsOf(image);
  if (width < 8 || height < 8) return 0;
  const small = downsample(px, width, height, maxDim);

  let best = 0;
  let bestVar = -1;
  for (let a = -maxAngle; a <= maxAngle + 1e-9; a += step) {
    const rotated = Math.abs(a) < 1e-6 ? small.gray : rotateGray(small.gray, small.width, small.height, a);
    const v = projectionVariance(rotated, small.width, small.height);
    if (v > bestVar) { bestVar = v; best = a; }
  }
  // 只保留一位小数，避免返回 -0 之类影响展示与缓存
  return Math.round(best * 10) / 10;
}

/**
 * 执行预处理（就地改写 pixels，返回处理信息）
 * @param {{pixels: Uint8ClampedArray, width: number, height: number}|ImageData} imageDataLike
 * @param {object} plan planPreprocess() 的结果（也可直接传原始勾选项）
 * @returns {{pixels: Uint8ClampedArray, width: number, height: number, angleDeg: number, plan: object}}
 *          angleDeg 为实际旋转角度（未纠偏 / 角度太小则为 0），
 *          识别框要用 unrotateBox(box, {angleDeg, width, height}) 回到原图坐标
 */
export function applyPreprocess(imageDataLike, plan) {
  const { px, width, height } = pixelsOf(imageDataLike);
  const p = planPreprocess(plan);
  let gray = toGray(px, width, height, p.invert);

  let angleDeg = 0;
  if (p.deskew) {
    angleDeg = estimateDeskewAngle({ pixels: gray, width, height }, { maxAngle: p.maxAngle });
    if (Math.abs(angleDeg) >= p.minAngle) gray = rotateGray(gray, width, height, angleDeg);
    else angleDeg = 0;
  }
  if (p.median) median3(gray, width, height);
  if (p.sharpen) unsharp(gray, width, height, p.sharpenAmount);
  if (p.binarize) binarize(gray, width, height, p);

  writeGrayBack(px, gray);
  return { pixels: px, width, height, angleDeg, plan: p };
}