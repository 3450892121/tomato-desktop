// 工具注册表 —— 全软件唯一的工具清单
// ★ 新增工具时，只需：① 复制 src/tools/_template/ 改名为新工具；② 在这里加两行（import + 数组）。
// 详见 docs/新增工具指南.md
import obfuscate from '../tools/obfuscate/index.js';
import pdfConvert from '../tools/pdf-convert/index.js';
import compress from '../tools/compress/index.js';
import enhance from '../tools/enhance/index.js';
import imgConvert from '../tools/convert/index.js';
import videoConvert from '../tools/video-convert/index.js';
import videoCompress from '../tools/video-compress/index.js';
import sticker from '../tools/sticker/index.js';
import audioConvert from '../tools/audio-convert/index.js';
import audioEdit from '../tools/audio-edit/index.js';
import transcribe from '../tools/transcribe/index.js';

/**
 * 左侧导航分组（按此顺序显示；工具声明里的 group 对应这里的 id）。
 * 分组的目的：让同类工具聚在一起、更好找（用户要求：图片一类、视频一类）。
 * 每个分组是一条可点击的标题：点一下收起/展开该组的工具，收起状态会记住（见 settings.collapsedGroups）。
 */
export const GROUPS = [
  { id: 'image', name: '图片', icon: '🖼️' },
  { id: 'video', name: '视频', icon: '🎬' },
  { id: 'audio', name: '音频', icon: '🎵' },
  { id: 'doc', name: '文档', icon: '🗂️' }
];

/** 所有工具（左侧按 GROUPS 分组显示，组内按 order 升序） */
export const TOOLS = [
  obfuscate,
  pdfConvert,
  compress,
  enhance,
  imgConvert,
  videoConvert,
  videoCompress,
  sticker,
  audioConvert,
  audioEdit,
  transcribe
];