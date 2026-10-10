## 概述

本项目是一个 Electron 桌面应用，所有运行时配置（用户偏好、工具默认值、主题、路径等）通过一个轻量自研的「设置」子系统管理：前端 `src/shared/settings.js` 暴露 `loadSettings/getSettings/updateSettings/resetSettings`，主进程 `main.js` 提供 `ipcMain.handle('settings:*')` 通道，持久化为绿色版目录下的 `userdata/settings.json`。导入/导出格式由主进程构造 JSON 文件，并通过 `src/shared/settings-schema.mjs` 进行键白名单 + 值校验。

## 关键文件

- `app/src/shared/settings.js` — 渲染进程侧的设置 API（内存缓存 + IPC 调用）
- `app/src/shared/settings-schema.mjs` — 设置键白名单与逐键值校验器（纯逻辑，无 Electron/DOM 依赖）
- `app/main.js` — 主进程 IPC 处理器（`settings:read` / `settings:write` / `settings:export` / `settings:import`）、`USER_DATA_DIR` / `SETTINGS_FILE` 常量、测试模式还原逻辑
- `app/tests/settingsschema-test.js`、`app/tests/settingsschema.test.mjs` — schema 单元测试
- `spec/spec/modules/settings.md`、`spec/spec/modules/settings-io.md` — 规格文档

## 架构与约定

1. **绿色版（便携）优先**：`main.js` 把 `app.setPath('userData', USER_DATA_DIR)` 指向软件目录下的 `userdata/`，而非系统 AppData；注释明确“整个文件夹拷走即带走设置”。配置文件固定为 `userdata/settings.json`。
2. **分层 IPC**：渲染进程不直接读写磁盘，而是通过 `window.desktop.settingsRead()` / `settingsWrite()`（由 preload 桥接）→ `ipcMain.handle('settings:read|write')` → 主进程 `fs.readFile/writeFile`。
3. **内存缓存 + 懒加载**：`settings.js` 维护单例 `current`，`loadSettings()` 仅在首次调用时从磁盘读取，后续 `getSettings()` 同步返回副本；`reloadSettings()` 用于导入后强制刷新。
4. **默认值合并策略**：每次读盘都执行 `{ ...DEFAULT_SETTINGS, ...(saved || {}) }`，即默认值永远作为基底，磁盘只覆盖有值的字段——新增字段不会破坏旧版本配置。
5. **写入幂等**：`updateSettings(patch)` 先改内存，再 IPC 落盘；即使写盘失败也不回滚内存，保证界面可用（注释说明“落盘失败时仍保留内存中的值”）。
6. **导入/导出结构**：导出 JSON 包含 `_app`、`_format: 1`、`_exportedAt`、`_appVersion`、`settings` 五个顶层字段，主进程在 `settings:export` 中硬编码构造，`settings:import` 严格检查 `parsed.settings` 存在且为对象。
7. **安全白名单**：导入流程通过 `settings-schema.mjs` 的 `pickImportableSettings` 过滤：未知键一律忽略，已知键的值经 `validateSettingValue` 类型+范围校验；非法项记录到 `skipped` 并提示用户，不静默丢弃。
8. **测试模式保护**：`main.js` 检测 `--settingsio-test` 参数后，启动时快照 `settings.json`，`will-quit` 原样写回或删除，避免 UI 自动化测试污染用户真实配置。

## 已实现的设置项（DEFAULT_SETTINGS）

| 键 | 类型 | 默认值 | 含义 |
|---|---|---:|---|
| `blockSize` | number | 32 | 方块混淆 B 模式方块数 |
| `jpegQuality` | number | 95 | Gilbert 模式 JPG 画质 |
| `defaultDoubleKey` | string | '0.666' | PE1/PE2 输入框默认密钥 |
| `outputDir` | string | '' | 输出目录（空=与原图同目录） |
| `askSavePath` | boolean | false | 保存前询问路径 |
| `collapsedGroups` | null|string[] | null | 左侧导航收起分组 |
| `navOrder` | null|object | null | 左侧导航手动排序 |
| `theme` | enum | 'system' | 'system'/'light'/'dark' |
| `videodlDir` | string | '' | 视频下载保存目录 |
| `videodlAutoCheck` | boolean | true | 每周自动检查引擎更新 |

## 约束与规则

- **持久化位置不可变**：所有运行期数据必须落在 `path.join(PORTABLE_DIR, 'userdata', 'settings.json')`（`main.js` L134），不得写系统 AppData。
- **IPC 是唯二入口**：渲染进程只能通过 `window.desktop.settingsRead` / `settingsWrite` 访问设置，禁止直接 `fs` 操作。（由 preload 桥接 + 渲染进程 CSP 限制共同保证）
- **导入只接受本软件格式**：`settings:import` 要求 JSON 顶层必须有 `settings` 字段且为对象，否则返回 `{ ok:false, message:'这个文件不是本软件导出的设置文件...' }`。
- **导入值必须经 schema 校验**：`main.js` 对 `incoming` 调用 `schema.pickImportableSettings`，仅将 `patch` 合并进当前配置；未知键和非法值被跳过并上报 `skipped` 列表。
- **默认值永不丢失**：`loadSettings` / `reloadSettings` / `updateSettings` 均用 `DEFAULT_SETTINGS` 做基底合并，新增字段自动取默认值。
- **测试模式原子还原**：`testMode()` 为真时，`will-quit` 钩子必须恢复或删除 `settings.json`，防止测试状态泄漏到用户环境（`main.js` L138-L155）。