// 兼容性变体开关（★ 与手机版实测后可能需要调整的地方，集中放这里）
//
// 背景：同一套算法在生态里有多个独立实现，个别细节存在差异；手机版 native 库的内部实现
// 无法直接读取，先用下面的默认值，等用与安卓版互通的真机样本实测后锁定。
//
// 1) gilbertRounding —— Gilbert 曲线取整方式
//    'trunc'：向零取整（C++/Rust 编译实现，手机版 native 与 pyscramble 库）
//    'floor'：向下取整（网页版「小番茄」JS 实现）
// 2) blockVariant —— 方块混淆 (B) 的映射写法
//    'py'：与 Python 参考实现 + Rust 库 pyscramble 一致（两者独立实现互相印证）
//    'js'：与网页版 ImageMixer 的 JS 实现一致
// 3) pe1Chaining —— 兼容PE 行模式 (PE1) 的行间序列衔接
//    'single'：全图共用一条混沌序列（网页版 JS 与 Python 参考实现一致）
//    'chained'：每行用上一行序列的最后一个值作初值（PicEncrypt 原版行为）
export const VARIANTS = {
  gilbertRounding: 'trunc',
  blockVariant: 'py',
  pe1Chaining: 'single'
};