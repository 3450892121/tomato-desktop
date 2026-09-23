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
  - `src/shell/`：工具箱框架（工具页容器、左侧导航、`registry.js` 工具注册表、`theme.css` 设计令牌、`components.css` 通用组件库）。**工具页保活（只保「动过」的页）**：切换工具不销毁页面，切回时列表/输入/预览/滚动位置与顶栏提示全部保留；没动过的页（只是点开看看）切走即静默释放、不占额度，免得「随便看看」挤掉别处用过的东西；动过的页上限 5 页，超出按 LRU 回收最久没用过的那页（当前页不回收，回收时提示「已自动释放」）；工具里的全局交互要用 `ctx.isActive()` 让位，被释放/回收时会走 `unmount()` 清理。
  - `src/tools/<工具名>/`：各工具自包含目录（声明 + 界面 + 逻辑 + 样式）。现有：`obfuscate` 图片混淆、`pdf-convert` PDF 转格式、`compress` 图片压缩、`enhance` 图片变清晰、`img-convert` 图片格式转换、`batch-rename` 批量重命名、`watermark` 加水印、`stitch` 长图拼接、`grid-slice` 九宫格切图、`player` 视频播放器、`video-convert` 视频格式转换、`video-compress` 视频压缩、`sticker` 动图与视频互转、`audio-convert` 音频格式转换、`audio-edit` 音频剪辑、`transcribe` 语音转文字、`pdf-edit` PDF 编辑整理、`ocr` 文字识别、`archive` 压缩与解压、`imghide` 文件藏图、`uninstall` 软件卸载；`_template` 为新工具模板。
  - `src/shared/`：跨工具复用能力（图片读写、ffmpeg 封装与编码参数、HEIC/HEIF 解码封装、文件封装、设置、设置键值校验、HTML 转义）。
  - `vendor/`：不走 npm 的第三方库（进 git）：`xlsx/`（SheetJS 0.20.3，「PDF 转格式」内置降级解析 Excel 用；npm 版停在 0.18.5 有已知漏洞，官方分发货道是 cdn.sheetjs.com，来源与升级方法见 `vendor/xlsx/说明.txt`）。
  - `addons/`：随包加装包（不进 git）：`libreoffice/`（PDF→Word 与高保真 Office→PDF，可选）、`ffmpeg/`（视频/动图工具必需，单文件 83MB，GPL v3）、`realesrgan/`（「图片变清晰」的 AI 放大，约 50MB，BSD 3-Clause，需 Vulkan 显卡）、`asr/`（「语音转文字」的 FunASR·SenseVoice 识别引擎，约 246MB，MIT，纯 CPU）、`ocr/`（「文字识别」的 PP-OCRv5 mobile ONNX 模型，约 20MB，Apache-2.0 模型 + MIT 运行时，纯 CPU）、`hibit/`（「软件卸载」随包内置的 HiBit Uninstaller 4.0.10 官方便携版，单文件 15.4MB，官网标注个人与商业使用均免费，**启动需管理员权限**——exe 清单即 `requireAdministrator`）、`7zip/`（「压缩与解压」引擎，约 2.4MB，LGPL 2.1+）；许可与来源见各自目录的 LICENSE/说明.txt。
- `docs/`：开发指南（如《新增工具指南》）。
- `app/release/`：打包产物（不进 git）。
- `番茄图片混淆.apk`：参考实现样本（只读，不修改、不覆盖）。
- `新项目启动指令（合并版）.md`：项目流程文档（只读，修改须先征得用户同意）。
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
- 改已有文件一律保留原内容、追加式修改；动手前先读原文。
- 选型（依赖/工具/方案）需评估安全、稳定、兼容与成本并给出来源依据；优先免费零本地方案。

## spec/ 目标规格
- 动手前先读 spec/：`00-overview.md` 全局地图，`modules/<模块名>.md` 模块目标与边界，`acceptance.md` 验收标准。
- 新增功能先补 spec 再写代码；实现与 spec 冲突时停下问用户，不得改 spec 凑实现。

## 构建与测试命令
- Node 环境：`.tools/node/node.exe`（便携版 v22.20.0，不进 git；命令行里先把 `.tools/node` 加入 PATH）。
- 安装依赖：`cd app` → `npm install`（npm registry 用 `https://registry.npmmirror.com`；Electron 二进制需设 `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/`）。
- 启动调试：`cd app` → `npm start`。
- 算法测试：`cd app` → `npm test`（连跑纯逻辑单测共 250 项：算法 55 项（MD5 对照、洗牌、Gilbert 覆盖、六模式往返、填充规则、密钥校验）+ 任务队列 13 项 + 压缩与解压 71 项 + 文件藏图 40 项 + 导航排序 33 项（v2.6.0 起，`tests/navorder.test.mjs`）+ 软件卸载 19 项（v2.8.0 起，`tests/uninstall.test.mjs`）+ 设置校验与转义 19 项（v2.8.1 起，`tests/settingsschema.test.mjs`）。
- 冒烟自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --smoke-test`（输出 `SMOKE_TEST_OK tools=9 options=6 …` 与 `SMOKE_UI {...}`，界面元素完整、按钮可点即正常）。
- 端到端自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --self-test`（在界面进程里跑「PNG 无损往返 + 算法链路 + JPG 保存 + 方块填充」，输出 `SELF_TEST {...}`）。
- 界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --ui-test`（模拟真人点按钮走完整流程：选图→混淆→保存→还原→批量→清空，逐步截图并做像素级校验，输出 `UI_TEST {..., "pass":true}`；截图落在 `%TEMP%\tomato-uitest`）。
- PDF 工具自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --pdf-test`（pdfjs 渲染 / 图片↔PDF 往返 / 合并拆分提取 / 内置降级 docx·xlsx→PDF / 界面接线；结果写 `%TEMP%\tomato-pdf-test.json`，`ok:true` 为通过）。
- PDF 工具界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --pdf-ui-test`（五个方向真人操作 + 截图；结果写 `%TEMP%\tomato-pdf-ui-test.json`，`pass:true` 为通过）。
- 媒体工具自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --media-test`（图片压缩/变清晰/格式转换的核心逻辑 + HEIC/HEIF 手机格式输入（主进程 libheif 引擎：尺寸/旋转/坏文件/HEIC→PNG 产物，夹具在 `tests/assets/`）+ 视频↔动图链路：ffmpeg 造夹具、真实转码、逐个解码校验；结果写 `%TEMP%\tomato-media-test.json`，`ok:true` 为通过）。
- 媒体工具界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --media-ui-test`（5 个新工具逐个「切工具→添加→运行」，截图并校验新增产物可被 ffmpeg 完整解码；结果写 `%TEMP%\tomato-media-ui-test.json`，`pass:true` 为通过）。
- 音频工具自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --audio-test`（21 种输出格式真实转码 + 逐个回读校验 + 视频提取音频 + 标签保留 + 无效文件报错 + 计划逻辑单测；结果写 `%TEMP%\tomato-audio-test.json`，`ok:true` 为通过）。
- 音频工具界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --audio-ui-test`（切工具→选输出格式→两轮转码 M4A/OGG→清空，截图并校验产物可完整解码；结果写 `%TEMP%\tomato-audio-ui-test.json`，`pass:true` 为通过）。
- 语音转文字自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --asr-test`（SAPI 离线合成中文语音夹具 → 真实识别 + 关键词校验 + .txt/.srt 落盘校验 + 视频提取音轨链路 + 无效文件报错 + 计划逻辑单测；结果写 `%TEMP%\tomato-asr-test.json`，`ok:true` 为通过）。
- 语音转文字界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --asr-ui-test`（切工具→添加音频/视频→两轮识别（文本+字幕 / 纯文本重名不覆盖）→清空，截图并校验产物内容；结果写 `%TEMP%\tomato-asr-ui-test.json`，`pass:true` 为通过）。
- 外观主题自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --theme-test`（顶栏三态循环 → 浅色/深色两套色值 rgb 断言 → 落盘断言 → 9 个工具页深色下浅色残留扫描 → 恢复用户原档位；截图 `shot-theme-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-theme-test.json`，`pass:true` 为通过）。
- OCR 引擎闸门（P0）：`cd app` → `.\node_modules\electron\dist\electron.exe . --ocr-poc`（界面进程画中文扫描件夹具 → 主进程用 `app/addons/ocr/` 本地模型识别 → 字符召回/耗时/零网络请求三项判据；结果写 `%TEMP%\tomato-ocr-poc.json`，`ok:true` 为通过）。
- 媒体工具（A 批）自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --av-test`（「视频压缩」+「音频剪辑」两个工具：纯逻辑断言 + 真实 ffmpeg 转码（含两遍编码与多段拼接）+ 界面走查与截图；结果写 `%TEMP%\tomato-av-test.json`，另有各工具明细 `tomato-video-compress(-ui)-test.json`、`tomato-audio-edit(-ui)-test.json`，`ok:true` 为通过）。
- 图片批量工具（B 批）自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --imgbatch-test`（「批量重命名 / 加水印 / 长图拼接 / 九宫格切图」四个工具：纯逻辑断言 + 真实处理与像素校验 + 界面走查与截图；结果写 `%TEMP%\tomato-imgbatch-test.json`，另有各工具明细，`ok:true` 为通过）。
- C 批工具自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --pdf-ocr-test`（「PDF 编辑整理」+「文字识别」：七类 PDF 操作读回校验 + OCR 真实识别与可搜索 PDF 关键词命中 + 界面走查与截图；结果写 `%TEMP%\tomato-pdf-ocr-test.json`，`ok:true` 为通过）。
- 任务队列自检：`cd app` → `node tests/taskqueue.test.mjs`（纯逻辑：通道并发上限 cpu=1/io=2、通道隔离、进度聚合、取消 queued/running、失败与 retry、最近完成、runBatch、waitFor；已挂进 `npm test`，通过 13 项）。
- 任务中心界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --queue-ui-test`（顶栏任务入口与徽标、任务中心开合与空态、真实转码批量、**核心断言：切走工具页并触发 LRU 回收后任务照跑完且产物可被 ffmpeg 完整解码**、取消排队任务、清空已完成；截图 `shot-queue-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-queue-ui-test.json`，`pass:true` 为通过）。**注意：该开关需先在 `main.js` 接线（见 `spec/modules/task-queue.md` 末节清单）。**
- 设置导入导出自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --settingsio-test`（导出结构合法 + 导入能把改掉的设置恢复 + 未知键忽略 + 野文件拒绝且不破坏现有设置 + 结束恢复用户原设置；结果写 `%TEMP%\tomato-settingsio-test.json`，`pass:true` 为通过）。
- 视频播放器自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --player-test`（纯逻辑 29 项 + 本地媒体协议 200/206/Range/404 + 7 种格式夹具端到端「探测→计划→准备副本→真实 `<video>` 播放」+ 缓存命中 + 无效文件报错；结果写 `%TEMP%\tomato-player-test.json`，`ok:true` 为通过）。
- 视频播放器界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --player-ui-test`（切工具→打开 MP4 直接播→播放/暂停/拖动/音量/静音/全屏/快捷键→MKV 换封装→AVI 重编码（含进度覆盖层）→切走自动暂停与状态保留→LRU 回收后缓存清空→拖入非视频给出提示；截图 `shot-3x-播放器-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-player-ui-test.json`，`pass:true` 为通过）。
- 文件藏图自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --imghide-test`（**两套容器都验**：动态混淆（极速）整文件往返 + 官方 `action='decrypt'` 不解密直接读（证明网页版不弹密码框）；图夹 PRO 的 PNG/GIF 往返 + 密码 + 官方双向互通（裁判放 `.tools/tujia-oracle/decryptWorker.js`，不进 git）+ 容错与路径穿越；结果写 `%TEMP%\tomato-imghide-test.json`，`ok:true` 为通过）。
- 软件卸载自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --uninstall-test`（加装包在位 + **SHA-256 与 `addons/hibit/说明.txt` 记录一致** + exe 清单权限 `requireAdministrator` + 提权命令构造 + `hibit:status` IPC + 界面走查（分组/按钮/状态卡/顶栏）+ **测试模式空跑并用 `tasklist` 断言进程未拉起** + 缺失降级（临时藏起 exe 再还原，带自愈）；截图 `shot-uninstall-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-uninstall-test.json`，`pass:true` 为通过）。
- 文件藏图界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --imghide-ui-test`（切工具→随机表图→加文件→打包→产物校验与解码→解包比对→自定义表图+水印→图夹 PRO+密码往返（错误密码被拒）→体积提示两模式→清空；截图 `shot-imghide-*.png` 落 `%TEMP%\tomato-uitest`，结果写 `%TEMP%\tomato-imghide-ui-test.json`，`pass:true` 为通过）。
- 交付前必须全绿：算法测试 + 冒烟自检 + 端到端自检 + 界面自动测试 + PDF 工具自检 + PDF 工具界面自动测试 + 媒体工具自检 + 媒体工具界面自动测试 + 音频工具自检 + 音频工具界面自动测试 + 语音转文字自检 + 语音转文字界面自动测试 + 外观主题自检 + OCR 引擎闸门 + 媒体工具（A 批）自检 + 图片批量工具（B 批）自检 + 设置导入导出自检 + C 批工具自检 + 视频播放器自检 + 视频播放器界面自动测试 + 文件藏图自检 + 文件藏图界面自动测试 + 软件卸载自检，且截图人工过目一遍；打包产物需再跑一次冒烟与各界面自测。
- 生成图标：`cd app` → `npm run icon`（产出 `src/assets/icon.png` 与 `build/icon.ico`）。
- 打包免安装版：`cd app` → `npm run pack`（产物：`app/release/番茄图片混淆-桌面版-v<版本>-win64/` 免安装文件夹 + 同名 `.zip`；exe 图标与版本信息由 `build/rcedit.exe` 写入，缺失则跳过）。打包顺序：步骤 8b 同步桌面快捷方式 → **步骤 8c 迁移上一版的用户设置**（`userdata/settings.json`，升级不丢排序/折叠偏好）→ 步骤 9 删旧版。
  - 重复打包**同一版本号**会先清空产物目录，此时 8c 找不到旧版目录可迁移（旧版已被步骤 9 删掉）——需要在 pack 前把上一步备份的用户设置放回一个旧版本命名的目录（本机实测流程见 CHANGELOG v2.7.1），或 pack 后手工放回新产物的 `userdata/`。
  - **`pack.js` 步骤 4 的 `tests/` 是「逐个文件白名单」**：新增测试文件必须同步加一行，否则产物里缺文件；而主进程 `require('./tests/xxx.js')` 在 try 之外，缺文件会表现为「窗口开着、测试不跑、也不退出」的**静默卡住**（不是报错）——v2.8.0 首次打包实际踩到过。新增测试后请 grep 确认：产物 `resources/app/tests/` 里文件齐全。
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