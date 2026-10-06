// 工具：软件卸载（启动随包内置的 HiBit Uninstaller，管理员权限；见 spec/modules/uninstall.md）
import { mount, unmount, activate, deactivate } from './ui.js';

export default {
  id: 'uninstall',      // 唯一标识
  name: '软件卸载',      // 左侧列表显示名
  icon: '🧹',           // 列表图标
  group: 'system',      // 左侧分组：系统（GROUPS 里的 system）
  order: 10,            // 组内排序
  styles: ['../tools/uninstall/styles.css'],
  mount,
  unmount,
  activate,
  deactivate
};