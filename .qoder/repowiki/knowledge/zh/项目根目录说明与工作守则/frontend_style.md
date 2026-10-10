## 1. 总体方案

本项目是一个 Electron 桌面应用（番茄图片混淆桌面版），前端采用 **原生 HTML + 纯 CSS + 少量 JavaScript**，不使用任何 CSS 预处理器、CSS-in-JS 框架或组件库。样式体系围绕一套位于 `app/src/shell/theme.css` 的 **CSS 自定义属性（设计令牌）** 构建，整体视觉风格为「清爽浅色现代风 + Apple 风磨砂玻璃」（v2.1.0 起），并配套完整的深色主题。

核心思路：
- 所有颜色、字号、间距、圆角、阴影、动画节奏、玻璃参数全部集中声明在 `theme.css` 的 `:root` 下；
- 其他样式文件只通过 `var(--xxx)` 引用这些令牌，不写死色值；
- 深色主题通过给 `<html>` 添加 `data-theme="dark"` 覆盖同名变量实现，无需改动工具代码；
- 加载顺序固定为 `theme.css → components.css → shell.css`，工具样式最后挂载以允许局部覆盖。

## 2. 关键文件

| 文件 | 职责 |
|---|---|
| `app/src/shell/theme.css` | 唯一的设计令牌源（颜色、字体、间距、圆角、阴影、动效、玻璃参数、背景光晕、选中反馈）；同时定义 `:root` 浅色系与 `[data-theme="dark"]` 深色系两套变量 |
| `app/src/shell/components.css` | 通用组件库（`.card`、`.btn`、`.input`/`.select`、`.field`、`.modal-backdrop`/`.modal-card`、`.progress` 等），统一引用 theme 令牌 |
| `app/src/shell/shell.css` | 框架级布局：左侧导航 + 右侧工具页容器、分组折叠、页面切换动画、滚动条、全局 reset（`box-sizing`、`[hidden]`） |
| `app/src/shell/index.html` | 入口 HTML，按约定顺序引入上述三个 CSS 文件 |
| `app/src/shell/shell.js` | 运行时主题切换（`applyTheme` 向 `<html>` 加/删 `data-theme="dark"`），以及侧栏分组折叠、页面切换等交互逻辑 |
| `app/src/tools/<tool>/styles.css` | 每个工具的专属样式，遵循“复用 components.css 类名 + 仅覆盖细节”的约定 |
| `app/src/tools/_template/styles.css` | 新增工具模板，强制新工具遵循同一套命名与结构 |
| `app/tests/theme-test.js` | 校验主题变量一致性（如深浅色玻璃变量必须是 `rgb(..., alpha)` 而非白色透明值） |
| `spec/modules/theme.md` | 主题模块规格说明 |

## 3. 架构与约定

### 3.1 三层 CSS 分层

```
template.css          ← 设计令牌（唯一改样式的地方）
components.css        ← 通用组件（按钮/卡片/输入/弹窗/进度）
shell.css             ← 框架布局（侧栏/工具列表/分组）
tools/*/styles.css    ← 工具专属样式（可覆盖组件细节）
```

该顺序在 `components.css` 和 `shell.css` 的顶部注释中明确声明，是硬约束。

### 3.2 设计令牌分类（theme.css）

- **基础色**：`--color-bg`、`--color-surface`、`--color-surface-soft`、`--color-border*`；其中 surface 自 v2.1.0 起是半透明玻璃值，必须与 `main.js` 的 `windowBackgroundColor` 一致，否则启动闪白。
- **语义色**：`--color-primary`（番茄红 `#ff5a4e`）、`--color-deobfuscate`（蓝）、`--color-save`（绿）、`--color-neutral`。
- **文字色**：`--color-text` / `secondary` / `inverse`。
- **字体与字号**：`--font-family`（Segoe UI / Microsoft YaHei / PingFang SC）、`--font-size-xs` ~ `xl`。
- **间距与圆角**：`--space-1`~6（4–32px）、`--radius-sm/md/lg`（8/10/14px）。
- **阴影**：`--shadow-card`、`--shadow-btn`、`--shadow-float`、`--shadow-sidebar-select`、`--shadow-select`。
- **玻璃拟态**：`--glass-blur`/`strong`/`overlay`、`--glass-saturate`、`--glass-bg-strong/-soft`、`--glass-border`、`--glass-inner-highlight`、`--glass-sheen`。
- **背景纹理**：内联 SVG 噪声 `--bg-grain`（5.5% alpha，离线可用）+ 三色径向光晕 `--bg-aurora-warm/cool/violet`。
- **选中反馈**：`--color-select-bg/border/ring` + inset 描边，避免外投影被 overflow:hidden 裁掉。
- **布局尺寸**：`--sidebar-width: 188px`、`--topbar-height: 40px`。
- **动画节奏**：`--transition-fast/base/slow/collapse`、`--ease-out`、`--ease-spring`、`--transition-spring`，组件库与工具统一使用。

### 3.3 深色主题机制

深色主题通过 `[data-theme="dark"]` 选择器覆盖同名变量实现。规则：**只覆盖同名变量，绝不新增变量名**。运行时由 `shell.js` 的 `applyTheme` 控制。深色下要求玻璃面使用「深色 rgb + alpha」而非白色透明值，否则会被 `theme-test.js` 的残留扫描误判。

### 3.4 组件库约定

`components.css` 提供的全局类名包括：
- `.card`：磨砂玻璃卡片（`backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))` + 内高光）。
- `.btn` / `.btn-obfuscate` / `.btn-deobfuscate` / `.btn-save` / `.btn-primary` / `.btn-plain` / `.btn-ghost` / `.btn-lg`。
- `.input` / `.select`：表单输入控件，focus 时边框变主色 + 3px 红色半透明外环。
- `.control-row` / `.control-label` / `.control-hint`。
- `.field` / `.field-label` / `.field-hint` / `.field-check`。
- `.modal-backdrop` / `.modal-card` / `.modal-title` / `.modal-body` / `.modal-actions`。
- `.progress` / `.progress-track` / `.progress-fill` / `.progress-text`。
- `.help-section`。

工具应直接复用这些类名，不要各自另起一套样式。

### 3.5 工具样式约定

每个工具目录 `app/src/tools/<id>/` 包含标准三件套：`index.js`（注册）、`ui.js`（DOM 渲染）、`styles.css`（样式）。`_template/` 模板为新工具提供样板，强制统一结构。

## 4. 规范与约束

以下约束来自代码中的显式注释与测试校验，属于强约束：

1. **所有工具样式必须引用 theme.css 的变量，不得写死色值。**（`theme.css` 顶部注释）
2. **深色主题只能覆盖同名变量，不能新增变量名。**（`theme.css` 深色区块注释）
3. **样式加载顺序固定为 theme.css → components.css → shell.css。**（`components.css` 顶部注释）
4. **`--color-bg` 必须与 `main.js` 的 `windowBackgroundColor` 一致，否则启动闪白。**（`theme.css` 注释）
5. **选中框描边和内高光必须用 `inset`，绝不允许外溢，因为会被分组容器的 `overflow: hidden` 裁掉。**（多处注释，含 `--shadow-sidebar-select` 与 `--shadow-select`）
6. **深色下的玻璃面必须使用「深色 rgb + alpha」，不能用白色加 alpha。**（`theme.css` 深色区块注释，并由 `tests/theme-test.js` 校验）
7. **背景光晕强度控制在 ≤0.35，保证看图配色与文字对比度不受影响。**（`theme.css` 注释）
8. **处理中进度遮罩使用较浅模糊（`--glass-blur-overlay`），避免拖慢批量任务。**（`components.css` 注释）
9. **全局 `display:flex` 会覆盖浏览器默认的 `[hidden]` 规则，因此 `shell.css` 用 `!important` 兜底。**（`shell.css` 注释）
10. **工具列表横向滚动彻底禁用（`overflow-x: hidden`），避免悬停位移导致左右晃动。**（`shell.css` 注释）

未观察到 Tailwind、SCSS、CSS Modules、BEM 命名空间、Design Token JSON 等现代前端样式工程化工具；整个体系是手工维护的纯 CSS + CSS 自定义属性。