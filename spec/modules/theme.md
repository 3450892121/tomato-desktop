# 模块：外观主题（theme）

## 目标
让软件支持浅色 / 深色两套外观，并默认跟随系统；用户切换一次即被记住。深色必须对**所有工具**生效，且工具代码零改动。

## 范围
- 三个档位：`system`（跟随系统，默认）/ `light` / `dark`，存于 `settings.theme`。
- 切换入口两处（都能立即生效，无需重启）：
  - 顶栏右上角胶囊按钮：点一下按「跟随系统 → 浅色 → 深色 → 跟随系统」循环，按钮上显示当前档位。
  - 设置弹窗的「外观」下拉框。
- 持久化：走现有 `settings:read/write`，落在软件目录 `userdata/settings.json`（绿色版约定）。
- 跟随系统：用 `matchMedia('(prefers-color-scheme: dark)')`，系统切换深浅色时实时跟随（仅 `system` 档）。

## 实现约定（关键）
1. **只覆盖同名变量**：`theme.css` 里 `:root` 定义浅色，末尾 `[data-theme="dark"]` 覆盖同一批变量名，**绝不新增变量名**。工具只要按约定引用变量就自动适配。
2. **切换方式**：只改 `<html>` 的 `data-theme` 属性（`light` / `dark`）。不设即浅色。
3. **不闪白**：设置是异步读的，所以启动时先同步按系统偏好上色一次，设置读回后再纠正为用户的明确选择；主进程创建窗口时的 `backgroundColor` 也按 `settings.theme`（或系统偏好）取色。
4. **原生控件跟随**：深色块里设 `color-scheme: dark`，滚动条、下拉框等系统控件才不会突兀地亮一块。
5. **纸张语义区域不参与**：PDF 的 Office 降级打印页（`pdf-convert/preview/office-print.css`）是"纸面"，必须永远白底黑字（反色既费墨又不可读），其色值刻意写死并加注释说明，不算遗漏。

## 玻璃令牌（v2.1.0 新增，配合 ui 的「玻璃质感」）
- `:root` 里新增一批玻璃 / 光晕 / 选中令牌：`--glass-blur`、`--glass-blur-strong`、`--glass-saturate`、`--glass-bg-strong`、`--glass-bg-soft`、`--glass-border`、`--glass-inner-highlight`、`--glass-sheen`、`--bg-grain`、`--bg-aurora-*`、`--color-select-*`、`--shadow-select`、`--shadow-float`，深色块只覆盖同名变量（规矩不变）。
- 表面色令牌改为半透明玻璃值：`--color-surface`、`--color-surface-soft`、`--color-sidebar-bg`（都带 alpha，浮在光晕背景上）。
- `--color-bg`（窗口底色）与 `--shadow-*` 的语义不变：`--color-bg` 必须继续等于 `main.js` 里 `windowBackgroundColor()` 的 `#f5f6f8` / `#16181d`，否则启动会闪白。
- 深色下的玻璃面必须是「深色 rgb + alpha」（不能用白色加 alpha），否则 `--theme-test` 的深色浅色残留扫描会误判。

## 输入 / 输出
- 输入：用户点击顶栏按钮或设置面板下拉框；系统深浅色变化事件。
- 输出：`<html data-theme>`；`settings.theme` 落盘。

## 非目标
- 不做自定义配色、不做多套主题商店、不做按工具分别设主题。
- 不反色工具内部的内容画布（图片预览、PDF 画布、Office 预览），它们永远按原始颜色呈现。

## 验收
- 三态循环正确；浅色/深色下外壳关键色值与 `theme.css` 一致（自检断言到具体 rgb；侧栏自 v2.1.0 起是玻璃值，断言到具体 rgba）。
- 玻璃确实生效：侧栏 `backdrop-filter` 不为 `none`、背景光晕有 image 层、卡片底色带 alpha。
- 选择落盘；重开软件仍生效。
- 深色下逐个工具页走一遍：无「写死浅色」的容器漏出来。
- 测试结束后必须恢复用户原来的档位（绝不能把使用者的设置改成测试用的深色）。

## 依赖的其他模块
- 依赖 `settings`（持久化）；被 `ui`/shell 使用；所有 `tools/*` 通过变量间接受益，不直接依赖本模块。
