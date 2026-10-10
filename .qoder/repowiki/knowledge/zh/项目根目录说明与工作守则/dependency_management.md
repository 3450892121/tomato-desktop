## 概述

本项目是一个基于 Electron 的 Windows 桌面应用，依赖管理采用 **npm** 作为包管理器，通过 `app/package.json` 声明运行时与开发依赖，并通过 `app/package-lock.json` 锁定完整依赖树。项目不使用 yarn、pnpm、bun 等其它包管理器，也未在仓库中提交 `yarn.lock`、`pnpm-lock.yaml` 或 `.nvmrc` 等辅助文件。

## 关键文件

- `app/package.json`：应用根清单，声明 Electron 主进程依赖与脚本。
- `app/package-lock.json`：npm 生成的完整依赖锁文件，用于保证构建可复现。
- `app/src/package.json`：仅包含 `{"type": "module"}`，用于让 `app/src/` 下的 ES Module 代码被 Node 正确识别；该目录本身不声明依赖。

## 依赖分类与策略

### 运行时代码依赖（dependencies）

| 包 | 用途 |
|---|---|
| `@cantoo/pdf-lib` ^2.11.1 | PDF 编辑与转换（替代官方 pdf-lib） |
| `pdf-lib` ^1.17.1 | 另一份 PDF 处理库，供旧路径兼容 |
| `pdfjs-dist` ^6.3.289 | PDF 渲染与预览 |
| `ppu-paddle-ocr` ^6.6.0 | PaddleOCR 人脸识别/文字识别后端 |
| `onnxruntime-node` ^1.30.0 | ONNX Runtime Node.js 绑定，为 OCR 提供推理引擎 |
| `docx-preview` ^0.4.0 | Word 文档预览 |
| `heic-decode` ^2.1.0 | HEIC 图片解码 |
| `@cantoo/fontkit` ^2.0.12 | 字体解析（PDF 渲染所需） |

这些包全部以 `^` 语义化版本范围声明，而非精确版本，允许 npm 安装满足范围的最新版。

### 开发依赖（devDependencies）

仅 `electron ^44.4.2`，说明 Electron 本身作为开发依赖引入，打包后由构建脚本将二进制资源内联到产物中。

### 脚本约定

- `start`：`electron .`，启动开发调试。
- `test`：依次用 `node` 执行一组 `.mjs` 单测文件，没有统一测试框架（无 jest/vitest），是裸 Node 调用。
- `icon` / `pack`：分别调用 `tools/make-icon.js` 和 `tools/pack.js` 完成图标生成与应用打包。

## 架构与约定

1. **单一入口 manifest**：整个项目的依赖只集中在 `app/package.json`，`app/src/` 下不再维护独立的 package.json 依赖声明，避免多包管理的复杂性。
2. **ESM 模块标记**：`app/src/package.json` 通过 `{"type":"module"}` 启用 ESM，配合项目中大量 `.mjs` 文件（如 `core/*.mjs`、`tests/*.test.mjs`）使用 `import` 语法。
3. **CJS 与 ESM 混用**：部分内部工具仍使用 CommonJS（`.cjs` 后缀，如 `unique-target-path.cjs`、`browser-resolver.cjs`），因此不能把整个项目设为 ESM-only；`src/package.json` 的作用就是限定 ESM 作用域。
4. **Electron 原生模块**：`ppu-paddle-ocr`、`onnxruntime-node`、`@napi-rs/canvas` 等包包含平台原生二进制，打包时需要确保对应平台的预编译二进制可用。
5. **未检出私有 registry 配置**：仓库中没有 `.npmrc`、`package.json` 中的 `publishConfig.registry` 或环境变量 `NPM_CONFIG_REGISTRY` 的配置，依赖来源默认为公共 npm registry。
6. **未检出 vendoring 策略**：除 `app/src/tools/videodl/plugins/...` 下嵌入的 yt-dlp extractor（Python 插件）外，Node 依赖未以 vendor 目录形式提交，而是走 `node_modules` + lockfile 模式。

## 约束与规则

- 依赖版本范围使用 `^` 前缀（来自 `app/package.json`），即遵循语义化版本兼容更新。
- 构建产物需保持与 `app/package-lock.json` 一致，因为该锁文件存在于仓库中，代表已验证的可复现依赖树。
- 新增第三方库应在 `app/package.json` 的 `dependencies` 或 `devDependencies` 中声明，不应直接 `require()` 未声明的包。
- 对 Electron 主进程可用的 API 有选择地使用 Node 内置模块（如 `child_process`、`path`、`fs`），并在 `main.js` 与 `preload.js` 之间通过 IPC 通信隔离渲染进程权限。

## 适用性判断

本仓库存在明确的 npm 依赖清单、lockfile、脚本与 Electron 构建约定，属于中等成熟度的依赖管理体系——结构简单但缺乏自动化升级与审计流程（未见 Dependabot、Renovate 等 CI 集成）。