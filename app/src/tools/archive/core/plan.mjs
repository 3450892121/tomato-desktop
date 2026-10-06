// 「压缩 / 解压」作业计划（纯逻辑，可单测）
// 作用：把界面上的「一堆文件/文件夹 + 参数」翻译成主进程要执行的**步骤清单**，
//       并统一负责命名（压缩包基名、解压目录名、分卷首卷名）等容易出错的细节。
// 约定：本文件不碰文件系统，只做纯计算；路径拼接统一用 Windows 反斜杠（本软件只出 Windows 产物）。
import {
  formatById, supportsVolume, supportsPassword, isCompound, compoundOuter,
  formatByExt, extractOnlyByExt, firstVolumeName
} from './formats.mjs';

/** 从路径里取文件名（兼容 / 与 \） */
export function baseNameOf(p) {
  const s = String(p || '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/** 取所在目录（不含末尾分隔符）；无目录返回空串 */
export function dirNameOf(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : '';
}

function joinPath(dir, name) {
  const d = String(dir || '').replace(/[\\/]+$/, '');
  return d ? `${d}\\${name}` : name;
}

/** 已知压缩包后缀（长的在前，保证 .tar.gz 先于 .gz 匹配） */
const ARCHIVE_SUFFIXES = [
  '.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tar.br',
  '.tar', '.zip', '.7z', '.gz', '.bz2', '.xz', '.zst', '.br',
  '.rar', '.cab', '.iso', '.arj', '.lzh', '.cpio', '.wim', '.msi', '.deb', '.rpm',
  '.chm', '.dmg', '.xar', '.udf', '.vhd', '.vmdk', '.squashfs', '.exe', '.apk', '.jar'
];

/** 去掉已知压缩包后缀；不认识的后缀按「去掉最后一段扩展名」处理 */
export function stripArchiveExt(fileName) {
  const n = String(fileName || '');
  const lower = n.toLowerCase();
  for (const suf of ARCHIVE_SUFFIXES) {
    if (lower.endsWith(suf)) return n.slice(0, n.length - suf.length);
  }
  return n.replace(/\.[^.]+$/, '');
}

/** 流式单文件格式：只能压一个文件、不能压文件夹（复合格式 tar.* 不受限） */
const STREAMING_IDS = ['gzip', 'bzip2', 'xz', 'zst', 'br'];

/**
 * 压缩包默认基名。
 * · 单文件流式格式（GZIP/BZIP2/XZ/ZSTD/BROTLI）：**保留原文件名**（a.txt → a.txt.gz）。
 *   原因：这些格式（除 gzip 的 FNAME 外）不存原文件名，解压时只能从压缩包名反推；
 *   保留原名才能让用户解压后拿回 `a.txt` 而不是没后缀的 `a`（实测 7-Zip 就是这么干的）。
 * · 单个文件夹 → 文件夹名；单个文件 → 文件名去扩展名；多个 → 第一个的名字去掉扩展名。
 */
export function suggestArchiveBase(inputs = [], fmt) {
  const first = inputs[0];
  if (!first) return '压缩包';
  const nm = baseNameOf(first.path || '');
  if (fmt && STREAMING_IDS.includes(fmt.id) && inputs.length === 1 && !first.isDirectory) return nm;
  if (inputs.length > 1) return nm.replace(/\.[^.]+$/, '') || '压缩包';
  if (first.isDirectory) return nm;
  return nm.replace(/\.[^.]+$/, '') || nm;
}

/** 压缩包默认文件名（含扩展名），如 照片.zip / 备份.tar.gz / a.txt.gz */
export function suggestArchiveName(inputs = [], fmt) {
  return `${suggestArchiveBase(inputs, fmt)}${fmt ? fmt.ext : '.zip'}`;
}

/**
 * 校验一组输入能否用某格式压缩，返回 {ok, message}
 */
export function validateCreate({ formatId, inputs = [], password, encrypt } = {}) {
  const fmt = formatById(formatId);
  if (!fmt) return { ok: false, message: '请选择压缩格式' };
  if (fmt.password === undefined) {
    return { ok: false, message: `${fmt.name} 只能解压，不能压缩${fmt.note ? `（${fmt.note}）` : ''}` };
  }
  if (inputs.length === 0) return { ok: false, message: '请先添加要压缩的文件或文件夹' };

  if (STREAMING_IDS.includes(fmt.id)) {
    if (inputs.length > 1) {
      return {
        ok: false,
        message: `${fmt.name} 是单文件格式，不能压多个文件；多文件请选 TAR.${fmt.id.toUpperCase()}、ZIP 或 7Z`
      };
    }
    if (inputs[0].isDirectory) {
      return {
        ok: false,
        message: `${fmt.name} 只能压单个文件，不能压文件夹；文件夹请选 TAR.${fmt.id.toUpperCase()}、ZIP 或 7Z`
      };
    }
  }

  if (password) {
    if (!fmt.password) {
      return { ok: false, message: `${fmt.name} 不支持密码保护（支持密码的只有 7Z 与 ZIP）` };
    }
    const scheme = fmt.password === 'zip' ? (encrypt === 'zipcrypto' ? 'zipcrypto' : 'zip-aes256') : fmt.password;
    if (!supportsPassword(fmt, scheme)) {
      return { ok: false, message: `${fmt.name} 不支持该密码方案` };
    }
    // 实测限制：7-Zip 给 ZIP 加非 ASCII（中文等）密码会直接报「参数错误」，压不出文件。
    // 7Z 容器没有这个问题（AES-256 + UTF-16 密码正常工作），所以给出明确的改法建议。
    if (fmt.password === 'zip' && !isAscii(password)) {
      return {
        ok: false,
        message: 'ZIP 的密码只能是英文、数字和常见符号（7-Zip 限制，中文密码会报错）；'
          + '请改用 7Z 格式（支持中文密码），或把密码换成纯英文/数字'
      };
    }
  }
  return { ok: true };
}

/** 是否纯 ASCII（ZIP 加密密码的可用范围） */
export function isAscii(s) {
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) {
    if (str.charCodeAt(i) > 127) return false;
  }
  return true;
}

/**
 * 生成压缩作业步骤（每个步骤 = 一次 7-Zip 或 Node 调用）。
 *
 * 步骤 schema：
 *   { kind:'7z',   action:'create',  target, names?, cwd, overrideType?, formatId, level, password, encrypt, volumeBytes, label }
 *   { kind:'7z',   action:'compress', src, target, engine, level, label }        ← 复合格式的外层（gzip/bzip2/xz）
 *   { kind:'node', action:'compress', src, target, engine, level, label }        ← zst / br（Node 内置 zlib）
 *
 * @param {object} o
 * @param {Array<{path:string,isDirectory:boolean}>} o.inputs 待压缩项（可为文件或文件夹）
 * @param {string} o.formatId  formats.mjs 的 id
 * @param {string} [o.level]   级别 id
 * @param {string} [o.password]
 * @param {string} [o.encrypt] zip 加密方案：'zip-aes256' | 'zipcrypto'
 * @param {number} [o.volumeBytes]
 * @param {string} o.outputDir 输出目录
 * @param {string} [o.baseName] 已解决重名的基名（主进程用 uniqueTargetPath 保证不覆盖）
 * @param {string} o.tempDir   中间文件目录（复合格式的 .tar 放这里，避免污染输出目录）
 */
export function buildCreatePlan({
  inputs = [], formatId, level = 'normal', password = '', encrypt = 'zip-aes256',
  volumeBytes = 0, outputDir, baseName, tempDir
} = {}) {
  const check = validateCreate({ formatId, inputs, password, encrypt });
  if (!check.ok) return check;

  const fmt = formatById(formatId);
  const base = baseName || suggestArchiveBase(inputs, fmt);
  // 输出目录缺省 = 源文件所在目录（「存在原文件旁边」的项目约定）。
  // 必须落成**绝对路径**：7-Zip 的 cwd 是各来源目录，相对路径会写到那个目录里去，
  // 主进程再按相对路径找产物就找不到了（踩过：压缩完成但没有找到产物文件）。
  const outDir = outputDir || dirNameOf(inputs[0].path);
  const archivePath = joinPath(outDir, `${base}${fmt.ext}`);

  // 各组：7-Zip 的 cwd 只能有一个，所以按「所在目录」分组，每组一次调用（条目名用相对名）
  const byDir = new Map();
  for (const item of inputs) {
    const dir = item.isDirectory ? dirNameOf(item.path) : dirNameOf(item.path);
    const nm = baseNameOf(item.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(nm);
  }

  if (!isCompound(fmt)) {
    const steps = [];
    let first = true;
    for (const [dir, names] of byDir) {
      steps.push({
        kind: fmt.engine === 'node' ? 'node' : '7z',
        action: 'create',
        target: archivePath,
        names,
        cwd: dir,
        formatId: fmt.id,
        level,
        password,
        encrypt,
        volumeBytes: supportsVolume(fmt) ? Number(volumeBytes) || 0 : 0,
        // 多组时只有第一组新建、其余追加（7-Zip 的 a 命令天然是追加，无需区分）；
        // 但 Node 流式格式不支持追加，必须恰好一组（上面 validateCreate 已保证）
        label: `${first ? '压缩' : '追加'}为 ${fmt.name}`
      });
      first = false;
    }
    return { ok: true, archivePath, steps, groupedDirs: byDir.size };
  }

  // 复合格式（tar.gz / tar.bz2 / tar.xz / tar.zst / tar.br）：先打 tar，再压外层
  const outer = compoundOuter(fmt);
  const innerName = `${base}.tar`;
  const innerPath = joinPath(tempDir || outDir, innerName);
  const steps = [];
  let first = true;
  for (const [dir, names] of byDir) {
    steps.push({
      kind: '7z',
      action: 'create',
      target: innerPath,
      names,
      cwd: dir,
      overrideType: 'tar', // 关键：不能用 -ttar 直接写 .tar.gz（实测只会得到纯 tar）
      formatId: 'tar',
      level: 'store',
      password: '',
      encrypt: '',
      volumeBytes: 0,
      label: first ? '先打包为 TAR' : '追加到 TAR'
    });
    first = false;
  }
  steps.push({
    kind: outer === 'zst' || outer === 'br' ? 'node' : '7z',
    action: 'compress',
    src: innerPath,
    target: archivePath,
    engine: outer,
    // 外层压缩时条目名要用「文件名」而不是全路径（否则包内会出现完整目录结构）
    name: innerName,
    level,
    label: `再用 ${outer.toUpperCase()} 压缩`
  });
  return { ok: true, archivePath, steps, innerTar: innerPath, groupedDirs: byDir.size };
}

/** 校验解压参数 */
export function validateExtract({ archives = [], password } = {}) {
  if (!archives || archives.length === 0) return { ok: false, message: '请先添加要解压的压缩包' };
  if (password && String(password).length > 200) return { ok: false, message: '密码过长（最多 200 个字符）' };
  return { ok: true };
}

/**
 * 生成解压作业步骤（每个压缩包一个；分卷只指向第一卷）。
 * archive = { path, name?, ext?, isDirectory? }
 */
export function buildExtractPlan({ archives = [], outputDir, password = '', overwrite = 'skip', tree = 'keep' } = {}) {
  const check = validateExtract({ archives, password });
  if (!check.ok) return check;

  const steps = archives.map((a) => {
    const name = a.name || baseNameOf(a.path);
    const ext = a.ext || (/\.[^.]+$/.exec(name) || [''])[0];
    const folder = stripArchiveExt(name) || '解压结果';
    const dir = outputDir ? joinPath(outputDir, folder) : joinPath(dirNameOf(a.path), folder);
    const only = extractOnlyByExt(ext);
    return {
      kind: '7z',
      action: 'extract',
      source: a.path,
      outputDir: dir,
      password,
      overwrite,
      flatten: tree === 'flatten',
      label: `解压 ${name}`,
      note: only ? `${only.name} 仅解压` : '',
      // 复合格式（tar.gz 等）需要第二趟：先把外层解出 .tar，再解这个 tar
      secondPass: true
    };
  });
  return { ok: true, steps };
}

/** 扩展名 → 双向格式（解压时用来判断是否需要第二趟等） */
export function archiveFormatOf(ext) {
  return formatByExt(ext);
}

/** 分卷首卷名（主进程在解压前用它判断文件是否存在） */
export { firstVolumeName };

/** 压缩率文案：`-63%` / `+4%` */
export function ratioText(inBytes, outBytes) {
  const a = Number(inBytes) || 0;
  const b = Number(outBytes) || 0;
  if (!a) return '';
  const pct = (1 - b / a) * 100;
  return `${pct >= 0 ? '-' : '+'}${Math.abs(pct).toFixed(0)}%`;
}

/** 人类可读体积 */
export function humanBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}