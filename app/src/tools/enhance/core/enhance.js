// 工具：图片变清晰 —— 算法核心（纯函数，不依赖界面 DOM）
// 目标与范围见 spec/modules/image-enhance.md
// 分层说明：模糊图由调用方注入的 blurFn(pixels, width, height, radius) 生成
//           （界面层用 OffscreenCanvas + ctx.filter = `blur(Npx)`，GPU 加速）；
//           本文件只做逐像素差分与合成，便于在 node 里直接单测。

/** 自定义预设的参数默认值（界面滑杆初值） */
export const CUSTOM_DEFAULT = {
  sharpen: 80,    // 锐化强度 0~200（%）
  radius: 1.2,    // 模糊半径 0.5~5（px）
  threshold: 2,   // 阈值 0~32：差值不超过它的像素不锐化，避免放大噪点
  denoise: 0,     // 降噪强度 0~100（%）
  brightness: 0,  // 亮度 -100~100
  contrast: 0,    // 对比度 -100~100
  saturation: 0,  // 饱和度 -100~100
  scale: 1        // 放大倍数（1 = 不变；2 = 清晰放大 2×）
};

/**
 * 预设参数表（与 spec/modules/image-enhance.md 的参数表一一对应）
 * 界面只读这里的参数，处理时原样传给 applyEnhance。
 */
export const PRESETS = [
  {
    id: 'auto', name: '一键变清晰',
    sharpen: 80, radius: 1.2, threshold: 2, denoise: 0,
    brightness: 0, contrast: 6, saturation: 0, scale: 1,
    hint: '锐化 80% + 对比度 +6%：发虚、发灰的照片一键改善'
  },
  {
    id: 'light', name: '轻度锐化',
    sharpen: 40, radius: 1.2, threshold: 2, denoise: 0,
    brightness: 0, contrast: 0, saturation: 0, scale: 1,
    hint: '锐化 40%：只让边缘更分明，几乎不改变原有观感'
  },
  {
    id: 'strong', name: '强力锐化',
    sharpen: 140, radius: 1.2, threshold: 2, denoise: 0,
    brightness: 0, contrast: 0, saturation: 0, scale: 1,
    hint: '锐化 140%：效果明显；噪点多的照片请改用「照片降噪 + 轻锐化」'
  },
  {
    id: 'denoise', name: '照片降噪 + 轻锐化',
    sharpen: 60, radius: 1.2, threshold: 2, denoise: 50,
    brightness: 0, contrast: 0, saturation: 0, scale: 1,
    hint: '先轻度降噪（50%）再锐化 60%：适合手机夜拍等噪点多的照片'
  },
  {
    id: 'upscale2x', name: '清晰放大 2×',
    sharpen: 80, radius: 1.2, threshold: 2, denoise: 0,
    brightness: 0, contrast: 0, saturation: 0, scale: 2,
    hint: '高质量重采样放大 2 倍（只放大不缩小）+ 锐化 80%'
  },
  // —— AI 放大（超分）：调 addons/realesrgan 的 Real-ESRGAN，需要支持 Vulkan 的显卡 ——
  {
    id: 'ai-4x', name: 'AI 放大 4×（照片，推荐）',
    sharpen: 0, radius: 1.2, threshold: 0, denoise: 0,
    brightness: 0, contrast: 0, saturation: 0, scale: 1,
    ai: { scale: 4, model: 'realesrgan-x4plus' },
    hint: 'AI 超分：按模型重新绘制放大 4 倍，细节远好于普通放大。需支持 Vulkan 的显卡（纯 CPU 不可用），实测 720p 图约 10 秒（核显更慢）'
  },
  {
    id: 'ai-2x', name: 'AI 放大 2×（最快）',
    sharpen: 0, radius: 1.2, threshold: 0, denoise: 0,
    brightness: 0, contrast: 0, saturation: 0, scale: 1,
    ai: { scale: 2, model: 'realesr-animevideov3' },
    hint: 'AI 快速放大 2 倍（通用轻量模型，速度最快）。需支持 Vulkan 的显卡'
  },
  {
    id: 'ai-anime', name: 'AI 放大 4×（动漫/插画）',
    sharpen: 0, radius: 1.2, threshold: 0, denoise: 0,
    brightness: 0, contrast: 0, saturation: 0, scale: 1,
    ai: { scale: 4, model: 'realesrgan-x4plus-anime' },
    hint: '适合动漫、插画、二次元截图；真人照片请用「AI 放大 4×（照片）」。需支持 Vulkan 的显卡'
  },
  {
    id: 'custom', name: '自定义',
    ...CUSTOM_DEFAULT,
    hint: '自己调：锐化强度 / 半径 / 阈值 / 降噪 / 亮度 / 对比度 / 饱和度'
  }
];

/** 按 id 取预设；未知 id 回落到「一键变清晰」 */
export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));

/**
 * USM 锐化：原图 + 强度 ×（原图 − 模糊图）
 * 差值绝对值 ≤ threshold 的通道保持原样（不动平坦区域，避免把噪点一起放大）。
 * @param {Uint8ClampedArray} orig 原图像素（RGBA）
 * @param {Uint8ClampedArray} blurred 高斯模糊后的像素（RGBA，尺寸一致）
 * @param {{amount?: number, threshold?: number}} [options] amount 为倍数（1 = 100%）
 * @returns {Uint8ClampedArray} 新缓冲，不修改入参
 */
export function unsharpFromBlurred(orig, blurred, options = {}) {
  if (!orig || !blurred || orig.length !== blurred.length) {
    throw new Error('锐化输入不合法：原图与模糊图必须尺寸一致');
  }
  const amount = Number(options.amount) || 0;
  const threshold = Math.max(0, Number(options.threshold) || 0);
  const out = new Uint8ClampedArray(orig.length);

  for (let i = 0; i < orig.length; i += 4) {
    for (let k = 0; k < 3; k += 1) {
      const o = orig[i + k];
      const diff = o - blurred[i + k];
      // 差值在阈值内 → 像素（通道）不动
      out[i + k] = Math.abs(diff) <= threshold ? o : o + amount * diff;
    }
    out[i + 3] = orig[i + 3]; // 透明度保持不变
  }
  return out;
}

/**
 * 亮度 / 对比度 / 饱和度微调（参数均为 -100~100，0 = 不变）
 * 顺序：先加亮度，再用标准对比度系数拉伸，最后按亮度权重调整饱和度。
 * @param {Uint8ClampedArray} pixels RGBA
 * @param {{brightness?: number, contrast?: number, saturation?: number}} [options]
 * @returns {Uint8ClampedArray} 三个参数都为 0 时原样返回入参（省一次拷贝）
 */
export function adjustColors(pixels, options = {}) {
  const brightness = Number(options.brightness) || 0;
  const contrast = Number(options.contrast) || 0;
  const saturation = Number(options.saturation) || 0;
  if (!brightness && !contrast && !saturation) return pixels;

  const offset = (brightness / 100) * 255;
  const c = (contrast / 100) * 255;
  // 常见对比度公式：contrast=±100 时分别压平 / 极强拉伸
  const factor = (259 * (c + 255)) / (255 * (259 - c));
  const satFactor = 1 + saturation / 100;

  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    let r = factor * (pixels[i] + offset - 128) + 128;
    let g = factor * (pixels[i + 1] + offset - 128) + 128;
    let b = factor * (pixels[i + 2] + offset - 128) + 128;

    if (satFactor !== 1) {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      r = lum + (r - lum) * satFactor;
      g = lum + (g - lum) * satFactor;
      b = lum + (b - lum) * satFactor;
    }

    out[i] = r;      // Uint8ClampedArray 自动取整并夹在 0~255
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = pixels[i + 3];
  }
  return out;
}

/**
 * 清晰度指标：灰度拉普拉斯算子的方差（越大越锐，越小越糊）
 * 只用于自检 / 对比，不参与图像处理。
 * @param {Uint8ClampedArray} pixels RGBA
 * @param {number} width
 * @param {number} height
 * @returns {number} 方差；图太小（不足 3×3）时返回 0
 */
export function sharpnessMetric(pixels, width, height) {
  if (!pixels || width < 3 || height < 3) return 0;
  const lumAt = (i) => 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      const lap = lumAt(i - width * 4) + lumAt(i + width * 4) + lumAt(i - 4) + lumAt(i + 4) - 4 * lumAt(i);
      sum += lap;
      sumSq += lap * lap;
      n += 1;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** 两张同尺寸像素按比例线性混合（used by 降噪）：t=0 取 a，t=1 取 b */
function mixPixels(a, b, t) {
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 1) {
    out[i] = a[i] + (b[i] - a[i]) * t;
  }
  return out;
}

/**
 * 完整增强流程：降噪 → 锐化 → 亮度/对比度/饱和度
 * @param {Uint8ClampedArray} pixels 原图像素（尺寸须与 width/height 一致）
 * @param {number} width
 * @param {number} height
 * @param {object} params 见 PRESETS / CUSTOM_DEFAULT
 * @param {(pixels: Uint8ClampedArray, width: number, height: number, radius: number) => (Uint8ClampedArray|Promise<Uint8ClampedArray>)} blurFn 模糊图生成函数（界面层注入）
 * @returns {Promise<Uint8ClampedArray>}
 */
export async function applyEnhance(pixels, width, height, params, blurFn) {
  const p = params || {};
  const denoise = clamp(p.denoise, 0, 100);
  const sharpen = clamp(p.sharpen, 0, 200);
  let out = pixels;

  // 降噪：1px 轻模糊与原图按「降噪强度 × 0.6」混合（轻量近似，避免大图耗时过久）
  if (denoise > 0 && typeof blurFn === 'function') {
    const blurred = await blurFn(out, width, height, 1);
    out = mixPixels(out, blurred, (denoise / 100) * 0.6);
  }

  // 锐化：USM（模糊半径按参数；阈值内的平坦区域不动）
  if (sharpen > 0 && typeof blurFn === 'function') {
    const radius = clamp(p.radius || 1.2, 0.5, 5);
    const blurred = await blurFn(out, width, height, radius);
    out = unsharpFromBlurred(out, blurred, { amount: sharpen / 100, threshold: p.threshold || 0 });
  }

  return adjustColors(out, {
    brightness: clamp(p.brightness, -100, 100),
    contrast: clamp(p.contrast, -100, 100),
    saturation: clamp(p.saturation, -100, 100)
  });
}

/** 输出扩展名规则：JPG→.jpg（画质 95）；PNG→.png；其它格式一律转 PNG */
export function outputExtFor(inputExt) {
  const ext = String(inputExt || '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return '.jpg';
  return '.png';
}