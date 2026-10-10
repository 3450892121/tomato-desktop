## 1. 使用的系统与工具

- **运行时**：Electron `^44.4.2`，入口 `app/main.js`。
- **包管理**：`package.json`（位于 `app/`），通过 npm 安装依赖；registry 与 Electron 二进制镜像由 AGENTS.md 指定为 `https://registry.npmmirror.com`。
- **Node 环境**：仓库自带便携版 `.tools/node/node.exe`（v22.20.0，不进 git），命令前需先加入 PATH。
- **打包器**：**没有 Webpack/Vite/Rollup 等打包器**。应用源码直接以绿色文件夹形式分发，Electron 运行时通过 Windows `robocopy` 复制进产物目录。
- **平台**：仅面向 Windows（产物命名带 `-win64`，使用 `robocopy`、`.lnk` 快捷方式、`%TEMP%` 路径）。无 Dockerfile、CI 配置或 Makefile。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `app/package.json` | 项目元信息、版本、`start`/`test`/`icon`/`pack` 四个脚本、Electron 及运行期依赖声明 |
| `app/tools/pack.js` | 免安装版打包主逻辑（~762 行），定义 9 步流水线 |
| `app/tools/make-icon.js` | 生成图标（`src/assets/icon.png`、`build/icon.ico`） |
| `AGENTS.md` | 构建/测试/发布工作守则（命令、开关、版本策略、交付约束） |
| `app/main.js` / `app/preload.js` | Electron 主进程与安全桥，也是自检脚本的宿主 |
| `app/src/shell/registry.js` | 工具注册表，被冒烟测试断言工具数量 |
| `app/heic-worker.js` | HEIC 解码 worker，随打包复制 |
| `app/vendor/xlsx/` | 内置 SheetJS（绕过 npm CVE），升级见目录内说明 |

## 3. 架构与约定

### 3.1 脚本分层
- `npm start` → `electron .` 启动开发调试。
- `npm test` → 顺序执行 8 个纯逻辑单测（`engine.test.mjs`、`taskqueue.test.mjs`、`archive.test.mjs`、`imghide.test.mjs`、`navorder.test.mjs`、`uninstall.test.mjs`、`settingsschema.test.mjs`、`uniquepath.test.mjs`、`videodl.test.mjs`、`docconvert.test.mjs`），AGENTS.md 要求“297 项，全绿为准”。
- `npm run icon` → `node tools/make-icon.js`。
- `npm run pack` → `node tools/pack.js` 生成免安装版。

### 3.2 打包流水线（`pack.js` 定义的 9 步）
1. 清理并创建输出目录 `app/release/<folderName>/`。
2. 用 `robocopy` 复制 `node_modules/electron/dist` 到产物，删除默认 `default_app.asar` 与 `resources/app`。
3. 重命名 `electron.exe` → `番茄图片混淆桌面版.exe`。
4. 拷贝应用源码（`main.js`、`preload.js`、`src/`）以及一份白名单化的 `tests/` 子集（每个新增测试需在 `pack.js` 加一行，否则产物上跑不起来）。
5i. 产物瘦身（步骤编号如此在 pack.js 中）。
6–7. 其他准备步骤。
8b. 同步桌面快捷方式（目标/起始位置/图标位置指向当前版本 exe）。
8c. 迁移上一版用户设置。
9. 删除旧版本产物（release 目录只保留最新）。