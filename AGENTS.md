# AGENTS.md — 番茄图片混淆 桌面版

## 项目概览
把安卓 App「番茄图片混淆」（`番茄图片混淆.apk`）的图片混淆/解混淆能力完整搬到 Windows 电脑上：免安装绿色版、纯离线、与手机版互相兼容；给身边人用的傻瓜化工具。

## 仓库结构
- `AGENTS.md`：本工作守则（动手前必读）。
- `README.md` / `README.en.md`：中文 / English 主文档（下载、快速开始、工具、MCP、构建、已知限制）。
- `CONTRIBUTING.md`：参与贡献（中英双语）。
- `CHANGELOG.md` / `CHANGELOG.en.md`：完整中文更新日志 / 近期英文摘要。
- `LICENSE` / `THIRD-PARTY-NOTICES.md`：MIT 许可 / 第三方组件与分发义务。
- `spec/`：目标规格（`00-overview.md` 全局地图 / `modules/` 各模块 / `acceptance.md` 验收标准）。
- `docs/`：文档中心（`README.md` 索引；`zh/` / `en/` 双语子文档：快速开始、工具、Agent、安全、构建、FAQ、Release Notes；`使用说明.txt`、`加装包说明.txt` 随包分发；`新增工具指南.md`、`兼容性变体说明.md`、`压缩格式性能对比.md` 为专项说明）。
- `artifacts/`：测试证据（截图等，不进 git）。
- `app/`：Electron 应用源码：
  - `main.js` / `preload.js`：主进程与安全桥（窗口、文件对话框等系统能力）。
  - `mcp/`：Agent 入口（本地 MCP server，stdio；工具清单与配置见 `app/mcp/README.md`，规格见 `spec/modules/agent-mcp.md`）。
  - `src/shell/`：工具箱框架（工具注册表、左侧导航、工具页容器、设计令牌、组件库）；**工具页保活 / LRU 回收 / 进度遮罩按页记账的机制与工具侧约定见 `spec/modules/toolkit.md`**。
  - `src/tools/<工具名>/`：各工具自包含目录（声明 + 界面 + 逻辑 + 样式）；工具清单与分组见 `README.md` 与 `src/shell/registry.js`；`_template` 为新工具模板。
  - `src/shared/`：跨工具复用能力（图片读写、ffmpeg 封装、HEIC 解码、文件封装、设置等）；含主进程专用 `unique-target-path.cjs`（输出文件名原子分配，main.js 与单测共用）。
  - `vendor/`：不走 npm 的第三方库（进 git），如 `xlsx/`（SheetJS，「PDF 转格式」降级解析用；来源与升级方法见目录内说明）。
  - `addons/`：随包加装包（不进 git：libreoffice / ffmpeg / realesrgan / asr / ocr / hibit / 7zip / ytdlp）；`docs/加装包说明.txt` 目前只写了 libreoffice / ffmpeg / realesrgan 三种，其余几种的用途与许可看 `README.md` 功能表（要补文档就补 `docs/加装包说明.txt`）。
- `app/release/`：打包产物（不进 git）。
- `番茄图片混淆.apk`：参考实现样本（只读，不修改、不覆盖）。
- `.tools/`：本机构建工具（Node 便携版等，不进 git）。

## 新增工具约定（工具箱架构）
- 新功能一律做成 `src/tools/<工具名>/` 下的独立工具，禁止写进既有工具或 shell。
- 接入步骤：复制 `src/tools/_template/` → 改 `id`/`name`/`icon`/`group`/`order` → 在 `src/shell/registry.js` 补两处（顶部 `import` ＋ 工具清单数组各一行）；详见 `docs/新增工具指南.md`。
- 左侧导航按分组显示（定义与顺序见 `shell/registry.js` 的 `GROUPS`：图片 / 视频 / 音频 / 文档 / 压缩 / 系统）：同类工具放同一组，保证用户好找；未声明 `group` 会归入末尾「其它」。
- 工具之间禁止互相 import；可复用的能力放 `src/shared/`。
- 工具界面样式只用自己的 `styles.css`，颜色/字号/间距必须引用 `shell/theme.css` 的变量。
- 工具默认纯离线；确需联网的，先与用户确认（现有唯一联网工具：「视频下载」）。

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
- 纯逻辑单测：`cd app` → `npm test`（以全绿为准；测试文件在 `tests/`，**新增测试文件必须同步加进 `pack.js` 的逐文件白名单**，否则产物里跑不起来）。
- 自检与界面自动测试：`cd app` 后运行 `.\node_modules\electron\dist\electron.exe . --<开关>`；结果都写 `%TEMP%\tomato-*.json`，判定看 `pass:true` / `ok:true`，截图在 `%TEMP%\tomato-uitest`。各开关：
  - `--smoke-test` 冒烟硬断言（工具数须等于 registry 实况；失败输出 `SMOKE_TEST_FAIL` 且进程退出码 1，可直接用于 CI）；`--self-test` 端到端（PNG 往返 + 算法 + JPG + 方块填充）。
  - `--ui-test` 图片混淆界面全流程（像素级校验；**跑前清空 `userdata/settings.json`**——有自定义 `navOrder` 时 `navSort.resetHiddenInitially` 断言必挂，产物上尤其注意）。
  - `--pdf-test` / `--pdf-ui-test` PDF 转格式；`--pdf-ocr-test` PDF 编辑整理 + 文字识别（**缺资源跳过算失败**，看 `verified` 字段）。
  - `--ocr-poc` OCR 引擎闸门（字符召回 / 耗时 / 零网络请求；开发树与产物上都要跑）。
  - `--media-test` / `--media-ui-test` 媒体三件（含 HEIC 与老图片格式输入、视频↔动图）；`--av-test` 视频压缩 + 音频剪辑；`--imgbatch-test` 批量重命名 / 加水印 / 长图拼接 / 九宫格切图。
  - `--audio-test` / `--audio-ui-test` 音频工具（21 种输出格式）；`--asr-test` / `--asr-ui-test` 语音转文字。
  - `--archive-test` / `--archive-ui-test` 压缩与解压（13 种格式真实往返；快速迭代可直跑 `node tests/archive-test.js`，`ARCHIVE_TEST_BIG_MB` 可调小大文件用例）。
  - `--player-test` / `--player-ui-test` 视频播放器；`--theme-test` 外观主题；`--settingsio-test` 设置导入导出；`--queue-ui-test` 任务中心（含「切走工具页后任务照跑完」核心断言）。
  - `--imghide-test` / `--imghide-ui-test` 文件藏图：**判定分 `ok` / `verified` 两字段**——`verified` 要求官方互通裁判在位，裁判不随包，**产物上必然 `ok:true / verified:false`（预期）；开发树交付前必须跑到 `verified:true`**。
  - `--videodl-test` / `--videodl-ui-test` 视频下载（下载源为本地小服务器现造 MP4，不依赖外网；仅引擎更新项联网）：产物自检设 `VIDEODL_TEST_SKIP_UPDATE=1`，预期 `ok:true / verified:false` 且 `skipped` 只含「引擎更新全链路」一项；开发树交付前必须 `verified:true`。**用户报「下载不了」先读产物 `userdata/videodl-history.json`**（真实链接 / 报错原文 / 失败阶段 / 时间戳都在里面）。
  - `--uninstall-test` 软件卸载（测试模式空跑，绝不真的拉起卸载工具）；`--doc-test` / `--doc-ui-test` 文档格式转换（真实 IPC 转换 + 内容读回）。
- 兼容性样本工具（锁定 variants.js 用）：
  - 造样本：`electron . --make-samples <目录> --mode <模式> [--key <密钥>]`
  - 验样本：`electron . --verify-samples <目录> --key <密钥>` → 输出 `verdict`，`meanDiff` 接近 0 即为手机版所用的模式与变体。
- 生成图标：`cd app` → `npm run icon`（产出 `src/assets/icon.png` 与 `build/icon.ico`）。
- 打包免安装版：`cd app` → `npm run pack`（产物：`app/release/番茄图片混淆-桌面版-v<版本>-win64/` 免安装文件夹 + 同名 `.zip`）。打包顺序：**步骤 5i 产物瘦身 → 8b 同步桌面快捷方式 → 8c 迁移上一版用户设置 → 9 删旧版**；步骤细节与陷阱（命名规则、硬断言、文件白名单）都写在 `pack.js` 注释里，**改打包前先读**。重复打包同一版本号时 8c 找不到旧版目录，设置迁移需手工处理。

## 改动与提交
- 每次改动完成后创建对应 git commit，便于追踪和回滚。
- 提交信息带类型前缀：fix（修 bug）/ feat（新功能）/ docs（文档）/ chore（维护）。

## 测试与发布
- 每次改动后编写或更新相关测试；**交付前必须全绿**：上文「构建与测试命令」里的全部自检与界面测试（按各自判定字段），且截图人工过目一遍；**打包产物需再跑一遍同样项目**（产物上的预期差异：文件藏图与视频下载的 `verified` 只要求 `ok:true`——裁判与联网项本就不随包）。
- 交付前把免安装版和压缩包按对应版本号整理好；删除旧文件前先评估影响。
- **用户要求：release 目录只保留最新版本**——`npm run pack` 打包成功后会自动清理其它版本的文件夹与压缩包（pack.js 步骤 9）；版本历史靠 git tag 回溯，不留旧构建产物。
- **用户要求：每次换版本必须同步桌面快捷方式**——桌面 `番茄图片混淆 桌面版.lnk` 的「目标」「起始位置」「图标位置」都必须指向当前版本的 exe/目录（含 IconLocation）。`pack.js` 步骤 8b 已在**删旧版之前**自动同步三处并读回验证，无需手工；若它失败会打警告，须手工补——漏同步会导致用户双击打不开、图标变白。

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

### 隐私防漏（硬约束）
- 私人内容（过程记录、原始证据、草稿）放 `notes/`（已整目录忽略）；要公开的文件只写结论，不写真实账号、本机用户名 / 路径、手机号。
- 提交前扫一遍暂存区：本机用户名、账号数字、`C:\Users\` 路径、密钥特征串；命中先报告用户、不许自行提交。不要装 git 钩子兜底（用户要求）。
- 提交并被推送后历史收不回来（删文件也没用）——公开仓库尤其要在推送前清干净。
- 要公开 / 推送前：跑一遍 `agent\开源工具箱\scan.mjs`（按需手动跑、只报告不拦截），命中逐条判断后再继续。

## 收尾清单（每次任务结束前必须执行，逐条对照）
1. 本次踩到新坑、走了弯路 → 记进当前工具的自带记忆（本项目那一层）：症状 → 根因 → 解法。
2. 本次做了技术选型、或推翻了某个方案 → 同样记下（带上被否决的原因）。
3. 进度有变化 → 同样记下（当前目标 / 已完成 / 进行中 / 下一步 / 阻塞）。
4. 以上都没有 → 在回复里明确写「本次无新增记录」，不要默不作声。
5. **交付前重读验收原文对表**：打开 `spec\acceptance.md` 逐条给结论——通过（附跑过的命令与输出摘要）／变形（怎么变的）／未过／未验证。**不许凭记忆打勾**，也不许用「测试都过了」代替逐条结论。
6. **文档按最终代码更新**（代码定型前不动文档）：该动哪份按本文件「仓库结构」里各文档的分工判断；同一事实（版本号、工具清单、路径表）只写在一处，别处写「见某处」；交完前把文档提到的路径、命令、名字回真实目录核一遍存在性。
7. **交付回复固定五栏**：判据逐条结果｜本次动了哪几份文档｜发现的差异（一致／文档需改／代码需改）｜跑过的验证与输出摘要｜未验证项。**空栏＝没做**——用户问一句「五栏呢」就能查岗。
