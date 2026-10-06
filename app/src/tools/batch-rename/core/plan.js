// 工具：批量重命名 —— 纯逻辑（不碰 DOM / window，可用 node 直接单测）
// 职责：规则计算（序号 / 查找替换 / 加前后缀 / 按日期）、排序（按修改时间）、文件名合法性校验、
//       整批改名计划与冲突处理（跳过 / 替换 / 自动编号）。
// 真正的落盘改名在主进程（fs:rename-batch，两阶段改名；默认绝不覆盖，界面选「替换」时才带 overwrite 标记）。

/** 规则类型清单（界面下拉用） */
export const RENAME_MODES = [
  { value: 'seq', label: '序号（001、002…）' },
  { value: 'replace', label: '查找替换' },
  { value: 'affix', label: '加前缀后缀' },
  { value: 'date', label: '按日期' }
];

/**
 * 排序方式清单（界面下拉用）。
 * 排序直接决定列表顺序与序号分配（序号规则按此顺序编号）。
 */
export const SORT_MODES = [
  { value: 'none', label: '按添加顺序' },
  { value: 'time-asc', label: '修改时间：旧 → 新' },
  { value: 'time-desc', label: '修改时间：新 → 旧' }
];

/** 命名冲突处理方式清单（界面下拉用） */
export const CONFLICT_MODES = [
  { value: 'skip', label: '跳过不改' },
  { value: 'overwrite', label: '替换已存在文件' },
  { value: 'auto', label: '自动加编号 (1)' }
];

/** Windows 保留文件名（不区分大小写；带扩展名时按去扩展名的基础名判断） */
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
/** Windows 文件名非法字符 */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/;
const MAX_NAME_LENGTH = 255;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 按模板格式化日期。
 * 支持的占位符：YYYY 年 / MM 月 / DD 日 / HH 时 / mm 分 / ss 秒。
 * 日期无效时原样返回模板（避免产出难以理解的名字）。
 * @param {Date|number|string} date
 * @param {string} pattern
 * @returns {string}
 */
export function formatDate(date, pattern) {
  const d = date instanceof Date ? date : new Date(date);
  const p = String(pattern == null ? '' : pattern);
  if (Number.isNaN(d.getTime())) return p;
  const map = {
    YYYY: String(d.getFullYear()),
    MM: pad2(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds())
  };
  return p.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => map[t]);
}

/**
 * 按修改时间排序（稳定排序）。
 * - `none`：原样返回（按添加顺序）；
 * - `time-asc`：旧 → 新；`time-desc`：新 → 旧；
 * - 取不到修改时间（0/非法）的文件一律排在最后，且它们之间保持原顺序；
 * - 时间相同的文件保持原顺序（避免同秒文件被打乱）。
 * @param {Array<{mtimeMs?:number}>} items
 * @param {'none'|'time-asc'|'time-desc'} order
 * @returns {Array} 新数组（不改原数组）
 */
export function sortItems(items, order = 'none') {
  const list = Array.isArray(items) ? items.slice() : [];
  if (order !== 'time-asc' && order !== 'time-desc') return list;
  const dir = order === 'time-asc' ? 1 : -1;
  return list
    .map((it, i) => {
      const t = Number(it && it.mtimeMs);
      return { it, i, t: Number.isFinite(t) && t > 0 ? t : null };
    })
    .sort((a, b) => {
      if (a.t === null && b.t === null) return a.i - b.i; // 都没时间：保持原顺序
      if (a.t === null) return 1;                          // 没时间的沉底
      if (b.t === null) return -1;
      if (a.t !== b.t) return (a.t - b.t) * dir;
      return a.i - b.i;                                    // 同一时刻：保持原顺序
    })
    .map((x) => x.it);
}

/**
 * 把修改时间格式化成列表里显示的「YYYY-MM-DD HH:mm」；取不到时返回空串。
 * @param {number} ms
 * @returns {string}
 */
export function formatDateTime(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  return formatDate(new Date(t), 'YYYY-MM-DD HH:mm');
}

/**
 * 按规则算出新文件名（含扩展名）。
 * @param {object} args
 * @param {string} args.baseName 原名（不含扩展名）
 * @param {string} args.ext 扩展名（可带可不带点）
 * @param {number} args.index 在列表中的序号（从 0 开始）
 * @param {object} args.rule 规则：
 *   { mode:'seq', prefix, start, digits, keepName }  —— keepName=true 时在原名后加序号，否则只用序号
 *   { mode:'replace', find, replace, useRegex }      —— useRegex=true 时 find 当正则（非法正则抛错）
 *   { mode:'affix', prefix, suffix }
 *   { mode:'date', pattern, mtimeMs }                —— mtimeMs 取不到时用当前时间
 * @returns {string} 新文件名（含扩展名）
 */
export function applyRule({ baseName = '', ext = '', index = 0, rule = {} } = {}) {
  const r = rule || {};
  const suffix = ext ? (String(ext).startsWith('.') ? String(ext) : `.${ext}`) : '';
  const name = String(baseName == null ? '' : baseName);

  if (r.mode === 'replace') {
    const find = String(r.find == null ? '' : r.find);
    if (!find) return `${name}${suffix}`;
    const rep = String(r.replace == null ? '' : r.replace);
    // 正则非法时这里会抛错，由 buildRenamePlan 捕获并记为错误项
    const out = r.useRegex ? name.replace(new RegExp(find, 'g'), rep) : name.split(find).join(rep);
    return `${out}${suffix}`;
  }

  if (r.mode === 'affix') {
    return `${r.prefix == null ? '' : r.prefix}${name}${r.suffix == null ? '' : r.suffix}${suffix}`;
  }

  if (r.mode === 'date') {
    const t = Number(r.mtimeMs);
    const d = Number.isFinite(t) && t > 0 ? new Date(t) : new Date();
    return `${formatDate(d, r.pattern == null ? 'YYYY-MM-DD' : r.pattern)}${suffix}`;
  }

  // 默认：序号
  const digits = Math.max(1, Math.min(10, parseInt(r.digits, 10) || 3));
  const start = Number.isFinite(parseInt(r.start, 10)) ? parseInt(r.start, 10) : 1;
  const num = String(start + (Number(index) || 0)).padStart(digits, '0');
  const prefix = r.prefix == null ? '' : String(r.prefix);
  return r.keepName ? `${name}${prefix}${num}${suffix}` : `${prefix}${num}${suffix}`;
}

/**
 * 校验单个文件名是否合法（Windows 规则）。
 * @param {string} name 文件名（含扩展名）
 * @returns {{ok:boolean, reason:string}}
 */
export function validateFileName(name) {
  const n = String(name == null ? '' : name);
  if (!n) return { ok: false, reason: '文件名为空' };
  const illegal = n.match(new RegExp(ILLEGAL_CHARS.source, 'g'));
  if (illegal) {
    return { ok: false, reason: `含 Windows 不允许的字符 ${[...new Set(illegal)].join(' ')}` };
  }
  if (/[\u0000-\u001f]/.test(n)) return { ok: false, reason: '含控制字符' };
  if (n.length > MAX_NAME_LENGTH) return { ok: false, reason: `名字过长（${n.length} 字符，最多 ${MAX_NAME_LENGTH}）` };
  if (/[. ]$/.test(n)) return { ok: false, reason: '名字不能以点或空格结尾' };
  const stem = baseNameOf(n);
  if (RESERVED_NAMES.test(stem)) return { ok: false, reason: `「${stem}」是 Windows 保留名` };
  return { ok: true, reason: '' };
}

/** 取路径的最后一段（文件名，含扩展名） */
function fileNameOf(p) {
  const s = String(p == null ? '' : p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 取路径的目录部分（不含末尾分隔符） */
function dirNameOf(p) {
  const s = String(p == null ? '' : p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(0, i) : '';
}

/** 取扩展名（含点；无扩展名返回空串） */
function extOf(name) {
  const n = String(name == null ? '' : name);
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(i) : '';
}

/** 去扩展名的基础名（与 ctx.pathInfo 的 baseName 同义） */
export function baseNameOf(p) {
  const name = fileNameOf(p);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** 人类可读的体积（列表里显示用） */
export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** 路径比较键：统一分隔符 + 转小写（Windows 文件名不区分大小写） */
function pathKey(p) {
  return String(p == null ? '' : p).replace(/[\\/]+/g, '\\').toLowerCase();
}

/** 拼接目录与文件名（保留原路径使用的分隔符风格） */
function joinPath(dir, name) {
  if (!dir) return name;
  const sep = dir.includes('\\') || !dir.includes('/') ? '\\' : '/';
  return `${dir}${sep}${name}`;
}

/**
 * 在名字后加 `(1)`、`(2)`… 直到不重名（与主进程「另存」的命名习惯一致）。
 * @param {string} name 想要的文件名（含扩展名）
 * @param {(candidate:string)=>boolean} isTaken 判断某个文件名是否已被占用
 * @param {number} [limit] 最多尝试几次
 * @returns {string|null} 可用的文件名；试完仍冲突则返回 null
 */
export function uniqueNameFor(name, isTaken, limit = 9999) {
  const ext = extOf(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i <= limit; i += 1) {
    const candidate = `${stem}(${i})${ext}`;
    if (!isTaken(candidate)) return candidate;
  }
  return null;
}

/**
 * 生成整批改名计划（界面预览与执行都用它）。
 * @param {object} args
 * @param {Array<{path:string,name?:string,baseName?:string,ext?:string,mtimeMs?:number}>} args.items
 *   注意：items 的顺序就是编号顺序（界面会先按「排序方式」排好再传进来）
 * @param {object} args.rule 见 applyRule
 * @param {string[]} [args.existingPaths] 目标目录里**已经存在**的文件（用来检出「目标文件已存在」）
 * @param {'skip'|'overwrite'|'auto'} [args.conflictMode] 命名冲突处理方式（默认 skip）
 * @returns {{
 *   renames: Array<{from:string,to:string,overwrite?:boolean}>,
 *   previews: Array<{from:string,fromName:string,toName:string,to:string,status:string,ok:boolean,reason:string,overwrite:boolean,autoRenamed:boolean}>,
 *   conflicts: Array<object>, errors: Array<{from:string,message:string}>,
 *   okCount:number, skipCount:number, errorCount:number,
 *   conflictCount:number, overwriteCount:number, autoCount:number,
 *   conflictMode:string
 * }}
 */
export function buildRenamePlan({ items = [], rule = {}, existingPaths = [], conflictMode = 'skip' } = {}) {
  const list = Array.isArray(items) ? items : [];
  const mode = CONFLICT_MODES.some((m) => m.value === conflictMode) ? conflictMode : 'skip';
  const existing = new Set((Array.isArray(existingPaths) ? existingPaths : []).map(pathKey));
  const sources = new Set(list.map((it) => pathKey(it && it.path)).filter(Boolean));
  const previews = [];
  const errors = [];

  list.forEach((it, index) => {
    const from = String((it && it.path) || '');
    const fromName = (it && it.name) || fileNameOf(from);
    const baseName = (it && it.baseName) || baseNameOf(from);
    const ext = (it && it.ext) || extOf(fromName);
    let toName = fromName;
    let reason = '';
    let ruleError = false;
    try {
      toName = applyRule({ baseName, ext, index, rule: { ...rule, mtimeMs: it && it.mtimeMs } });
    } catch (err) {
      ruleError = true;
      reason = `规则无效：${String((err && err.message) || err)}`;
      errors.push({ from, message: reason });
    }
    previews.push({
      from,
      fromName,
      toName,
      to: joinPath(dirNameOf(from), toName),
      dir: dirNameOf(from),
      // status：ok = 会改名；skip = 不动这个文件（冲突/名字没问题但没变化）；error = 规则本身有问题
      status: ruleError ? 'error' : 'ok',
      ok: !ruleError,
      reason,
      overwrite: false,
      autoRenamed: false
    });
  });

  // 第 1 遍：文件名合法性 / 名字没变
  for (const p of previews) {
    if (!p.ok) continue;
    const v = validateFileName(p.toName);
    if (!v.ok) { p.ok = false; p.status = 'skip'; p.reason = v.reason; continue; }
    if (p.toName === p.fromName) { p.ok = false; p.status = 'skip'; p.reason = '名称没有变化（已跳过）'; }
  }

  // 目标是否被「本批以外的」文件占用（本批源文件随后会改走，不算占用）
  const occupiedOnDisk = (key) => existing.has(key) && !sources.has(key);

  // 第 2 遍：先登记「没被磁盘占用」的目标名；被占用的按冲突策略分别处理
  const claims = new Map(); // 目标键 → 抢到这个名字的预览项
  for (const p of previews) {
    if (!p.ok) continue;
    const key = pathKey(p.to);
    if (occupiedOnDisk(key) && mode !== 'overwrite') continue; // 留给第 3 遍（跳过 / 自动编号）
    if (!claims.has(key)) claims.set(key, []);
    claims.get(key).push(p);
  }

  // 已分配出去的名字（避免自动编号又撞回来）：磁盘上占着的 + 已登记的
  const taken = new Set();
  for (const k of existing) if (!sources.has(k)) taken.add(k);
  for (const k of claims.keys()) taken.add(k);

  // 第 3 遍：批内两个文件抢同一个名字
  for (const [key, group] of claims) {
    if (group.length < 2) continue;
    if (mode !== 'auto') {
      // 跳过 / 替换模式下两条都不改：替换会让本批文件互相覆盖（数据损坏），宁可拒绝
      for (const p of group) { p.ok = false; p.status = 'skip'; p.reason = '与本批其它文件改成了同一个名字'; }
      claims.set(key, []);
      continue;
    }
    // 自动编号：第一条保留，其余重新编号
    group.slice(1).forEach((p) => { p.needsFix = true; });
    claims.set(key, group.slice(0, 1));
  }

  // 第 4 遍：逐个落实最终名字
  for (const p of previews) {
    if (!p.ok) continue;
    const key = pathKey(p.to);
    const isClaimed = claims.get(key) && claims.get(key).includes(p);
    if (isClaimed) {
      // 名字归它了；「替换」模式下若磁盘上占着，标记 overwrite 交给主进程备份后覆盖
      if (mode === 'overwrite' && occupiedOnDisk(key)) p.overwrite = true;
      continue;
    }
    // 冲突项
    if (mode === 'skip') {
      p.ok = false; p.status = 'skip'; p.reason = '目标文件已存在（按设置跳过）';
      continue;
    }
    if (mode === 'overwrite') { p.overwrite = true; continue; } // 理论上到不了这里（已在上一步放行）
    // 自动编号
    const candidate = uniqueNameFor(p.toName, (name) => taken.has(pathKey(joinPath(p.dir, name))));
    const usable = candidate ? validateFileName(candidate) : { ok: false };
    if (!candidate || !usable.ok) {
      p.ok = false; p.status = 'skip';
      p.reason = `目标「${p.toName}」已存在，自动编号没找到可用名字`;
      continue;
    }
    p.toName = candidate;
    p.to = joinPath(p.dir, candidate);
    p.autoRenamed = true;
    taken.add(pathKey(p.to));
  }

  const renames = previews.filter((p) => p.ok).map((p) => {
    const item = { from: p.from, to: p.to };
    if (p.overwrite) item.overwrite = true; // 主进程据此走「备份 → 覆盖 → 删备份」流程
    return item;
  });
  const conflicts = previews.filter((p) => !p.ok);
  const okPreviews = previews.filter((p) => p.ok);
  return {
    renames,
    previews,
    conflicts,
    errors,
    conflictMode: mode,
    okCount: renames.length,
    conflictCount: conflicts.length,
    skipCount: conflicts.filter((p) => p.status === 'skip').length,
    errorCount: conflicts.filter((p) => p.status === 'error').length,
    overwriteCount: okPreviews.filter((p) => p.overwrite).length,
    autoCount: okPreviews.filter((p) => p.autoRenamed).length
  };
}

/** 排序清单 / 冲突策略清单里的取值是否合法（界面读设置时用） */
export function isSortMode(value) {
  return SORT_MODES.some((m) => m.value === value);
}
