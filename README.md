# 番茄图片混淆 桌面版

把安卓 App「番茄图片混淆」（`番茄图片混淆.apk`）的图片混淆 / 解混淆能力完整搬到 Windows 电脑上：
**免安装绿色版、纯离线、与手机版互相兼容**，给身边人用的傻瓜化工具。

软件按「工具箱」形态搭建：左侧列出所有工具，右侧是当前工具界面；「图片混淆」是第一个工具，
后续新功能（图片压缩、PDF、视频提取等）按同一套模板低成本接入（见 `docs/新增工具指南.md`）。

---

## 当前状态（v1.1.0）

| 项 | 状态 |
|---|---|
| 六大模式混淆 / 解混淆 | ✅ 可用（逐像素可逆，自动测试 55/55 通过） |
| 单张 / 批量 / 拖拽 / 剪贴板 / 保存 | ✅ 可用（界面自动测试 `pass: true`） |
| 设置面板、内置帮助、使用说明 | ✅ 可用 |
| **PDF 转格式（新）**：PDF↔图片、图片→PDF、合并/拆分/提取页、Word/Excel→PDF（内置降级） | ✅ 可用（自检 + 界面测试均 `pass: true`，含截图） |
| PDF → Word / 高保真 Office→PDF（LibreOffice 加装包） | ✅ 已实测，**随主包附带、开箱即用**（docx→PDF 有正文、PDF→Word 产出合法 OOXML） |
| 版本号可见（左上角徽章 / 窗口标题 / 帮助「关于」） | ✅ 可用（v1.1.0 起随包显示） |
| 免安装打包（含图标 / 版本信息 / 压缩包） | ✅ 已产出 |
| 与手机版互相兼容（真机样本实测） | ⏳ **待用手机样本锁定**（工具已就绪，见 `docs/兼容性变体说明.md`） |

---

## 快速开始

### 直接使用（给使用者）
双击免安装文件夹里的 `番茄图片混淆桌面版.exe` 即可，无需安装。详见 `docs/使用说明.txt`。
**完整版已内含 LibreOffice 加装包——解压后所有功能（含 PDF→Word、高保真 Word/Excel→PDF）立即可用，无需任何额外安装。**

### 开发调试（给维护者）
```powershell
# 1) 准备 Node（仓库内便携版，不污染系统）
$env:PATH = "<仓库路径>\.tools\node;" + $env:PATH

# 2) 安装依赖（走国内镜像）
cd app
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
npm install --registry=https://registry.npmmirror.com

# 3) 启动
npm start
```

### 测试与自检（交付前必须全绿）
```powershell
cd app
npm test                                                    # 算法测试 55 项（图片混淆）
.\node_modules\electron\dist\electron.exe . --smoke-test     # 冒烟自检（元素/按钮）
.\node_modules\electron\dist\electron.exe . --self-test      # 端到端（编解码 + 算法 + 性能）
.\node_modules\electron\dist\electron.exe . --ui-test        # 图片混淆 界面自动测试（含截图与像素级校验）
.\node_modules\electron\dist\electron.exe . --pdf-test       # PDF 工具自检（渲染/往返/合并拆分/内置降级）
.\node_modules\electron\dist\electron.exe . --pdf-ui-test    # PDF 工具界面自动测试（五个方向 + 截图）
```
> 界面类测试结果同时写入 `%TEMP%\tomato-pdf-test.json` 与 `%TEMP%\tomato-pdf-ui-test.json`，截图在 `%TEMP%\tomato-uitest`。

### 打包免安装版
```powershell
cd app
npm run icon     # 生成图标（src/assets/icon.png 与 build/icon.ico）
npm run pack     # 产出 release/番茄图片混淆-桌面版-v<版本>-win64/ 与同名 .zip
```
> exe 图标与版本信息需要 `app/build/rcedit.exe`（已随开发环境下载，缺失时会跳过并提示，不影响功能）。

### 兼容性样本工具（锁定手机版实现细节）
```powershell
# 造样本（自测用）
electron . --make-samples <目录> --mode <模式> [--key <密钥>]
# 验样本（拿手机版生成的图反推它用的模式与变体）：verdict 里 meanDiff 接近 0 即为命中
electron . --verify-samples <目录> --key <密钥>
```

---

## 目录结构

```
├─ AGENTS.md                 开发守则（动手前必读：命令、规范、红线）
├─ README.md                 本文件
├─ CHANGELOG.md              版本与里程碑
├─ spec/                     目标规格（地图 / 各模块 / 验收标准）
│  ├─ 00-overview.md
│  ├─ modules/{toolkit,engine,imageio,ui,batch,settings,pdf-convert}.md
│  └─ acceptance.md
├─ docs/                     文档
│  ├─ 使用说明.txt           面向使用者的说明（随安装包分发）
│  ├─ 新增工具指南.md         如何给工具箱加一个新工具
│  ├─ 兼容性变体说明.md       三处兼容性开关的背景与锁定方法
│  └─ 验收报告-*.md           验收标准逐条对照与证据
├─ app/                      Electron 应用源码
│  ├─ main.js / preload.js   主进程与安全桥
│  ├─ src/shell/             工具箱框架（导航、注册表、设计令牌、通用组件）
│  ├─ src/tools/obfuscate/   图片混淆工具（界面 + 算法 + 样式）
│  ├─ src/tools/pdf-convert/ PDF 转格式工具（core 核心 / preview 内置降级渲染页）
│  ├─ src/tools/_template/   新工具模板
│  ├─ src/shared/            跨工具复用（图片读写、设置）
│  ├─ tests/                 自动测试（算法 / 界面 / PDF 自检 / 样本工具）
│  └─ tools/                 构建脚本（图标生成、打包）
├─ artifacts/                测试证据（截图等，不进 git）
└─ 番茄图片混淆.apk           参考实现样本（只读）
```

> LibreOffice 加装包（可选）：解压到绿色版目录的 `addons/libreoffice/`（见 `spec/modules/pdf-convert.md`）。

---

## 特性

- **六种模式**：空间曲线混淆（番茄图）/ 方块混淆 (B) / 像素混淆 (C) / 行像素混淆 (C2) / 兼容PE 行模式 (PE1) / 行+列 (PE2)，规则与手机版一致。
- **密钥规则与手机版一致**：gilbert 无密钥；B/C/C2 为字符串密钥；PE1/PE2 为 0~1 小数（默认 0.666）。
- **保存规则与手机版一致**：gilbert 存 JPG（画质 95，体积小但有损）；其余模式存 PNG（无损）；默认存到原图旁边、重名自动加序号、绝不覆盖。
- **批量**：多文件 / 整文件夹导入，一键对全部图片操作，单张失败不影响整批（含失败汇总）。
- **易用**：拖拽图片或文件夹进窗口、Ctrl+V 粘贴剪贴板图片、Ctrl+C 复制结果、内置图文帮助。
- **绿色免安装**：整个文件夹拷走即用；设置与缓存都写在软件目录 `userdata/`，**不写系统 AppData**。
- **纯离线**：源码中没有任何网络调用（fetch / XHR / WebSocket / 外部 URL 零命中），断网可用。
- **PDF 转格式**（v1.1.0 新增）：PDF→图片（PNG/JPG、批量、选页、清晰度档位）、图片→PDF（JPG 直嵌/适应 A4）、PDF 合并/拆分/提取页；Word/Excel→PDF 无加装包时用内置方式（docx-preview + SheetJS + 打印引擎），PDF→Word 与高保真转换走可选的 LibreOffice 加装包。

## 已知限制

- **PE2 模式较慢**：1200 万像素单张约 9 秒（其余模式 0.7~1.0 秒）——该模式需要为每行每列各排序一次，属算法固有开销；后续可做排序优化。
- **gilbert 模式有损**：保存 JPG 会引入压缩误差，反复「混淆 → 解混淆」会累积画质损失（手机版同样如此）。
- **方块模式会补边**：尺寸不是 32 的倍数时自动补透明黑边，输出尺寸变大（与手机版一致，属正常现象）。
- **PDF 相关**（v1.1.0）：
  - 内置降级的 Word/Excel→PDF 只支持 `.docx` / `.xlsx`，版式较简单；旧版 `.doc/.xls`、PPT 与高保真需求需装 LibreOffice 加装包。
  - PDF→Word 依赖加装包；即便加装包就位，多栏/复杂表格的还原仍有偏差（PDF 本身不存版面结构，属格式固有限制）。
  - 清晰度档位 1×/2×/3× ≈ 72/144/216 DPI；超清档在大页面上单页约 4~5 百万像素，批量时耗时更长。
  - 加密 PDF 本期不支持处理（打开需要密码的 PDF 会给出提示）。
- 拖拽与剪贴板未纳入自动化测试（原因：会覆盖使用者剪贴板），需人工抽测。

## 隐私

不联网、不上传任何图片；没有账号、没有遥测。所有处理都在本机内存中完成，只有点「保存」时才写文件。