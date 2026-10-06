// 设置键白名单与值校验（纯逻辑，无 Electron / DOM 依赖）
// 为什么放这里：主进程的 settings:import（防恶意设置文件把任意值写进配置）与
// 界面共享层需要同一份清单——原先 KNOWN_KEYS 写在 main.js 里、与 shared/settings.js
// 的 DEFAULT_SETTINGS 双头维护，容易漂移（v2.8.1 起统一到本模块）。
// 单测见 tests/settingsschema.test.mjs（挂 npm test）。

/** 认识的设置键（与 DEFAULT_SETTINGS 的键一致；顺序无关） */
export const KNOWN_SETTINGS_KEYS = [
  'blockSize',        // 方块混淆 B 模式的方块数：整数 2~256
  'jpegQuality',      // gilbert 模式存 JPG 的画质：整数 1~100
  'defaultDoubleKey', // PE1/PE2 默认密钥：字符串，数值须在 0~1 开区间
  'outputDir',        // 输出目录：字符串（空 = 保存在原图旁边）
  'askSavePath',      // 保存前询问路径：布尔
  'collapsedGroups',  // 侧栏被收起的分组：null（没设置过）或字符串数组
  'navOrder',         // 导航手动排序：null（没排过）或对象（结构由 navsort.computeNavPlan 净化）
  'theme',            // 外观：'system' | 'light' | 'dark'
  'videodlDir',       // 视频下载保存目录：字符串（空 = 默认 下载\视频素材）
  'videodlAutoCheck'  // 视频下载：每周自动检查引擎更新：布尔（默认开）
];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 校验一个已知键的值。
 * @returns {{ok:true, value:any}} 合法（value 为原值；当前不做改写，只判定）
 * @returns {{ok:false, reason:string}} 非法（调用方应忽略该键，像未知键一样跳过）
 */
export function validateSettingValue(key, value) {
  switch (key) {
    case 'blockSize':
      if (!Number.isInteger(value) || value < 2 || value > 256) {
        return { ok: false, reason: '方块数需为 2~256 之间的整数' };
      }
      return { ok: true, value };
    case 'jpegQuality':
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        return { ok: false, reason: 'JPG 画质需为 1~100 之间的整数' };
      }
      return { ok: true, value };
    case 'defaultDoubleKey': {
      if (typeof value !== 'string') return { ok: false, reason: '默认密钥必须是文本' };
      const k = Number(value);
      if (!Number.isFinite(k) || k <= 0 || k >= 1) {
        return { ok: false, reason: '默认密钥需为 0 到 1 之间的小数' };
      }
      return { ok: true, value };
    }
    case 'outputDir':
      if (typeof value !== 'string') return { ok: false, reason: '输出目录必须是文本' };
      return { ok: true, value };
    case 'askSavePath':
      if (typeof value !== 'boolean') return { ok: false, reason: '「保存前询问」必须是开关值' };
      return { ok: true, value };
    case 'collapsedGroups':
      if (value === null) return { ok: true, value };
      if (!Array.isArray(value) || value.some((g) => typeof g !== 'string')) {
        return { ok: false, reason: '分组收起状态格式不对' };
      }
      return { ok: true, value };
    case 'navOrder':
      if (value === null) return { ok: true, value };
      // 结构合法性交给 navsort.computeNavPlan 净化（回退默认、不丢工具），
      // 这里只挡「根本不是对象」的值，避免把字符串/数组当对象展开。
      if (!isPlainObject(value)) return { ok: false, reason: '导航排序格式不对' };
      return { ok: true, value };
    case 'theme':
      if (value !== 'system' && value !== 'light' && value !== 'dark') {
        return { ok: false, reason: '外观取值只能是 system / light / dark' };
      }
      return { ok: true, value };
    case 'videodlDir':
      if (typeof value !== 'string') return { ok: false, reason: '下载保存目录必须是文本' };
      return { ok: true, value };
    case 'videodlAutoCheck':
      if (typeof value !== 'boolean') return { ok: false, reason: '「自动检查引擎更新」必须是开关值' };
      return { ok: true, value };
    default:
      return { ok: false, reason: '未知设置项' };
  }
}

/**
 * 从「待导入的 settings 对象」里挑出合法的已知键。
 * @param {object} incoming 导入文件里的 settings 字段
 * @returns {{patch:object, applied:string[], skipped:Array<{key:string, reason:string}>}}
 *   patch 只含通过校验的键；skipped 记录被跳过的键与原因（界面如实提示，不静默丢弃）。
 */
export function pickImportableSettings(incoming) {
  const patch = {};
  const applied = [];
  const skipped = [];
  const source = isPlainObject(incoming) ? incoming : {};
  for (const key of KNOWN_SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const v = validateSettingValue(key, source[key]);
    if (v.ok) {
      patch[key] = v.value;
      applied.push(key);
    } else {
      skipped.push({ key, reason: v.reason });
    }
  }
  return { patch, applied, skipped };
}
