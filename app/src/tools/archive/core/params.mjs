// 7-Zip 命令行参数拼装 + 输出解析（纯函数，可单测）
// 全部写法都以本机 7-Zip 26.03 实测为准，不是照抄文档。
import { LEVELS, isCompound, isTarFlavored, supportsVolume } from './formats.mjs';

/** 压缩级别 → 7-Zip -mx 值（store=0 不压缩） */
const SEVENZIP_LEVEL = { store: 0, fastest: 1, fast: 3, normal: 5, small: 7, extreme: 9 };

/** 压缩级别 → Node zstd level（zstd 范围 1~22；-5 为快速档） */
const ZSTD_LEVEL = { store: 0, fastest: 1, fast: 3, normal: 6, small: 15, extreme: 19 };

/** 压缩级别 → Node brotli quality（0~11） */
const BROTLI_QUALITY = { store: 0, fastest: 1, fast: 4, normal: 6, small: 9, extreme: 11 };

export function sevenZipLevel(levelId) {
  return Object.prototype.hasOwnProperty.call(SEVENZIP_LEVEL, levelId) ? SEVENZIP_LEVEL[levelId] : 5;
}

export function zstdLevel(levelId) {
  return Object.prototype.hasOwnProperty.call(ZSTD_LEVEL, levelId) ? ZSTD_LEVEL[levelId] : 6;
}

export function brotliQuality(levelId) {
  return Object.prototype.hasOwnProperty.call(BROTLI_QUALITY, levelId) ? BROTLI_QUALITY[levelId] : 6;
}

/** 分卷字节数 → -v 参数值（如 100MB → '100m'）；0/无效返回 null */
export function volumeArg(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const MB = 1024 * 1024;
  if (n >= 1024 * MB && n % (1024 * MB) === 0) return `${n / (1024 * MB)}g`;
  if (n % MB === 0) return `${n / MB}m`;
  if (n % 1024 === 0) return `${n / 1024}k`;
  return `${Math.max(1, Math.floor(n / 1024))}k`;
}

/**
 * 压缩参数（7-Zip）。
 * @param {object} o
 * @param {object} o.format    formats.mjs 里的双向格式对象
 * @param {string} o.level     级别 id（LEVELS）
 * @param {string} [o.password]
 * @param {'zip-aes256'|'zipcrypto'} [o.encrypt] zip 的加密方案（7z 固定 AES-256）
 * @param {number} [o.volumeBytes] 分卷字节数（0/缺省 = 不分卷）
 * @param {string} o.archivePath   输出压缩包完整路径
 * @param {string[]} [o.names]     要加入的条目名（相对 cwd）；缺省 = 用 '.' 打整个 cwd
 * @returns {string[]}
 */
export function createArgs(o = {}) {
  const fmt = o.format;
  if (!fmt) throw new Error('createArgs: 缺少 format');
  const type = o.overrideType || fmt.type;
  const args = ['a', `-t${type}`];
  // TAR 只打包不压缩（-mx 对它无意义，统一给 0）；其余按级别给（gzip/bzip2/xz 的 -mx 实测均合法）
  args.push(type === 'tar' ? '-mx=0' : `-mx=${sevenZipLevel(o.level)}`);
  args.push('-bsp1', '-bb1', '-y');
  // 覆盖已有压缩包（重名时主进程已改成「加序号」的新名，这里覆盖的只可能是本次的中间产物）
  args.push('-aoa');

  const pw = o.password ? String(o.password) : '';
  if (pw) {
    // 注意：**没密码时绝不传 -p**——`-p` 空值在部分容器上会被当成「空密码」从而真的加密；
    //       而 list/extract 传空 `-p` 是安全的（实测：普通包正常列目录，加密包给出干净报错）。
    args.push(`-p${pw}`);
    if (fmt.password === '7z') {
      // 7z 用 AES-256 并加密文件名（连文件名都看不到）
      args.push('-mhe=on');
    } else if (fmt.password === 'zip') {
      // zip 的两种方案：AES-256（默认，安全）或 ZipCrypto（传统，Windows 资源管理器能打开）
      args.push(`-mem=${o.encrypt === 'zipcrypto' ? 'ZipCrypto' : 'AES256'}`);
    }
  }

  const vol = supportsVolume(fmt) ? volumeArg(o.volumeBytes) : null;
  if (vol) args.push(`-v${vol}`);

  args.push(o.archivePath);
  if (Array.isArray(o.names) && o.names.length) args.push(...o.names);
  else args.push('.');
  return args;
}

/**
 * 解压参数（7-Zip x = 保留目录结构；e = 全部平铺）。
 * 为什么总是带 `-p`（没有密码时就是空 `-p`）：不给 -p 时 7-Zip 会**交互式索要密码**，
 * 在 spawn 环境下会一直等输入（实测挂起）；给空 `-p` 则立刻给出干净报错
 * 「Cannot open encrypted archive. Wrong password?」。
 * 同时 `-sccUTF-8` 必须加：否则中文条目名在管道里按 OEM 码页输出，界面会显示乱码（实测）。
 */
export function extractArgs(o = {}) {
  const cmd = o.flatten ? 'e' : 'x';
  const args = [cmd, '-y', '-bsp1', '-bb1', '-sccUTF-8', '-bd'];
  args.push(`-p${o.password ? String(o.password) : ''}`);
  args.push(o.overwrite === 'replace' ? '-aoa' : '-aos');
  args.push(`-o${o.outputDir}`);
  args.push(o.archivePath);
  return args;
}

/** 列表参数（预览内容，不解压）：l -slt -ba；`-p` 空值实测对普通包无副作用 */
export function listArgs(o = {}) {
  const args = ['l', '-slt', '-ba', '-sccUTF-8', '-bd'];
  args.push(`-p${o.password ? String(o.password) : ''}`);
  args.push(o.archivePath);
  return args;
}

/** 测试压缩包完整性参数（t = test，不落盘） */
export function testArgs(o = {}) {
  const args = ['t', '-sccUTF-8', '-bd'];
  args.push(`-p${o.password ? String(o.password) : ''}`);
  args.push(o.archivePath);
  return args;
}

/** 检测格式（7-Zip 无独立命令，用 l 的输出 Type = 行；这里给 l 的精简参数） */
export function detectArgs(archivePath) {
  return ['l', '-ba', '-sccUTF-8', '-bd', archivePath];
}

// —— 输出解析 ——

/**
 * 把 `7z l -slt` 的原始输出切成「归档元信息块」与「条目块」。
 * 实测结构（7-Zip 26.03）：
 *   （版本/扫描行）→ `--` → 元信息（Path/Type/Physical Size…）→ `----------` → 条目块
 * 元信息与条目块之间的分隔线是**一行连续短横线**（10 个），元信息前的引导线是 2 个短横线。
 */
export function splitListOutput(text) {
  const lines = String(text || '').split(/\r?\n/);
  const dash = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^-{2,}$/.test(lines[i].trim())) dash.push(i);
  }
  if (dash.length === 0) return { metaText: '', entriesText: String(text || '') };
  const metaStart = dash[0];
  const entriesStart = dash.length > 1 ? dash[1] : dash[0];
  return {
    metaText: lines.slice(metaStart + 1, entriesStart).join('\n'),
    entriesText: lines.slice(entriesStart + 1).join('\n')
  };
}

/**
 * 解析 `7z l -slt -ba` 的输出为条目数组（会自动跳过归档元信息块）。
 * 每个条目的字段以「空行」分隔；未知字段忽略。返回：
 * [{ path, folder, size, packedSize, modified, encrypted, crc, method }]
 */
export function parseListOutput(text) {
  const entries = [];
  const { entriesText } = splitListOutput(text);
  let cur = null;
  const pushCur = () => {
    if (cur && cur.path != null) entries.push(cur);
    cur = null;
  };
  for (const raw of entriesText.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) {
      pushCur();
      continue;
    }
    const eq = line.indexOf(' = ');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 3);
    if (!cur) cur = { path: null };
    switch (key) {
      case 'Path': cur.path = value; break;
      case 'Size': cur.size = Number(value) || 0; break;
      case 'Packed Size': cur.packedSize = Number(value) || 0; break;
      case 'Modified': cur.modified = value; break;
      case 'Folder': cur.folder = value.trim() === '+'; break;
      case 'Encrypted': cur.encrypted = value.trim() === '+'; break;
      case 'CRC': cur.crc = value; break;
      case 'Method': cur.method = value; break;
      case 'Attributes': cur.attributes = value; break;
      default: break;
    }
  }
  pushCur();
  return entries;
}

/** 从 `7z l -slt` 的完整输出里取归档元信息（Type / Physical Size / Method） */
export function parseArchiveMeta(text) {
  const meta = { type: '', physicalSize: 0, headersSize: 0, method: '', solid: false, volumes: 0 };
  const { metaText } = splitListOutput(text);
  for (const raw of metaText.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf(' = ');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 3);
    if (key === 'Type') meta.type = value;
    else if (key === 'Physical Size') meta.physicalSize = Number(value) || 0;
    else if (key === 'Headers Size') meta.headersSize = Number(value) || 0;
    else if (key === 'Method') meta.method = value;
    else if (key === 'Solid') meta.solid = value === '+';
    else if (key === 'Volumes') meta.volumes = Number(value) || 0;
  }
  return meta;
}

/**
 * 错误信息翻译：把 7-Zip 的英文/系统报错转成给普通用户看的中文。
 * 顺序敏感：密码类判定必须在通用兜底之前。
 */
export function translateSevenZipError({ code, stdout = '', stderr = '' } = {}) {
  const all = `${stderr}\n${stdout}`;
  if (/Cannot open encrypted archive|Wrong password|Data Error in encrypted file|CRC Failed/i.test(all)) {
    return '密码错误（或该压缩包已加密，请填写正确密码）';
  }
  if (/is not supported|Unsupported Method|Can not open the file as/i.test(all) && /archive/i.test(all)) {
    return '无法识别或该压缩包使用了不支持的算法';
  }
  if (/cannot find the file|系统找不到指定的文件|The system cannot find/i.test(all)) {
    return '找不到文件（可能已被移动或删除）';
  }
  if (/Access is denied|拒绝访问|being used by another process|另一个程序正在使用/i.test(all)) {
    return '没有访问权限（文件可能被占用或只读）';
  }
  if (/not enough space|磁盘空间不足|There is not enough space/i.test(all)) {
    return '磁盘空间不足';
  }
  if (code === 255) {
    return '操作被中断（压缩包可能需要密码，或进程被取消）';
  }
  const tail = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
  return tail ? tail.slice(0, 200) : `7-Zip 退出码 ${code}`;
}

/**
 * 路径安全：条目路径含 `..` 段或为绝对路径（含盘符 / 以 / 开头）视为可疑（zip-slip 防护）。
 * 返回可疑条目列表。
 */
export function findSuspiciousEntries(entries) {
  const bad = [];
  for (const e of entries || []) {
    const p = String(e && e.path ? e.path : '').replace(/\\/g, '/');
    if (!p) continue;
    const isAbsolute = /^[a-zA-Z]:/.test(p) || p.startsWith('/');
    const hasDotDot = p.split('/').some((seg) => seg === '..');
    if (isAbsolute || hasDotDot) bad.push(e);
  }
  return bad;
}

/**
 * 从 `-bsp1` 进度输出里解析百分比。
 * 7-Zip 的进度是「覆盖式」输出的（\b 回退 + 重复的 `NN%`），所以从缓冲末尾取最后一个百分比。
 */
export function parseProgressPercent(buffer) {
  const matches = String(buffer || '').match(/(\d{1,3})%/g);
  if (!matches || !matches.length) return null;
  const last = matches[matches.length - 1];
  const n = parseInt(last, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

/**
 * 从 7-Zip 的收尾统计里读「真正解出来几个文件」。
 * 为什么需要它：`-aos`（跳过已存在）遇到目标文件都已存在时会**一个都不解**却仍然退出码 0、
 * 打印 Everything is Ok —— 只看退出码会把「什么都没做」误报成「解压成功」；
 * 密码错误时更糟：用户会以为密码是对的（踩过：错误密码被判成解压成功）。
 */
export function parseExtractCounts(text) {
  const t = String(text || '');
  const files = /Files:\s*(\d+)/.exec(t);
  const folders = /Folders:\s*(\d+)/.exec(t);
  return {
    files: files ? Number(files[1]) : null,
    folders: folders ? Number(folders[1]) : null
  };
}

/** 从 `-bb1` 输出里取当前正在处理的条目名（`+ path` 或 `- path` 行；取最后一个） */
export function parseCurrentEntry(buffer) {
  const lines = String(buffer || '').split(/[\r\n\b]+/);
  let name = '';
  for (const raw of lines) {
    const m = /^\s*[+-]\s+(.+?)\s*$/.exec(raw);
    if (m) name = m[1];
  }
  return name;
}

/**
 * 「两趟解压」判定：复合格式（tar.gz 等）先用 7-Zip 解外层得到 .tar，再解这个 tar。
 * 传入解压目录当前的文件名列表，返回需要继续处理的 .tar 文件（没有则 null）。
 * @param {string} archiveExt 原压缩包扩展名（用于确认是 tar.* 家族）
 * @param {string[]} names    解压后目录里的条目名
 */
export function findInnerTar(archiveExt, names) {
  if (!isTarFlavored(archiveExt)) return null;
  const tars = (names || []).filter((n) => /\.tar$/i.test(n));
  return tars.length === 1 ? tars[0] : null;
}

/** 是否为复合格式（tar.gz 等需要两趟）；供测试与界面提示用 */
export function needsSecondPass(archiveExt) {
  return isTarFlavored(archiveExt);
}

/**
 * 多文件压缩时的「多条目」判定：流式单文件格式（gzip / bzip2 / xz / zst / br）只接受 1 个文件。
 * 复合格式（tar.*）不受限（先打成 tar）。
 */
export function checkSingleEntryOnly(fmt, entryCount) {
  if (!fmt) return { ok: false, message: '未知格式' };
  const streaming = ['gzip', 'bzip2', 'xz', 'zst', 'br'].includes(fmt.id);
  if (streaming && entryCount > 1) {
    return {
      ok: false,
      message: `${fmt.name} 是单文件格式，不能直接压多个文件；请选 TAR.${fmt.id.toUpperCase()} 或 ZIP / 7Z`
    };
  }
  return { ok: true };
}

/** 把级别 id 归一（未知 → normal） */
export function normalizeLevel(id) {
  return LEVELS.some((l) => l.id === id) ? id : 'normal';
}

/** 全大写显示名（界面/错误信息里用） */
export function formatLabel(fmt) {
  return fmt ? `${fmt.name}（${fmt.ext}）` : '未知格式';
}

export { isCompound };