// 模式定义（静态数据，与手机版 APK 的 algorithm_modes / algorithm_values 一一对应）
// keyType：none=不需要密钥（界面隐藏密钥行）；string=字符串密钥；double=0~1 小数密钥
export const MODES = [
  { id: 'gilbert', label: '空间曲线混淆 (番茄图)', keyType: 'none',   saveFormat: 'jpg', jpegQuality: 95 },
  { id: 'b',       label: '方块混淆 (B)',        keyType: 'string', saveFormat: 'png', blockSize: 32 },
  { id: 'c',       label: '像素混淆 (C)',        keyType: 'string', saveFormat: 'png' },
  { id: 'c2',      label: '行像素混淆 (C2)',     keyType: 'string', saveFormat: 'png' },
  { id: 'pe1',     label: '兼容PE: 行模式 (PE1)', keyType: 'double', saveFormat: 'png' },
  { id: 'pe2',     label: '兼容PE: 行+列 (PE2)',  keyType: 'double', saveFormat: 'png' }
];

// 手机版输入框默认值（APK 布局中 android:text="0.666"）
export const DEFAULT_DOUBLE_KEY = '0.666';

/** 按内部标识取模式定义 */
export function getMode(id) {
  return MODES.find((m) => m.id === id) || MODES[0];
}