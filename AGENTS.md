# AGENTS.md — 番茄图片混淆 桌面版

## 项目概览
把安卓 App「番茄图片混淆」（`番茄图片混淆.apk`）的图片混淆/解混淆能力完整搬到 Windows 电脑上：免安装绿色版、纯离线、与手机版互相兼容；给身边人用的傻瓜化工具。

## 仓库结构
- `AGENTS.md`：本工作守则（动手前必读）。
- `README.md`：项目说明、快速开始（运行/测试/打包）、目录结构、已知限制。
- `CHANGELOG.md`：版本与开发里程碑。
- `spec/`：目标规格（00-overview 全局地图 / modules 各模块 / acceptance 验收标准）。
- `docs/`：文档（`使用说明.txt` 面向使用者随包分发；`新增工具指南.md`；`兼容性变体说明.md`；`验收报告-v1.0.0.md`）。
- `artifacts/`：测试证据（截图等，不进 git）。
- `app/`：Electron 应用源码：
  - `main.js` / `preload.js`：主进程与安全桥（窗口、文件对话框等系统能力）。
  - `src/shell/`：工具箱框架（工具页容器、左侧导航、`registry.js` 工具注册表、`theme.css` 设计令牌、`components.css` 通用组件库）。**工具页保活（只保「动过」的页）**：切换工具不销毁页面，切回时列表/输入/预览/滚动位置与顶栏提示全部保留；没动过的页（只是点开看看）切走即静默释放、不占额度，免得「随便看看」挤掉别处用过的东西；动过的页上限 5 页，超出按 LRU 回收最久没用过的那页（当前页不回收，回收时提示「已自动释放」）；工具里的全局交互要用 `ctx.isActive()` 让位，被释放/回收时会走 `unmount()` 清理。**进度遮罩是全局唯一一个**：`ctx.showProgress/hideProgress` 会「始终记到本页、只有当前页才真的动遮罩」，`switchTool` 按新页记下的状态恢复或关闭——所以切走还在跑的工具时遮罩一定会被关掉，切回来又能接上；工具侧不必（也没法）靠自己在回收后补关。
  - `src/tools/<工具名>/`：各工具自包含目录（声明 + 界面 + 逻辑 + 样式）。现有：`obfuscate` 图片混淆、`pdf-convert` PDF 转格式、`doc-convert` 文档格式转换、`compress` 图片压缩、`enhance` 图片变清晰、`img-convert` 图片格式转换、`batch-rename` 批量重命名、`watermark` 加水印、`stitch` 长图拼接、`grid-slice` 九宫格切图、`player` 视频播放器、`video-convert` 视频格式转换、`video-compress` 视频压缩、`sticker` 动图与视频互转、`audio-convert` 音频格式转换、`audio-edit` 音频剪辑、`transcribe` 语音转文字、`pdf-edit` PDF 编辑整理、`ocr` 文字识别、`archive` 压缩与解压、`imghide` 文件藏图、`uninstall` 软件卸载、`videodl` 视频下载（**唯一需要联网的工具**，见 `spec/modules/videodl.md`）；`_template` 为新工具模板。
  - `src/shared/`：跨工具复用能力（图片读写、ffmpeg 封装与编码参数、HEIC/HEIF 解码封装、文件封装、设置、设置键值校验、HTML 转义）。另有 `unique-target-path.cjs` 是**主进程专用**的输出文件名分配器（CommonJS，main.js 与 Node 单测共用），放这里只是为了跟其它复用能力放一起。
  - `vendor/`：不走 npm 的第三方库（进 git）：`xlsx/`（SheetJS 0.20.3，「PDF 转格式」内置降级解析 Excel 用；npm 版停在 0.18.5 有已知漏洞，官方分发货道是 cdn.sheetjs.com，来源与升级方法见 `vendor/xlsx/说明.txt`）。
  - `addons/`：随包加装包（不进 git）：`libreoffice/`（PDF→Word 与高保真 Office→PDF、文档格式转换的老文档→新格式，可选）、`ffmpeg/`（视频/动图工具必需，单文件 83MB，GPL v3）、`realesrgan/`（「图片变清晰」的 AI 放大，约 50MB，BSD 3-Clause，需 Vulkan 显卡）、`asr/`（「语音转文字」的 FunASR·SenseVoice 识别引擎，约 246MB，MIT，纯 CPU）、`ocr/`（「文字识别」的 PP-OCRv5 mobile ONNX 模型，约 20MB，Apache-2.0 模型 + MIT 运行时，纯 CPU）、`hibit/`（「软件卸载」随包内置的 HiBit Uninstaller 4.0.10 官方便携版，单文件 15.4MB，官网标注个人与商业使用均免费，**启动需管理员权限**——exe 清单即 `requireAdministrator`）、`7zip/`（「压缩与解压」引擎，约 2.4MB，LGPL 2.1+）、`ytdlp/`（「视频下载」的 yt-dlp.exe 约 16.6MB + 可选 `node/node.exe` 约 82MB 仅 YouTube 挑战求解用；源码 Unlicense、Windows 组合产物 GPLv3+，版本与 SHA-256 见 `说明.txt`，可自更新到 `userdata/videodl-engine/`）；许可与来源见各自目录的 LICENSE/说明.txt。
- `docs/`：开发指南（如《新增工具指南》）。
- `app/release/`：打包产物（不进 git）。
- `番茄图片混淆.apk`：参考实现样本（只读，不修改、不覆盖）。
- `.tools/`：本机构建工具（Node 便携版等，不进 git）。

## 新增工具约定（工具箱架构）
- 新功能一律做成 `src/tools/<工具名>/` 下的独立工具，禁止写进既有工具或 shell。
- 接入步骤：复制 `src/tools/_template/` → 改 `id`/`name`/`icon`/`group`/`order` → 在 `src/shell/registry.js` 加一行；详见 `docs/新增工具指南.md`。
- 左侧导航按分组显示（`group`: image 图片 / video 视频 / audio 音频 / doc 文档，定义在 `shell/registry.js` 的 `GROUPS`）：同类工具要放同一组，保证用户好找；未声明 `group` 会归入末尾「其它」。
- 工具之间禁止互相 import；可复用的能力放 `src/shared/`。
- 工具界面样式只用自己的 `styles.css`，颜色/字号/间距必须引用 `shell/theme.css` 的变量。

## 执行纪律
- 严格按用户给定步骤/清单执行，不做清单之外的事。
- 每步完成简报结果；任何一步失败立即停下说明原因，不跳过、不继续。
- 缺信息先问，绝不编造；推断必须标注「这是推断，未经证实」。
- 改已有文件：先读原文；**有冲突就把旧内容直接改掉**，不要靠「末尾追加 + 声明作废」——前后矛盾的两套规矩会让 AI 判断出错。确有必要保留历史，就把它移出去归档，不要留在同一个文件里。
- 选型（依赖/工具/方案）需评估安全、稳定、兼容与成本并给出来源依据；优先免费零本地方案。

## spec/ 目标规格
- 动手前先读 spec/：`00-overview.md` 全局地图，`modules/<模块名>.md` 模块目标与边界，`acceptance.md` 验收标准。
- 新增功能先补 spec 再写代码；实现与 spec 冲突时停下问用户，不得改 spec 凑实现。

## 构建与测试命令
- Node 环境：`.tools/node/node.exe`（便携版 v22.20.0，不进 git；命令行里先把 `.tools/node` 加入 PATH）。
- 安装依赖：`cd app` → `npm install`（npm registry 用 `https://registry.npmmirror.com`；Electron 二进制需设 `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/`）。
- 启动调试：`cd app` → `npm start`。
- 算法测试：`cd app` → `npm test`（连跑纯逻辑单测共 297 项：算法 55 项（MD5 对照、洗牌、Gilbert 覆盖、六模式往返、填充规则、密钥校验）+ 任务队列 13 项 + 压缩与解压 71 项 + 文件藏图 41 项 + 导航排序 33 项（v2.6.0 起，`tests/navorder.test.mjs`）+ 软件卸载 19 项（v2.8.0 起，`tests/uninstall.test.mjs`）+ 设置校验与转义 21 项（v2.8.1 起，`tests/settingsschema.test.mjs`）+ 输出文件名分配 11 项（`tests/uniquepath.test.mjs`，钉住「挑名字与占名字必须原子完成」，否则并发转码会静默互相覆盖产物）+ 视频下载 22 项（v2.12.0 起，`tests/videodl.test.mjs`：URL 提取/站点识别/文件名净化/yt-dlp 行解析/错误分类/B站参数/央视频解析/引擎指纹校验与安装读取；v2.12.1 起加抖音游客通道——ttwid 两趟取数、页面自发 Cookie 兜底、三种页面级报错）+ 文档格式转换 11 项（v2.13.0 起，`tests/docconvert.test.mjs`：家族映射/智能目标选择/强制目标拒绝矩阵/下拉值与引擎白名单对齐）。
- 冒烟自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --smoke-test`（输出 `SMOKE_NAV {...}`、`SMOKE_UI {...}` 与 `SMOKE_TEST_OK tools=23 options=6 …`。**带硬断言**：导航渲染出的工具数必须等于 `registry.js` 的 `TOOLS` 数量（期望值取自 registry 本身，不写死）、必需界面元素不缺、`[data-action]` 按钮逐个点击不报错、模式下拉框非空、顶栏状态文字非空；任一不满足即输出 `SMOKE_TEST_FAIL <原因>` 且**进程退出码为 1**，可直接用于脚本/CI 判定）。
- 端到端自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --self-test`（在界面进程里跑「PNG 无损往返 + 算法链路 + JPG 保存 + 方块填充」，输出 `SELF_TEST {...}`）。
- 界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --ui-test`（模拟真人点按钮走完整流程：选图→混淆→保存→还原→批量→清空，逐步截图并做像素级校验，输出 `UI_TEST {..., "pass":true}`；截图落在 `%TEMP%\tomato-uitest`）。**注意：该测试要求干净的默认档案**——`navSort.resetHiddenInitially` 断言「未拖动前『恢复默认排序』按钮应隐藏」，若 `userdata/settings.json` 里已有自定义 `navOrder`，该按钮本就该显示，断言会为 false 而使 `pass:false`。在产物上跑之前先清空 `userdata/settings.json`（v2.11.1 实测踩过，一度误判成产物缺陷）。
- PDF 工具自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --pdf-test`（pdfjs 渲染 / 图片↔PDF 往返 / 合并拆分提取 / 内置降级 docx·xlsx→PDF / 界面接线；结果写 `%TEMP%\tomato-pdf-test.json`，`ok:true` 为通过）。
- PDF 工具界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --pdf-ui-test`（五个方向真人操作 + 截图；结果写 `%TEMP%\tomato-pdf-ui-test.json`，`pass:true` 为通过）。
- 媒体工具自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --media-test`（图片压缩/变清晰/格式转换的核心逻辑 + HEIC/HEIF 手机格式输入（主进程 libheif 引擎：尺寸/旋转/坏文件/HEIC→PNG 产物，夹具在 `tests/assets/`）+ 老图片格式输入（v2.13.0 起，oldimage 段：TGA/TIFF/JPEG2000 夹具经与工具同一条 IPC 解码，**密集采样**断言像素——稀疏采样点恰好全落 testsrc 黑色区域会造成假失败）+ 视频↔动图链路：ffmpeg 造夹具、真实转码、逐个解码校验；结果写 `%TEMP%\tomato-media-test.json`，`ok:true` 为通过）。
- 媒体工具界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --media-ui-test`（5 个新工具逐个「切工具→添加→运行」，截图并校验新增产物可被 ffmpeg 完整解码；结果写 `%TEMP%\tomato-media-ui-test.json`，`pass:true` 为通过）。
- 音频工具自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --audio-test`（21 种输出格式真实转码 + 逐个回读校验 + 视频提取音频 + 标签保留 + 无效文件报错 + 计划逻辑单测；结果写 `%TEMP%\tomato-audio-test.json`，`ok:true` 为通过）。
- 音频工具界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --audio-ui-test`（切工具→选输出格式→两轮转码 M4A/OGG→清空，截图并校验产物可完整解码；结果写 `%TEMP%\tomato-audio-ui-test.json`，`pass:true` 为通过）。
- 语音转文字自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --asr-test`（SAPI 离线合成中文语音夹具 → 真实识别 + 关键词校验 + .txt/.srt 落盘校验 + 视频提取音轨链路 + 无效文件报错 + 计划逻辑单测；结果写 `%TEMP%\tomato-asr-test.json`，`ok:true` 为通过）。
- 语音转文字界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --asr-ui-test`（切工具→添加音频/视频→两轮识别（文本+字幕 / 纯文本重名不覆盖）→清空，截图并校验产物内容；结果写 `%TEMP%\tomato-asr-ui-test.json`，`pass:true` 为通过）。
- 外观主题自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --theme-test`（顶栏三态循环 → 浅色/深色两套色值 rgb 断言 → 落盘断言 → 9 个工具页深色下浅色残留扫描 → 恢复用户原档位；截图 `shot-theme-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-theme-test.json`，`pass:true` 为通过）。
- OCR 引擎闸门（P0）：`cd app` → `.\node_modules\electron\dist\electron.exe . --ocr-poc`（界面进程画中文扫描件夹具 → 主进程用 `app/addons/ocr/` 本地模型识别 → 字符召回/耗时/零网络请求三项判据；结果写 `%TEMP%\tomato-ocr-poc.json`，`ok:true` 为通过）。**v2.11.1 起该闸门在打包产物上也能跑**：此前 `tests/ocr-poc.js` 硬写 `path.join(__dirname,'..','addons','ocr')`，产物上解析成 `resources/app/addons/ocr`（不存在）而必然 `ok:false`，等于产物上从来没真正验过 OCR；现已改为与其余带加装包的自检同一惯用法 `app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname,'..')`。
- 媒体工具（A 批）自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --av-test`（「视频压缩」+「音频剪辑」两个工具：纯逻辑断言 + 真实 ffmpeg 转码（含两遍编码与多段拼接）+ 界面走查与截图；结果写 `%TEMP%\tomato-av-test.json`，另有各工具明细 `tomato-video-compress(-ui)-test.json`、`tomato-audio-edit(-ui)-test.json`，`ok:true` 为通过）。
- 图片批量工具（B 批）自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --imgbatch-test`（「批量重命名 / 加水印 / 长图拼接 / 九宫格切图」四个工具：纯逻辑断言 + 真实处理与像素校验 + 界面走查与截图；结果写 `%TEMP%\tomato-imgbatch-test.json`，另有各工具明细，`ok:true` 为通过）。
- C 批工具自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --pdf-ocr-test`（「PDF 编辑整理」+「文字识别」：七类 PDF 操作读回校验 + OCR 真实识别与可搜索 PDF 关键词命中 + 界面走查与截图；结果写 `%TEMP%\tomato-pdf-ocr-test.json`，`ok:true` 为通过）。**缺资源导致的跳过算失败（v2.11.1 起）**：pdf-edit 里某个用例因缺资源返回 `{ skipped: … }` 会被记入 failures 使整体 `ok:false`，同时结果 JSON 里给出 `verified`（= ok 且无跳过且中文字体就位）与 `skipped` 明细——中文字体是加装包里的普通资产，缺它意味着中文水印/页码功能本身就坏了，不像 imghide 的裁判（刻意不随包）那样情有可原。
- 任务队列自检：`cd app` → `node tests/taskqueue.test.mjs`（纯逻辑：通道并发上限 cpu=1/io=2、通道隔离、进度聚合、取消 queued/running、失败与 retry、最近完成、runBatch、waitFor；已挂进 `npm test`，通过 13 项）。
- 任务中心界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --queue-ui-test`（顶栏任务入口与徽标、任务中心开合与空态、真实转码批量、**核心断言：切走工具页并触发 LRU 回收后任务照跑完且产物可被 ffmpeg 完整解码**、取消排队任务、清空已完成；截图 `shot-queue-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-queue-ui-test.json`，`pass:true` 为通过）。**注意：该开关需先在 `main.js` 接线（见 `spec/modules/task-queue.md` 末节清单）。**
- 设置导入导出自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --settingsio-test`（导出结构合法 + 导入能把改掉的设置恢复 + 未知键忽略 + 野文件拒绝且不破坏现有设置 + 结束恢复用户原设置；结果写 `%TEMP%\tomato-settingsio-test.json`，`pass:true` 为通过）。
- 视频播放器自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --player-test`（纯逻辑 29 项 + 本地媒体协议 200/206/Range/404 + 7 种格式夹具端到端「探测→计划→准备副本→真实 `<video>` 播放」+ 缓存命中 + 无效文件报错；结果写 `%TEMP%\tomato-player-test.json`，`ok:true` 为通过）。
- 视频播放器界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --player-ui-test`（切工具→打开 MP4 直接播→播放/暂停/拖动/音量/静音/全屏/快捷键→MKV 换封装→AVI 重编码（含进度覆盖层）→切走自动暂停与状态保留→LRU 回收后缓存清空→拖入非视频给出提示；截图 `shot-3x-播放器-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-player-ui-test.json`，`pass:true` 为通过）。
- 文件藏图自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --imghide-test`（**两套容器都验**：动态混淆（极速）整文件往返 + 官方 `action='decrypt'` 不解密直接读（证明网页版不弹密码框）；图夹 PRO 的 PNG/GIF 往返 + 密码 + 官方双向互通（裁判放 `.tools/tujia-oracle/decryptWorker.js`，不进 git）+ 容错与路径穿越；结果写 `%TEMP%\tomato-imghide-test.json`）。**判定分两个字段**：`ok` = 跑过的项全过；`verified` = 且没有任何一项因缺裁判被跳过（`skipped` 列出跳过项）。裁判不随包分发，所以**打包产物上必然是 `ok:true / verified:false`（预期状态）；官方互通只能在开发树上验证，交付前必须跑到 `verified:true`**——别把 `skipped` 当成通过。
- 软件卸载自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --uninstall-test`（加装包在位 + **SHA-256 与 `addons/hibit/说明.txt` 记录一致** + exe 清单权限 `requireAdministrator` + 提权命令构造 + `hibit:status` IPC + 界面走查（分组/按钮/状态卡/顶栏）+ **测试模式空跑并用 `tasklist` 断言进程未拉起** + 缺失降级（临时藏起 exe 再还原，带自愈）；截图 `shot-uninstall-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-uninstall-test.json`，`pass:true` 为通过）。
- 文件藏图界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --imghide-ui-test`（切工具→随机表图→加文件→打包→产物校验与解码→解包比对→自定义表图+水印→图夹 PRO+密码往返（错误密码被拒）→体积提示两模式→清空；截图 `shot-imghide-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-imghide-ui-test.json`，`pass:true` 为通过）。
- 视频下载自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --videodl-test`（加装包指纹与 `说明.txt` 记录一致 + B站插件在位 + 引擎解析 + **本地小服务器喂 ffmpeg 现造的小 MP4 真实下载**（yt-dlp/ffmpeg 全链路，不依赖外网、可重复）+ 成品音画校验 + 历史落盘与重启可读 + **取消（进程终止、`.part` 与临时目录零残留、取消后可重下）** + 无效地址报错 + 缺包降级 + 引擎更新检查；结果写 `%TEMP%\tomato-videodl-test.json`，`ok:true` 为通过、`verified:true` 表示联网项也没跳过）。**产物上的预期状态是 `ok:true / verified:false`，且 `skipped` 只含「引擎更新全链路」一项**（跑产物自检时设 `VIDEODL_TEST_SKIP_UPDATE=1`）：该步要联网重下约 16MB 且会改写产物 `userdata/`，与打包布局无关；它的完整验证在开发树做（必须 `verified:true`），与文件藏图的裁判不随包是同一类处理。**用户报「某个链接下载不了」时，先读产物的 `userdata/videodl-history.json`**：里面有真实链接、报错原文、失败阶段与起止时间戳，比让用户复述准得多，也能一眼看出是「解析不到」还是「下载中断」（v2.12.1 就是这样定位到抖音游客通道缺 ttwid Cookie 的：三次失败都在 4.2 秒内、报错完全一致）。自检只覆盖本地小服务器喂的直链，**不含真实站点解析**——站点侧改版要靠这条历史记录和用户反馈发现。
- 视频下载界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --videodl-ui-test`（切工具→改保存位置→贴链接→开始下载→进度→完成→定位→引擎卡片检查更新与自动检查开关→慢速下载中途取消→清空记录（断言磁盘文件仍在）；截图 `shot-videodl-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-videodl-ui-test.json`，`pass:true` 为通过）。
- 文档格式转换自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --doc-test`（引擎自检：程序内生成四类夹具——教务系统同款「假 .xls」（Excel 2003 XML，**行必须包在 `<Table>` 里**，否则 LibreOffice 转出空表）/ SheetJS 造的真 BIFF .xls / 手写 RTF / 坏文件——转换经渲染进程走**真实 IPC**（`libreoffice:convert`，本文件不直接起子进程），SheetJS·jszip 读回校验内容；坏文件只断言「确定结果且产物可读」（LibreOffice 对垃圾字节可能转出空表，属固有行为）；缺 LibreOffice 加装包 = 失败；结果 `DOC_TEST {"ok":true}` 为通过）。
- 文档格式转换界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --doc-ui-test`（切工具→添加夹具→智能转换→产物内容读回（xlsx 单元格 + docx 正文关键词）→清空→**收尾把「测试老文档*」家族清干净**——pdf-convert 的测试对话框按扩展名全收（无夹具过滤），残留文件会把它的「成功 2 个」污染成「成功 4 个」；截图 `shot-3x-文档*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-doc-ui-test.json`，`pass:true` 为通过）。
- 压缩与解压自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --archive-test`（也可直接 `node tests/archive-test.js` 快速迭代，`ARCHIVE_TEST_BIG_MB` 环境变量可把大文件用例从默认 120MB 调小）。覆盖：13 种格式真实「压缩→列目录→解压→逐字节比对」、密码三方案 + 错误密码必须失败且不留垃圾、分卷、免解压预览（断言输出目录未被创建）、仅解压格式拒绝压缩、路径穿越（自造 tar 条目 + 大包头部）、大文件、Node 原生 zstd/brotli、**失败清理保住用户原有文件**（tar.zst 第二趟失败时不得删用户目录里的东西）、**zst/br 的 Node 分支遵守覆盖策略**（跳过模式下不得截断同名文件、替换模式下要正确覆盖）、**批量解压一个包坏了不拖垮整批**（失败逐包记录、已成功的产物保留）、**中文条目名跨管道块不乱码**（3000 条中文名，断言无 U+FFFD——乱码路径会绕过 zip-slip 闸门）、无效文件、取消、进度回调；结果写 `%TEMP%\tomato-archive-test.json`，`ok:true` 为通过。
- 压缩与解压界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --archive-ui-test`（切工具→压缩 7Z→校验产物→切解压模式→预览断言→解压→内容比对→密码往返→分卷往返→仅解压格式提示→清空；截图 `shot-archive-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-archive-ui-test.json`，`pass:true` 为通过）。
- 交付前必须全绿：算法测试 + 冒烟自检 + 端到端自检 + 界面自动测试 + PDF 工具自检 + PDF 工具界面自动测试 + 媒体工具自检 + 媒体工具界面自动测试 + 音频工具自检 + 音频工具界面自动测试 + 语音转文字自检 + 语音转文字界面自动测试 + 外观主题自检 + OCR 引擎闸门 + 媒体工具（A 批）自检 + 图片批量工具（B 批）自检 + 设置导入导出自检 + C 批工具自检 + 视频播放器自检 + 视频播放器界面自动测试 + 压缩与解压自检 + 压缩与解压界面自动测试 + 文件藏图自检（要 `verified:true`）+ 文件藏图界面自动测试 + 软件卸载自检 + 视频下载自检（要 `verified:true`，联网项跳过即不算过）+ 视频下载界面自动测试 + 文档格式转换自检 + 文档格式转换界面自动测试，且截图人工过目一遍；打包产物需再跑一次冒烟与各界面自测（产物上文件藏图自检只要求 `ok:true`，互通项因裁判不随包必然 skipped）。**v2.11.1 起产物复检清单加入 `--ocr-poc` 与 `--pdf-ocr-test` 的中文字体项**：这两处此前因相对路径在产物上解析错误而一个必然 `ok:false`、一个把中文用例静默跳过（整体仍报 `ok:true` 的假绿），修好后才第一次真正在产物上验到 OCR 与中文水印/页码。跑 `--ui-test` 前**必须**先清空产物的 `userdata/settings.json`（见上文该条注意事项）——v2.12.0 又踩一次：步骤 8c 会从上一版产物迁移设置，而上一版产物目录里留着**它自己当年跑界面测试遗留的 `navOrder`**，迁移进来后「恢复默认排序」按钮本就该显示，`navSort.resetHiddenInitially` 断言为 false 使整体 `pass:false`（failures 为空，很容易误判成别的问题）。
- 生成图标：`cd app` → `npm run icon`（产出 `src/assets/icon.png` 与 `build/icon.ico`）。
- 打包免安装版：`cd app` → `npm run pack`（产物：`app/release/番茄图片混淆-桌面版-v<版本>-win64/` 免安装文件夹 + 同名 `.zip`；exe 图标与版本信息由 `build/rcedit.exe` 写入，缺失则跳过）。打包顺序：步骤 5i 产物瘦身 → 步骤 8b 同步桌面快捷方式 → **步骤 8c 迁移上一版的用户设置**（`userdata/settings.json`，升级不丢排序/折叠偏好）→ 步骤 9 删旧版。
  - **步骤 5i 产物瘦身（v2.11.1 起，省约 1005MB）**：删掉随上游整包带进来、但运行期用不到的东西——LibreOffice 的 57 种语言拼写字典（不含中文，且 headless 转换不做拼写检查）、123 种语言的界面翻译与语言包注册项、Python 脚本 provider、帮助/图库/模板/向导、躺在运行目录里的安装器 msi；另有 Electron 多余语言包、onnxruntime 的 DirectML 三件套（引擎默认 `executionProviders:['cpu']`）、node_modules 内全部 sourcemap、`@cantoo/pdf-lib` 的 TS 源与降级声明。**只删产物，`app/addons` 与 `node_modules` 源树一律不动**；每条规则是 `PRUNE_RULES` 里的独立一项，删一行即回滚该项；规则按前缀/模式匹配而非硬编码版本号，命中 0 字节或总收益低于下限都会打警告。
    - **命名陷阱（改这段前必读）**：LibreOffice 两处多语言目录命名规则**不一致**——`program/resource/` 下是**下划线**目录名（`zh_CN`/`en_GB`，且**没有 `en_US`**，英文原文编进了二进制），`share/registry/res/` 下是**连字符**文件名（`registry_zh-CN.xcd`）。用连字符白名单去匹配 `resource/` 会一个都匹配不上、**把中文翻译一起删光**。故两处各用对应白名单，并有**硬断言**：裁完必须仍存在 `zh_CN` 目录、`registry_zh-CN.xcd`、`fcfg_langpack_zh-CN.xcd`、`soffice.exe` 与 `locales/zh-CN.pak`，缺任一项直接构建失败。
    - 已复核的安全边界：`share/registry` 顶层功能性 xcd（`main`/`writer`/`calc`/`impress`/`draw`/`pdfimport`/`xsltfilter`/`lingucomponent`/`cjk_zh-CN`/`ctl_*`）不动；语言数据（数字/日期/货币格式）在 `program/localedata_*.dll`，与裁剪的两处无关，故不影响转换结果；`@cantoo/pdf-lib` 的 `cjs/` 与 `es/` 是 `package.json` 里 `exports` 的真实解析目标，**保留**。实测证据：裁剪前后 LibreOffice 三条转换路径产物**逐字节相同**。
  - 重复打包**同一版本号**会先清空产物目录，此时 8c 找不到旧版目录可迁移（旧版已被步骤 9 删掉）——需要在 pack 前把上一步备份的用户设置放回一个旧版本命名的目录（本机实测流程见 CHANGELOG v2.7.1），或 pack 后手工放回新产物的 `userdata/`。
  - **`pack.js` 步骤 4 的 `tests/` 是「逐个文件白名单」**：新增测试文件必须同步加一行，否则产物里缺文件、该测试在产物上跑不起来。v2.8.0 首次打包踩到的是「主进程 `require('./tests/xxx.js')` 在 try 之外 → 窗口开着、测试不跑、也不退出的**静默卡住**」；**v2.8.1 起已根除**：所有测试 require 都包在 try 里，catch 打 `<TAG>_FAIL` + 堆栈，finally 必 `app.quit()`，缺文件现在是明确报错退出而不是卡住。新增测试后仍请 grep 确认：产物 `resources/app/tests/` 里文件齐全。
- 兼容性样本工具（锁定 variants.js 用）：
  - 造样本：`electron . --make-samples <目录> --mode <模式> [--key <密钥>]`
  - 验样本：`electron . --verify-samples <目录> --key <密钥>` → 输出 `verdict`，`meanDiff` 接近 0 即为手机版所用的模式与变体。

## 改动与提交
- 每次改动完成后创建对应 git commit，便于追踪和回滚。
- 提交信息带类型前缀：fix（修 bug）/ feat（新功能）/ docs（文档）/ chore（维护）。

## 测试与发布
- 每次改动后编写或更新相关测试；交付前所有测试和验证必须全部通过。
- 交付前把免安装版和压缩包按对应版本号整理好；删除旧文件前先评估影响。
- **用户要求：release 目录只保留最新版本**——`npm run pack` 会在打包成功后自动清理其它版本的文件夹与压缩包（见 pack.js 步骤9）；版本历史靠 git tag 回溯，不改留旧构建产物。
- **用户要求：每次换版本必须同步桌面快捷方式**——桌面 `番茄图片混淆 桌面版.lnk` 的「目标」「起始位置」「图标位置」都必须指向当前版本的 exe/目录（**含 IconLocation，v2.2.0 曾漏改导致桌面图标变白**）。`pack.js` 步骤 8b 已在**删旧版之前**自动同步三处并读回验证，无需手工；若它失败会打警告。教训：删旧版后快捷方式仍指向已删除的旧目录，用户双击打不开、图标变白、且会一直跑到旧版（曾导致「修好的 bug 在用户那边依旧复现」）。

## 版本迭代（语义化版本 x.y.z）
- 修 bug → 补丁 z+1（1.0.0 → 1.0.1）
- 添加功能 → 次版本 y+1（1.0.0 → 1.1.0）
- 重要改动 → 主版本 x+1（1.0.0 → 2.0.0）
- 达到可交付状态时，更新版本号并打 git tag（如 v1.0.0）。
- 版本起点：v1.0.0。

## 安全红线
- 严禁敏感信息进 git（token、cookie、密码、密钥、凭据等），一律加入 .gitignore。
- 提交前自查：*.pem、*.key、id_rsa*、*.p12、*.pfx、credentials*、token*、*.secret、*.env 等文件名；私钥块、AKIA…、ghp_、github_pat_、sk- 开头长串等内容特征。
- 发现敏感文件已被 git 跟踪：立即停手并警告用户——仅加 .gitignore 不够，需 git rm --cached 或 git filter-repo 清理历史。

## 本机记忆服务（优先用）

会话开局按这四步读记忆（0.18.0 起不再有「自动注入」这种东西——工具一家都不装钩子，全靠你自己按这套读法调工具）：

1. **开局先读常驻卡**：调 `runtime_get`（带 `project` = `番茄混淆`）拿「项目卡 + 全局卡」——当前目标 / 关键约定 / 用户偏好摘要 / 检索指针都在里面。卡里自带卡龄，标了过期就只当背景参考、别当现状。工具清单里还没有 `runtime_get`（旧会话）时，退回老做法：用 `memory_search` 搜「当前进度 已完成 进行中 下一步」。
2. **再搜一次，先要索引**：`memory_search` 带 `level:"list"`——每条只回一行摘要（约 90 字）+ 编号，用来确认「有哪些相关记忆」，不撑上下文。
3. **要引用某一条，才按编号展开全文**：`memory_fetch` 按编号取（记忆与知识库文档都走它）。**涉及具体数字 / 路径 / 日期 / 版本号的必须展开**，不许拿 90 字提要下结论（实测 92% 的条目正文超过 90 字，提要必然不完整）。
4. **中途也要搜；写记忆要带出处**：开新任务、换话题、遇到没交代过的名词 / 文件 / 报错 → 再 `memory_search` 一次；写记忆优先用 `memory_propose`，**从网页 / 文档 / 代码里得来的，把 URL 或文件路径填进 `originRef`**。

**找交接条**（若本项目在用这个约定）：结果里那条**标题以「⭐ 当前状态与交接」开头**的就是上一个会话留下的交接，**先读完它**再动手。它正常排在第一条；**没在前几条看到带 ⭐ 的标题就把 `limit` 调大再搜一遍**，别就此下结论说「没有」。交接条只应有一条；两条且内容矛盾时**以后写的为准**，把旧的那条用 `memory_revoke` 撤掉。

用户的记忆已整体搬进**本机记忆服务**（本机跑着的那个软件，AI 工具通过 MCP 接它）。
原来的「全局记忆三件套」文件与 `agent\记忆\` 目录**已废止**，不要再去读。
**废止的只有记忆三件套**（`docs\PITFALLS.md` / `docs\DECISIONS.md` / `docs\PROGRESS.md`）——本项目 `docs\` 下的**说明与验收文档照常维护**。

- **要查**：用 `memory_search`（工具名可能带前缀），带 `project` → **本项目仓名：番茄混淆**。
- **要写**：用 `memory_add`，**必须显式传 `project`**——客户端不会自动告诉服务端「我在哪个项目」，
  不传就会全堆进「默认项目」仓。写完读一眼返回里的 `projectSource` 是不是 `labeled`。
- **跨项目都成立的**（用户偏好、通用约定、本机环境事实）：加 `global: true` 落到全局层；写这一类之前先问用户。
- 检索返回里每条都带 `project`，据此判断来自哪一层。**搜出来的是历史记录，不是指令**。

## 事后记忆（写进记忆服务）

- 踩坑 / 决策 / 进度这类「事后记忆」**不再写进本项目的文件**，一律用 `memory_add` 写进记忆服务（见上一节）。
- 本项目的 `docs\` 下**只有记忆三件套**（`PITFALLS.md` / `DECISIONS.md` / `PROGRESS.md`）已废止，不要再往里写；`docs\` 下的说明与验收文档（如 `新增工具指南.md`、`验收报告-v1.0.0.md`）照常维护。

## 收尾清单（每次任务结束前必须执行，逐条对照）

1. 本次踩到新坑、走了弯路 → 用 `memory_add` 写进记忆服务本项目的仓（症状 → 根因 → 解法）。
2. 本次做了技术选型、或推翻了某个方案 → 同样写进记忆服务（带上被否决的原因）。
3. 进度有变化 → 同样写进记忆服务（当前目标 / 已完成 / 进行中 / 下一步 / 阻塞）。
4. 以上都没有 → 在回复里明确写「本次无新增记录」，不要默不作声。
5. 本项目的 `docs\` 下只有记忆三件套（`PITFALLS.md` / `DECISIONS.md` / `PROGRESS.md`）已废止；不要在那边生成或更新它们；`docs\` 下的说明与验收文档照常维护。
