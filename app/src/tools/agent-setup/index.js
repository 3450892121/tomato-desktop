// 工具：Agent 接入（从界面点一下 = 跑随包的一键脚本；见 spec/modules/agent-mcp.md）
import { mount, unmount, activate, deactivate } from './ui.js';

export default {
  id: 'agent-setup',
  name: 'Agent 接入',
  icon: '🤖',
  group: 'system',
  order: 20,
  styles: ['../tools/agent-setup/styles.css'],
  mount,
  unmount,
  activate,
  deactivate
};
