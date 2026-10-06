// 「文件压缩与解压」工具的格式矩阵（唯一事实来源，见 spec/modules/archive.md）
// 纯逻辑、无 DOM / 无 Node 专属依赖：渲染进程（ui.js）与主进程（main.js 动态 import）与测试共用。
//
// 关键事实（本机实测：7-Zip 26.03 x64 / Node v22）：
//   · 7z i 的可创建项只有 7z / zip / tar / gzip / bzip2 / xz / wim（rar、zstd 等均无 C 标志）。
//   · 7-Zip 用 -ttar 写 .tar.gz 只会得到纯 tar（不解；必须 tar 外层 GZIP 压缩分两步）。
//   · gzip/bzip2/xz 是「单文件流式」格式：7z a -tgzip 只能压 1 个文件（多文件会系统报错）。
//   · rar/rar5 仅解压（unRAR 许可禁止创建）；zstd 仅解压（故 zst 走 Node 内置 zlib）。
//   · Node v22 zlib 自带 zstdCompress/Decompress 与 brotliCompress/Decompress（本机已实测）。

/** 压缩级别 → 通用档名。7-Zip -mx 与 Node zstd/brotli 映射见 params.mjs */
export const LEVELS = [
  { id: 'store',    label: '存储（仅打包）' },
  { id: 'fastest',  label: '最快' },
  { id: 'fast',     label: '较快' },
  { id: 'normal',   label: '标准（默认）' },
  { id: 'small',    label: '较小' },
  { id: 'extreme',  label: '极限' }
];

/** 分卷尺寸（大文件分块）。仅 zip / 7z / tar 支持；流式单文件格式与 tar.* 不支持。 */
export const VOLUME_SIZES = [
  { id: 0, label: '不分卷' },
  { id: 10 * 1024 * 1024, label: '10 MB' },
  { id: 100 * 1024 * 1024, label: '100 MB' },
  { id: 512 * 1024 * 1024, label: '512 MB' },
  { id: 1024 * 1024 * 1024, label: '1 GB' },
  { id: 2 * 1024 * 1024 * 1024, label: '2 GB' },
  { id: 4 * 1024 * 1024 * 1024, label: '4 GB' }
];

/** 解压覆盖策略 */
export const OVERWRITE_MODES = [
  { id: 'skip', label: '跳过已存在' },
  { id: 'replace', label: '覆盖已存在' }
];

/** 解压目录结构 */
export const TREE_MODES = [
  { id: 'keep', label: '保留目录结构' },
  { id: 'flatten', label: '全部平铺到同一目录' }
];

/**
 * 双向（可压缩 + 可解压）格式。
 * engine:
 *   '7z'   → 走内置 7-Zip 加装包（create 用 -t<type>）；
 *   'node' → 走 Node 内置 zlib（zstd / brotli），不需要 7-Zip。
 * password: '7z'|'zip-aes256'|'zipcrypto'|null
 * volume:  是否支持分卷
 * compound: { out: 'gzip'|'bzip2'|'xz'|'zst'|'br' } —— 需要先打 tar 再压外层的复合格式
 */
export const BIDIRECTIONAL = [
  { id: 'zip',     name: 'ZIP',        ext: '.zip',     type: 'zip',   group: 'common',   engine: '7z',   password: 'zip',          volume: true,  level: true },
  { id: '7z',      name: '7Z',         ext: '.7z',      type: '7z',    group: 'common',   engine: '7z',   password: '7z',           volume: true,  level: true },
  { id: 'tar',     name: 'TAR',        ext: '.tar',     type: 'tar',   group: 'common',   engine: '7z',   password: null,            volume: true,  level: false },
  { id: 'gzip',    name: 'GZIP',       ext: '.gz',      type: 'gzip',  group: 'common',   engine: '7z',   password: null,            volume: false, level: true },
  { id: 'tar.gz',  name: 'TAR.GZ',     ext: '.tar.gz',  type: 'tar',   group: 'common',   engine: '7z',   password: null,            volume: false, level: true, compound: { out: 'gzip' } },
  { id: 'bz2',     name: 'BZIP2',      ext: '.bz2',     type: 'bzip2', group: 'alt',      engine: '7z',   password: null,            volume: false, level: true },
  { id: 'tar.bz2', name: 'TAR.BZ2',    ext: '.tar.bz2', type: 'tar',   group: 'alt',      engine: '7z',   password: null,            volume: false, level: true, compound: { out: 'bzip2' } },
  { id: 'xz',      name: 'XZ',         ext: '.xz',      type: 'xz',    group: 'alt',      engine: '7z',   password: null,            volume: false, level: true },
  { id: 'tar.xz',  name: 'TAR.XZ',     ext: '.tar.xz',  type: 'tar',   group: 'alt',      engine: '7z',   password: null,            volume: false, level: true, compound: { out: 'xz' } },
  { id: 'zst',     name: 'ZSTANDARD',  ext: '.zst',     type: 'zst',   group: 'alt',      engine: 'node', password: null,            volume: false, level: true },
  { id: 'tar.zst', name: 'TAR.ZST',    ext: '.tar.zst', type: 'tar',   group: 'alt',      engine: '7z',   password: null,            volume: false, level: true, compound: { out: 'zst' } },
  { id: 'br',      name: 'BROTLI',     ext: '.br',      type: 'br',    group: 'alt',      engine: 'node', password: null,            volume: false, level: true },
  { id: 'tar.br',  name: 'TAR.BR',     ext: '.tar.br',  type: 'tar',   group: 'alt',      engine: '7z',   password: null,            volume: false, level: true, compound: { out: 'br' } }
];

/**
 * 仅解压格式（免费工具不能创建，界面如实标注「仅解压」）。
 * 这里列常用的一批；7-Zip 实际可识别 96 种（以 7z i 实际输出为准），解压「自动识别」按签名即可。
 */
export const EXTRACT_ONLY = [
  { id: 'rar',    name: 'RAR / RAR5', ext: '.rar', note: '专有格式，没有免费工具能创建' },
  { id: 'cab',    name: 'CAB',        ext: '.cab' },
  { id: 'iso',    name: 'ISO',        ext: '.iso' },
  { id: 'arj',    name: 'ARJ',        ext: '.arj' },
  { id: 'lzh',    name: 'LZH / LHA',  ext: '.lzh' },
  { id: 'cpio',   name: 'CPIO',       ext: '.cpio' },
  { id: 'z',      name: 'Z (Unix)',   ext: '.z' },
  { id: 'wim',    name: 'WIM / ESD',  ext: '.wim' },
  { id: 'msi',    name: 'MSI',        ext: '.msi' },
  { id: 'deb',    name: 'DEB',        ext: '.deb' },
  { id: 'rpm',    name: 'RPM',        ext: '.rpm' },
  { id: 'chm',    name: 'CHM',        ext: '.chm' },
  { id: 'dmg',    name: 'DMG',        ext: '.dmg' },
  { id: 'xar',    name: 'XAR / PKG',  ext: '.xar' },
  { id: 'udf',    name: 'UDF',        ext: '.udf' },
  { id: 'vhd',    name: 'VHD',        ext: '.vhd' },
  { id: 'vmdk',   name: 'VMDK',       ext: '.vmdk' },
  { id: 'squashfs', name: 'SquashFS', ext: '.squashfs' }
];

/** 全部格式（双向在前，仅解压在后） */
export const ALL_FORMATS = [...BIDIRECTIONAL, ...EXTRACT_ONLY];

/** 选「文件/文件夹」时支持的压缩包扩展名（打开对话框用；解压按签名自动识别，这里只做过滤） */
export const ARCHIVE_EXTS = [
  ...BIDIRECTIONAL.map((f) => f.ext.replace(/^\./, '')),
  ...EXTRACT_ONLY.map((f) => f.ext.replace(/^\./, ''))
];

export function formatById(id) {
  return BIDIRECTIONAL.find((f) => f.id === id) || EXTRACT_ONLY.find((f) => f.id === id) || null;
}

/**
 * 按后缀匹配格式。**必须取最长匹配**：
 *   '.tar.gz'.endsWith('.gz') 也成立、'.xz'.endsWith('.z') 也成立 —— 顺序匹配会挑错格式（踩过）。
 */
function matchLongestExt(list, ext) {
  const e = String(ext).toLowerCase();
  let best = null;
  for (const f of list) {
    if (!e.endsWith(f.ext)) continue;
    if (!best || f.ext.length > best.ext.length) best = f;
  }
  return best;
}

/** 扩展名（小写，含点）→ 双向格式；未知返回 null */
export function formatByExt(ext) {
  return matchLongestExt(BIDIRECTIONAL, ext);
}

/**
 * 该格式是否支持给定密码方案。
 * scheme：'7z'（7z 容器 AES-256）| 'zip-aes256' | 'zipcrypto' | null（不加密）
 */
export function supportsPassword(fmt, scheme) {
  if (!fmt || !fmt.password) return scheme === null || scheme === undefined;
  if (fmt.password === '7z') return scheme === '7z';
  if (fmt.password === 'zip') return scheme === 'zip-aes256' || scheme === 'zipcrypto';
  return false;
}

export function isCompound(fmt) {
  return !!fmt && !!fmt.compound;
}

/** 复合格式的外层压缩算法 id（gzip / bzip2 / xz / zst / br） */
export function compoundOuter(fmt) {
  return fmt && fmt.compound ? fmt.compound.out : null;
}

/** 外层层是否需要 7-Zip（gzip/bzip2/xz 走 7z；zst 走 Node zlib；br 走 Node zlib） */
export function outerNeeds7z(fmt) {
  const out = compoundOuter(fmt);
  return out === 'gzip' || out === 'bzip2' || out === 'xz';
}

/** 分卷是否可用（zip / 7z / tar 是真容器；流式与复合格式不行） */
export function supportsVolume(fmt) {
  return !!fmt && !!fmt.volume;
}

/** 格式是否走 Node 内置 zlib（这样即便没装 7-Zip 也可用） */
export function isNodeFormat(fmt) {
  return !!fmt && fmt.engine === 'node';
}

/** 是否为复合格式（tar.gz / tar.bz2 / tar.xz / tar.zst / tar.br） */
export function isTarFlavored(ext) {
  const e = String(ext).toLowerCase();
  return /\.tar(\.gz|\.bz2|\.xz|\.zst|\.br)$/.test(e);
}

/** 根据扩展名猜「仅解压」格式，用于界面提示（解压本身按签名自动识别） */
export function extractOnlyByExt(ext) {
  return matchLongestExt(EXTRACT_ONLY, ext);
}

/** 是否为分卷的一卷（.001 / .002 / .7z.001 等） */
export function looksLikeVolumePart(fileName) {
  return /\.\d{3}$/.test(String(fileName || ''));
}

/** 是否为分卷的**第一卷**（只有首卷能被 7-Zip 当作入口） */
export function looksLikeFirstVolume(fileName) {
  return /\.001$/.test(String(fileName || ''));
}

/** 取「第一卷」文件名（解压分卷包时只挑首卷）：给 .001 结尾的名（若已是则不重复叠） */
export function firstVolumeName(fileName) {
  const n = String(fileName || '');
  const m = /^(.*)\.\d{3}$/.exec(n);
  if (m) return `${m[1]}.001`;
  return `${n}.001`;
}