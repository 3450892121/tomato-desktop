// 参数设置（共享能力）
// 放在 shared/ 的原因：设置是全局的（跨工具），所有工具通过 ctx.settings 读取。
// 绿色版约定：配置存在软件目录的 userdata/settings.json（整个文件夹拷走即带走设置）。
// 目标与规则见 spec/modules/settings.md。

export const DEFAULT_SETTINGS = {
  blockSize: 32,             // 方块数（b 模式），默认即手机版行为
  jpegQuality: 95,           // gilbert 模式保存 JPG 的画质
  defaultDoubleKey: '0.666', // PE1/PE2 输入框默认值（手机版一致）
  outputDir: '',             // 空字符串 = 与原图同目录
  askSavePath: false,        // 保存前是否询问路径（默认否，傻瓜化）
  // 左侧导航被收起的分组 id 列表（见 spec/modules/toolkit.md）：
  //   null = 用户没设置过 → 用默认行为「全部分组收起，只显示分类标题」；
  //   数组 = 用户明确点过的状态（[] 表示用户把所有分组都展开了）
  collapsedGroups: null,
  // 外观主题（见 spec/modules/theme.md）：
  //   'system' = 跟随系统深浅色（默认，对非技术用户最省心）
  //   'light' / 'dark' = 用户明确指定
  theme: 'system'
};

let current = { ...DEFAULT_SETTINGS };
let loaded = false;

/** 启动时加载一次（从软件目录的配置文件读取，失败则用默认值） */
export async function loadSettings() {
  if (loaded) return { ...current };
  try {
    const saved = await window.desktop.settingsRead();
    current = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  } catch {
    current = { ...DEFAULT_SETTINGS };
  }
  loaded = true;
  return { ...current };
}

/** 读取当前设置（同步，供界面即时使用） */
export function getSettings() {
  return { ...current };
}

/** 更新设置并落盘 */
export async function updateSettings(patch) {
  current = { ...current, ...patch };
  try {
    const saved = await window.desktop.settingsWrite(patch);
    current = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  } catch {
    // 落盘失败时仍保留内存中的值，界面可用
  }
  return { ...current };
}

/** 恢复默认（手机版行为） */
export async function resetSettings() {
  return updateSettings({ ...DEFAULT_SETTINGS });
}