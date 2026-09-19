// 工具：批量重命名 —— 纯逻辑（不碰 DOM / window，可用 node 直接单测）
// 职责：规则计算（序号 / 查找替换 / 加前后缀 / 按日期）、文件名合法性校验、整批改名计划与冲突检出。
// 真正的落盘改名在主进程（fs:rename-batch，两阶段改名 + 绝不覆盖已存在文件）。

/** 规则类型清单（界面下拉用） */
export const RENAME_MODES = [
  { value: 'seq', label: '序号（001、002…）' },
  { value: 'replace', label: '查找替换' },
  { value: 'affix', label: '加前缀后缀' },
  { value: 'date', label: '按日期' }
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
 * 生成整批改名计划（界面预览与执行都用它）。
 * @param {object} args
 * @param {Array<{path:string,name?:string,baseName?:string,ext?:string,mtimeMs?:number}>} args.items
 * @param {object} args.rule 见 applyRule
 * @param {string[]} [args.existingPaths] 目标目录里**已经存在**的文件（用来检出「目标文件已存在」）
 * @returns {{
 *   renames: Array<{from:string,to:string}>,
 *   previews: Array<{from:string,fromName:string,toName:string,to:string,ok:boolean,reason:string}>,
 *   conflicts: Array<object>, errors: Array<{from:string,message:string}>,
 *   okCount:number, conflictCount:number
 * }}
 */
export function buildRenamePlan({ items = [], rule = {}, existingPaths = [] } = {}) {
  const list = Array.isArray(items) ? items : [];
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
    try {
      toName = applyRule({ baseName, ext, index, rule: { ...rule, mtimeMs: it && it.mtimeMs } });
    } catch (err) {
      reason = `规则无效：${String((err && err.message) || err)}`;
      errors.push({ from, message: reason });
    }
    previews.push({
      from,
      fromName,
      toName,
      to: joinPath(dirNameOf(from), toName),
      ok: !reason,
      reason
    });
  });

  // 第 1 遍：文件名合法性 / 名字没变 / 目标已被别的文件占用
  for (const p of previews) {
    if (!p.ok) continue;
    const v = validateFileName(p.toName);
    if (!v.ok) { p.ok = false; p.reason = v.reason; continue; }
    if (p.toName === p.fromName) { p.ok = false; p.reason = '名称没有变化（已跳过）'; continue; }
    const key = pathKey(p.to);
    // 目标已存在，但它本身是本批要改名的源文件 → 允许（两阶段改名会保证不互相踩）
    if (!sources.has(key) && existing.has(key)) { p.ok = false; p.reason = '目标文件已存在'; }
  }

  // 第 2 遍：批内重名（两条改成同一个名字）
  const byTarget = new Map();
  for (const p of previews) {
    if (!p.ok) continue;
    const key = pathKey(p.to);
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(p);
  }
  for (const group of byTarget.values()) {
    if (group.length < 2) continue;
    for (const p of group) { p.ok = false; p.reason = '与本批其它文件改成了同一个名字'; }
  }

  const renames = previews.filter((p) => p.ok).map((p) => ({ from: p.from, to: p.to }));
  const conflicts = previews.filter((p) => !p.ok);
  return {
    renames,
    previews,
    conflicts,
    errors,
    okCount: renames.length,
    conflictCount: conflicts.length
  };
}
