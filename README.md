# 番茄图片混淆 桌面版

把安卓 App「番茄图片混淆」（`番茄图片混淆.apk`）的图片混淆 / 解混淆能力完整搬到 Windows 电脑上：
**免安装绿色版、纯离线、与手机版互相兼容**，给身边人用的傻瓜化工具。

软件按「工具箱」形态搭建：左侧按「图片 / 视频 / 音频 / 文档 / 压缩 / 系统」分组列出全部 **21 个工具**——
- 图片：图片混淆、图片压缩、图片变清晰、图片格式转换、批量重命名、加水印、长图拼接、九宫格切图、文件藏图
- 视频：视频播放器、视频格式转换、视频压缩、动图与视频互转
- 音频：音频格式转换、音频剪辑、语音转文字
- 文档：PDF 转格式、PDF 编辑整理、文字识别
- 压缩：压缩与解压
- 系统：软件卸载

右侧是当前工具界面；新功能按同一套模板低成本接入（见 `docs/新增工具指南.md`）。

---

## 当前状态（v2.5.0）

| 项 | 状态 |
|---|---|
| **软件卸载（新）**：一键启动随包内置的卸载工具（管理员权限），把软件连同残留一起清掉 | ✅ 可用（官方原版 HiBit 便携版随包，`addons/hibit/`；Windows 标准 RunAs 提权 + 系统 UAC 把关，不静默提权、不代替用户点；自检含哈希一致、清单权限、空跑无进程与缺失降级） |
| **文件藏图**：把任意文件藏进一张图片（可随机生成封面 + 水印 + 可选密码），也能从别人发来的图夹图里取出文件 | ✅ 可用（**两种容器都支持**：默认「动态混淆（极速）」= 图片尾部追加，网站/APP 打开即解、不弹密码框、多大文件都能开；「图夹 PRO（防查）」= V6 容器 + 可选密码。自检里用官方实现当裁判：我们打的图官方能解、官方打的图我们能解，两套格式都逐字节一致） |
| **视频播放器**：软件内直接播视频，MP4/WebM 直接播，MKV/FLV/TS 无损换封装，AVI/WMV 等老编码自动重编码 | ✅ 可用（8 种格式端到端实测：7 种夹具真实播放 + 界面全流程 `pass:true`；播放走 Range 分块，不动原文件，缓存用完即清） |
| **压缩与解压（新）**：ZIP/7Z/TAR/GZIP + BZIP2/XZ/ZSTANDARD/BROTLI 双向、RAR 等仅解压 | ✅ 可用（13 种格式真实往返逐字节一致；密码 AES-256、分卷、免解压预览、zip-slip 防护） |
| **跨工具任务队列 + 任务中心（新）** | ✅ 可用（顶栏「任务」按钮 + 未完成徽标；切走工具页任务照跑完，界面测试含 LRU 回收后仍跑完的核心断言） |
| **PDF 编辑整理（新）**：压缩瘦身 / 文字水印 / 页码 / 旋转 / 重排 / 加密 / 解密 | ✅ 可用（七类操作均读回校验；压缩实测 1,052,712B → 170,874B 约 −84%） |
| **文字识别（新）**：扫描件 → 可搜索 PDF（Ctrl+F 可搜、可复制）/ 纯文本 / Word；预处理与压缩 | ✅ 可用（OCR 引擎闸门 3/3 召回 100%、零网络请求；多页可搜索 PDF 关键词命中 3/3） |
| **设置导入导出（新）** | ✅ 可用（换电脑一键带走；只合并已知键，野文件拒绝且不破坏现有配置） |
| **苹果风磨砂玻璃 + 选中一眼可见（新）** | ✅ 可用（侧栏/顶栏/卡片/弹窗/抽屉磨砂玻璃 + 背景光晕与底噪；选中项染色块 + 描边 + 弹簧放大；切工具不再重建侧栏、不再闪） |
| **深色模式**：浅色 / 深色 / 跟随系统 | ✅ 可用（顶栏一键切换；只覆盖主题变量，21 个工具零改动适配；`--theme-test` 通过） |
| **视频压缩（新）**：画质档 / 目标体积（两遍编码） | ✅ 可用（实测 3.48MB → 1.05MB；目标 1.5MB 得 1.44MB 达标） |
| **音频剪辑（新）**：波形选区截取 / 拼接 / 淡入淡出 / 音量标准化 | ✅ 可用（纯截取 3.03s/75ms；21 段拼接 95.96s→95.63s 可完整解码） |
| **图片批量四件套（新）**：批量重命名 / 加水印 / 长图拼接 / 九宫格切图 | ✅ 可用（像素级校验；重命名的冲突拒绝与链式改名均正确） |
| **保活页 LRU 回收** | ✅ 可用（只保「动过」的页：点开看看不占额度、切走即释放；动过的页最多 5 个，超出回收最久没用过的，当前页不回收） |
| **工具页状态保持 + 组件库动效** | ✅ 可用（切走再切回列表/输入/预览/顶栏提示全部保留） |
| **侧栏分组默认折叠** | ✅ 可用（打开时只显示分类标题，点标题平滑展开/收起并记住选择） |
| **音频格式转换**：21 种输出格式；视频提取声音 | ✅ 可用（自检 21/21 格式真实转码 + 回读校验） |
| **语音转文字**：音频/视频 → 文字（中英日韩粤），.txt / .srt | ✅ 可用（纯离线纯 CPU，FunASR 加装包随包） |
| **AI 放大（超分，图片变清晰）** | ✅ 可用（Real-ESRGAN 加装包随包；需 Vulkan 显卡） |
| 六大模式混淆 / 解混淆 | ✅ 可用（逐像素可逆，自动测试 55/55 通过） |
| 单张 / 批量 / 拖拽 / 剪贴板 / 保存 | ✅ 可用（界面自动测试 `pass: true`） |
| 设置面板、内置帮助、使用说明 | ✅ 可用 |
| **PDF 转格式**：PDF↔图片、图片→PDF、合并/拆分/提取页、Word/Excel→PDF | ✅ 可用（自检 + 界面测试均通过） |
| PDF → Word / 高保真 Office→PDF（LibreOffice 加装包） | ✅ 已实测，**随主包附带、开箱即用** |
| **图片压缩**：画质/尺寸/目标大小、批量 | ✅ 可用（实测 18 KB → 7 KB / -61%） |
| **图片变清晰**：6 档预设 + 自定义、原图对比预览 | ✅ 可用（锐度指标 52.6 → 81.2，+54%） |
| **图片格式转换**：PNG/JPG/WebP/BMP/ICO/TIFF/GIF/AVIF，输入另支持 HEIC/HEIF/HIF 手机拍照格式 | ✅ 可用（BMP/ICO 自研编码器，产物经解码校验；HEIC 解码走内置 libheif 引擎，纯离线） |
| **视频格式转换**：MP4/WebM/MKV/MOV/AVI | ✅ 可用（真实转码 + 逐个解码校验，进度可取消） |
| **动图与视频互转**：GIF/WebP 动图/APNG ↔ 视频 | ✅ 可用（含聊天表情预设与目标大小自动降档） |
| ffmpeg / Real-ESRGAN / FunASR / OCR / 7-Zip / HiBit 加装包 | ✅ **全部随主包附带**（见 `addons/` 各目录的许可与来源） |
| 版本号可见（左上角徽章 / 窗口标题 / 帮助「关于」） | ✅ 可用（随包显示当前版本） |
| 免安装打包（含图标 / 版本信息 / 压缩包） | ✅ 已产出（v2.0.0 文件夹 2468 MB + zip 1042 MB） |
| 与手机版互相兼容（真机样本实测） | ⏳ **待用手机样本锁定**（工具已就绪，见 `docs/兼容性变体说明.md`） |

---

## 快速开始

### 直接使用（给使用者）
双击免安装文件夹里的 `番茄图片混淆桌面版.exe` 即可，无需安装。详见 `docs/使用说明.txt`。
**完整版已内含 LibreOffice、ffmpeg 与 Real-ESRGAN 加装包——解压后所有功能（含 PDF→Word、高保真 Word/Excel→PDF、视频格式转换、动图与视频互转、AI 放大）立即可用，无需任何额外安装。**

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
npm test                                                    # 纯逻辑单测共 222 项（算法 55 + 任务队列 13 + 压缩 68 + 文件藏图 38 + 导航排序 29 + 软件卸载 19）
.\node_modules\electron\dist\electron.exe . --smoke-test     # 冒烟自检（元素/按钮）
.\node_modules\electron\dist\electron.exe . --self-test      # 端到端（编解码 + 算法 + 性能）
.\node_modules\electron\dist\electron.exe . --ui-test        # 图片混淆 界面自动测试（含截图与像素级校验）
.\node_modules\electron\dist\electron.exe . --pdf-test       # PDF 工具自检（渲染/往返/合并拆分/内置降级）
.\node_modules\electron\dist\electron.exe . --pdf-ui-test    # PDF 工具界面自动测试（五个方向 + 截图）
.\node_modules\electron\dist\electron.exe . --media-test     # 媒体工具自检（压缩/变清晰/转换 + 视频↔动图真实转码）
.\node_modules\electron\dist\electron.exe . --media-ui-test  # 媒体工具界面自动测试（5 个新工具逐个走查 + 截图）
.\node_modules\electron\dist\electron.exe . --audio-test     # 音频工具自检（21 种输出格式真实转码 + 回读校验 + 视频提取 + 标签保留）
.\node_modules\electron\dist\electron.exe . --audio-ui-test  # 音频工具界面自动测试（选格式、两轮转码、清空 + 截图）
.\node_modules\electron\dist\electron.exe . --asr-test       # 语音转文字自检（SAPI 合成中文语音 → 真实识别 + 字幕/视频/错误处理校验）
.\node_modules\electron\dist\electron.exe . --asr-ui-test    # 语音转文字界面自动测试（添加→两轮识别→清空 + 截图）
.\node_modules\electron\dist\electron.exe . --theme-test     # 外观主题自检（三态循环、深浅色值、落盘、深色下工具页扫描）
.\node_modules\electron\dist\electron.exe . --ocr-poc        # OCR 引擎闸门（中文召回/耗时/零网络请求三项判据）
.\node_modules\electron\dist\electron.exe . --av-test        # A 批：视频压缩 + 音频剪辑（逻辑 + 真实 ffmpeg 转码 + 界面走查）
.\node_modules\electron\dist\electron.exe . --imgbatch-test  # B 批：批量重命名/加水印/长图拼接/九宫格切图（含像素校验）
.\node_modules\electron\dist\electron.exe . --settingsio-test # 设置导入导出（结构合法性、白名单、野文件拒绝）
.\node_modules\electron\dist\electron.exe . --pdf-ocr-test   # C 批：PDF 编辑整理 + 文字识别（七类操作读回 + 可搜索 PDF 关键词命中）
.\node_modules\electron\dist\electron.exe . --queue-ui-test  # 任务中心（含「切走工具页后任务继续跑完」核心断言）
.\node_modules\electron\dist\electron.exe . --archive-test   # 压缩与解压自检（13 种格式真实往返 + 密码 + 分卷 + 大文件 + 安全）
.\node_modules\electron\dist\electron.exe . --archive-ui-test # 压缩与解压界面自动测试（压缩→预览→解压→密码→重复解压提示）
.\node_modules\electron\dist\electron.exe . --player-test     # 视频播放器自检（协议 Range + 7 种格式端到端播放 + 缓存命中 + 无效文件）
.\node_modules\electron\dist\electron.exe . --player-ui-test  # 视频播放器界面自动测试（直接播/换封装/重编码 + 控制条/全屏/快捷键 + 缓存清理）
.\node_modules\electron\dist\electron.exe . --imghide-test     # 文件藏图自检（PNG/GIF 往返 + 密码 + 双向互通裁判 + 容错与路径穿越）
.\node_modules\electron\dist\electron.exe . --imghide-ui-test  # 文件藏图界面自动测试（选表图→打包→解包→内容比对→密码往返→清空）
.\node_modules\electron\dist\electron.exe . --uninstall-test   # 软件卸载自检（加装包哈希/清单权限 + 提权命令构造 + 界面走查 + 空跑无进程 + 缺失降级）
```
> 界面类测试结果同时写入 `%TEMP%\tomato-*.json`（如 `tomato-pdf-test.json`、`tomato-av-test.json`、`tomato-pdf-ocr-test.json`、`tomato-queue-ui-test.json`、`tomato-archive-test.json` 等），截图在 `%TEMP%\tomato-uitest`。
> 媒体类自检需要 `app/addons/ffmpeg/ffmpeg.exe`；「文字识别」需要 `app/addons/ocr/`（模型 + 中文字体）；「压缩与解压」需要 `app/addons/7zip/`（引擎，约 2.4MB）；「软件卸载」需要 `app/addons/hibit/`（官方便携版，约 15MB）。仓库内均已有、不进 git；缺失时相关检查会如实标注失败，其余功能不受影响（压缩工具的 ZSTANDARD/BROTLI 走 Node 内置引擎，无加装包也可用）。
> `--uninstall-test` 与所有界面测试都**不会真的拉起卸载工具**（测试模式下 `hibit:launch` 只空跑）：既避免无人值守时弹 UAC 卡住，也保证自动化测试绝不执行任何卸载动作。

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
│  ├─ 压缩格式性能对比.md     压缩工具的技术实现与各格式实测性能对比
│  └─ 验收报告-*.md           验收标准逐条对照与证据
├─ app/                      Electron 应用源码
│  ├─ main.js / preload.js   主进程与安全桥
│  ├─ src/shell/             工具箱框架（导航、注册表、工具页容器、theme.css 设计令牌、components.css 组件库）
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
- **音频格式转换**（v1.6.0 新增）：21 种输出格式（MP3/M4A/WAV/FLAC/OGG/Opus/WMA/AMR/ALAC/AIFF/CAF/WavPack/TTA/AC3/EAC3/MP2/Speex/AU/W64/RealAudio）；APE/DSD/Musepack/TAK 可作输入；视频直接拖入自动提取声音；保留标题/歌手标签；复用 ffmpeg 加装包、零新增依赖。
- **语音转文字**（v1.7.0 新增）：音频/视频识别成文字（中/英/日/韩/粤自动识别），输出纯文本 .txt、字幕 .srt 或两者；视频自动提取音轨；纯离线、纯 CPU（实测约 20 倍实时）；内核 FunASR·SenseVoice（加装包随包，约 246MB，MIT 许可）。
- **视频播放器**（v2.3.0 新增）：软件内直接播视频，转完不用换软件。MP4/WebM 直接播；MKV/FLV/TS 自动「无损换封装」（画面声音不重编码，秒级）；AVI（MPEG-4）/WMV 等老编码自动重编码成 H.264（有进度、可取消）。播放/暂停、拖动进度、音量与静音、全屏、快捷键（空格 / ←→ / ↑↓ / M / F）齐全；播放走自定义协议 `tomato-media://` 按 Range 分块读取（大文件不占内存、进度可任意拖）；**只读原文件**，临时副本放 `userdata/player-cache/`，换文件与离开工具页即自动清理。
- **文件藏图**（v2.4.0 新增，v2.5.0 补齐两套容器）：把任意文件（文档 / 图片 / 视频 / 压缩包…）藏进一张普通图片，发给别人还是一张图，对方用本软件或网上的「图夹」网站 / 手机 APP 就能取出来。**打包**：选封面图（可点「随机表图」让软件生成一张）+ 加文件（可多选 / 可拖入）+ 可选水印文字 + 可选密码 → 产出 `名字_图夹.后缀`。**解包**：选 / 拖入图夹图 →（有密码就填）→ 文件解到图片旁的「图名_解出」文件夹，可一键打开。
  - **算法选择（与官方一致的两套容器）**：① 默认「动态混淆（极速）」——载荷是明文分隔符格式，**直接追加在图片尾部**，表图什么格式都行、原字节零改动、画质不变；官方客户端靠整文件字节扫描定位，**打开即解、不弹密码框**，多大文件都能开（788MB 也只是一次字节扫描）。② 「图夹 PRO（防查）」——`STEGDATA V6` 容器（PNG 塞进 IDAT 解压流 / GIF 尾部扩展块）+ 16 字节指纹，官方网页版会提示「识别到图夹PRO文件」并要你点一次确认；支持密码（PBKDF2-SHA256 + AES-256-GCM，与官方同参数）。
  - **双向互通**：自检里用官方那份未混淆的 worker 当裁判——官方 `action='decrypt'` 能直接解出我们打的极速图（含中文名，且不会触发密码框判定），官方 `SteganographyCore` 能解我们的 PRO 图与带密码图；官方打的图我们也都解得开（裁判文件放 `.tools/`，不进 git、不随包分发）。
  - 安全：条目名一律取 basename（防路径穿越）、密码错误不产出垃圾、产物重名自动加序号；体积提示按格式区分（极速只提醒传输不便，PRO 才警告网页版可能打不开）。
  说明：微信 / QQ 请以「文件」方式发送这张图（直接发图会被平台压缩、数据会丢）；产物体积 ≈ 表图 + 里图。
- **软件卸载**（v2.8.0 新增）：左侧「系统」分组里的一个启动页——点「打开卸载工具（管理员）」即以管理员身份拉起随包内置的 **HiBit Uninstaller 官方便携版**（`addons/hibit/`，约 15MB，未做任何修改），在里面卸载软件、扫描并清理残留、强制卸载顽固程序。**提权走 Windows 标准 `Start-Process -Verb RunAs`**（系统 UAC 把关，不静默提权、不代替用户勾选、不给对方传任何参数）；加装包缺失时按钮禁用并给出放置说明，点「重新检测」即恢复。**自动化测试一律空跑**，绝不真的启动卸载工具。
- **压缩与解压**（v2.2.0 新增）：**13 种格式双向**——ZIP / 7Z / TAR / GZIP（主流）与 BZIP2 / XZ / ZSTANDARD / BROTLI 及其 TAR 复合（非主流，满足「≥2 种」）；RAR/RAR5、ISO、CAB、WIM、DEB 等**仅解压**（RAR 专有，免费工具无法创建，界面如实标注）；**密码**（7Z 用 AES-256 并加密文件名、ZIP 支持 AES-256/ZipCrypto，中文密码自动引导改用 7Z）；**分卷**（ZIP/7Z/TAR 切 .001，解压只给首卷）；**免解压预览**（列条目/大小/加密位）；**zip-slip 防护**；**绝不覆盖**（重名自动加序号）；大文件全程流式。引擎为随包 7-Zip 26.03（LGPL 2.1+，约 2.4MB），ZSTANDARD/BROTLI 走 Node 内置 zlib（无加装包也可用）。详见 `docs/压缩格式性能对比.md`。

## 已知限制

- **PE2 模式较慢**：1200 万像素单张约 9 秒（其余模式 0.7~1.0 秒）——该模式需要为每行每列各排序一次，属算法固有开销；后续可做排序优化。
- **gilbert 模式有损**：保存 JPG 会引入压缩误差，反复「混淆 → 解混淆」会累积画质损失（手机版同样如此）。
- **方块模式会补边**：尺寸不是 32 的倍数时自动补透明黑边，输出尺寸变大（与手机版一致，属正常现象）。
- **PDF 相关**（v1.1.0）：
  - 内置降级的 Word/Excel→PDF 只支持 `.docx` / `.xlsx`，版式较简单；旧版 `.doc/.xls`、PPT 与高保真需求需装 LibreOffice 加装包。
  - PDF→Word 依赖加装包；即便加装包就位，多栏/复杂表格的还原仍有偏差（PDF 本身不存版面结构，属格式固有限制）。
  - 清晰度档位 1×/2×/3× ≈ 72/144/216 DPI；超清档在大页面上单页约 4~5 百万像素，批量时耗时更长。
  - 加密 PDF 本期不支持处理（打开需要密码的 PDF 会给出提示）。
- **压缩与解压**（v2.2.0）：
  - **RAR 只能解压不能压缩**——RAR 是专有格式，7-Zip 的 unRAR 代码许可明确禁止用于制作 RAR 压缩器；界面如实标注「仅解压」，不做改后缀伪装。
  - **ZIP 的密码只能用英文/数字**（7-Zip 限制，中文密码会报错）；中文密码请改用 7Z。
  - **没有断点续传**——7-Zip 命令行中断不可续跑；改用「分卷 + 失败可重试」应对大文件。
  - 流式单文件格式（GZIP/BZIP2/XZ/ZSTANDARD/BROTLI）**只能压单个文件**，多文件请选 TAR.xxx / ZIP / 7Z。
- **文件藏图**（v2.4.0 / v2.5.0）：
  - **微信 / QQ 必须以「文件」方式发送**（或压成 zip 再发）：直接当图片发，平台会重编码压缩，藏在里面的数据会被压没；贴吧要用「原图」链接。
  - 产物体积 ≈ 表图 + 隐藏文件，官方建议保持 3MB 以内更好发。
  - 「极速」格式：表图什么格式都行（数据追加在尾部，不影响打开）、不解压、多大文件都能开，但没有密码；「PRO」格式：只支持 PNG / GIF 表图（JPG/WebP 会自动转 8 位 PNG），超大文件（>50MB）在网页版/手机端可能因内存打不开（界面会如实警告）。
  - 水印：填了会把表图重编码成 PNG 再写入（GIF 表图因此会变成 PNG 产物）。
  - 互通按官方现有两套格式实现；对方以后若换新格式，兼容层需要跟进（格式逻辑集中在 `src/tools/imghide/core/format.mjs`）。
  - 不做联网功能：网络图片解密、URL 转文件、图床 / 复制直链 / 图语（服务器短码）都不在本期范围。
- **视频播放器**（v2.3.0）：
  - 能不能「直接播」取决于系统解码器（尤其是 H.265/HEVC 与 4K 片源）：播不了会自动转码兜底，只是长片重编码需要时间（界面有进度，可取消）。
  - 不支持网络地址播放（本软件全离线），也不做字幕、多音轨切换、倍速与播放列表。
  - 临时副本约等于源文件大小（重编码档位通常更小），换文件 / 切走工具页即清理；万一被系统占用删不掉，会留给下次进入工具页时清理。
- **软件卸载**（v2.8.0）：
  - **必须管理员权限**：官方 exe 清单里就是 `requireAdministrator`，点按钮时系统会弹一次 UAC，点「否」工具不会启动（界面如实提示）。
  - 随包的是**官方原版便携版**、未做修改；卸载过程与残留清理在它自己的界面里完成，本软件只负责把它拉起来——不代替用户勾选、不自动卸载。
  - 许可：官网标注「个人与商业使用均免费」，但**未找到明文「再分发」条款**（推断，未经证实）；因此保留原版文件与来源说明，若权利人另有要求，删除 `addons/hibit/` 即整体下线。
- 拖拽与剪贴板未纳入自动化测试（原因：会覆盖使用者剪贴板），需人工抽测。

## 隐私

不联网、不上传任何图片；没有账号、没有遥测。所有处理都在本机内存中完成，只有点「保存」时才写文件。