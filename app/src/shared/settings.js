// 参数设置（共享能力 —— 骨架，持久化待实现）
// 放在 shared/ 的原因：设置是全局的（跨工具），所有工具通过 ctx.settings 读取。
// 目标与规则见 spec/modules/settings.md。
// 说明：渲染进程处于沙箱中，不具备文件读写能力；
//      持久化需经由 preload 暴露的 IPC 由主进程读写软件目录内的配置文件（待实现）。
export const DEFAULT_SETTINGS = {
  blockSize: 32,           // 方块数（b 模式），默认即手机版行为
  jpegQuality: 95,         // gilbert 模式保存 JPG 的画质
  defaultDoubleKey: '0.666', // PE1/PE2 输入框默认值（手机版一致）
  outputDir: '',           // 空字符串 = 与原图同目录
  askSavePath: false       // 保存前是否询问路径（默认否，傻瓜化）
};

let current = { ...DEFAULT_SETTINGS };

/** 读取当前设置（骨架：内存版，待接入主进程持久化） */
export function getSettings() {
  return { ...current };
}

/** 更新设置（骨架：内存版，待接入主进程持久化） */
export function updateSettings(patch) {
  current = { ...current, ...patch };
  return { ...current };
}

/** 恢复默认（手机版行为） */
export function resetSettings() {
  current = { ...DEFAULT_SETTINGS };
  return { ...current };
}