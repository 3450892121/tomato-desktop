# AGENTS.md — 番茄图片混淆 桌面版

## 项目概览
把安卓 App「番茄图片混淆」（`番茄图片混淆.apk`）的图片混淆/解混淆能力完整搬到 Windows 电脑上：免安装绿色版、纯离线、与手机版互相兼容；给身边人用的傻瓜化工具。

## 仓库结构
- `AGENTS.md`：本工作守则（动手前必读）。
- `spec/`：目标规格（00-overview 全局地图 / modules 各模块 / acceptance 验收标准）。
- `app/`：Electron 应用源码：
  - `main.js` / `preload.js`：主进程与安全桥（窗口、文件对话框等系统能力）。
  - `src/shell/`：工具箱框架（页面、左侧导航、`registry.js` 工具注册表、设计令牌、通用组件）。
  - `src/tools/<工具名>/`：各工具自包含目录（声明 + 界面 + 逻辑 + 样式），`obfuscate` 为图片混淆工具，`_template` 为新工具模板。
  - `src/shared/`：跨工具复用能力（图片读写、文件封装、设置）。
- `docs/`：开发指南（如《新增工具指南》）。
- `app/release/`：打包产物（不进 git）。
- `番茄图片混淆.apk`：参考实现样本（只读，不修改、不覆盖）。
- `新项目启动指令（合并版）.md`：项目流程文档（只读，修改须先征得用户同意）。
- `.tools/`：本机构建工具（Node 便携版等，不进 git）。

## 新增工具约定（工具箱架构）
- 新功能一律做成 `src/tools/<工具名>/` 下的独立工具，禁止写进既有工具或 shell。
- 接入步骤：复制 `src/tools/_template/` → 改 `id`/`name`/`order` → 在 `src/shell/registry.js` 加一行；详见 `docs/新增工具指南.md`。
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
- 算法测试：`cd app` → `npm test`（55 项：MD5 对照、洗牌、Gilbert 覆盖、六模式往返、填充规则、密钥校验）。
- 冒烟自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --smoke-test`（输出 `SMOKE_TEST_OK tools=1 options=6 …` 与 `SMOKE_UI {...}`，界面元素完整、按钮可点即正常）。
- 端到端自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --self-test`（在界面进程里跑「PNG 无损往返 + 算法链路 + JPG 保存 + 方块填充」，输出 `SELF_TEST {...}`）。
- 界面自动测试：`cd app` → `.\node_modules\electron\dist\electron.exe . --ui-test`（模拟真人点按钮走完整流程：选图→混淆→保存→还原→批量→清空，逐步截图并做像素级校验，输出 `UI_TEST {..., "pass":true}`；截图落在 `%TEMP%\tomato-uitest`）。
- 交付前必须四套全绿：算法测试 + 冒烟自检 + 端到端自检 + 界面自动测试，且截图人工过目一遍；打包产物需再跑一次冒烟与界面自测。
- 生成图标：`cd app` → `npm run icon`（产出 `src/assets/icon.png` 与 `build/icon.ico`）。
- 打包免安装版：`cd app` → `npm run pack`（产物：`app/release/番茄图片混淆-桌面版-v<版本>-win64/` 免安装文件夹 + 同名 `.zip`；exe 图标与版本信息由 `build/rcedit.exe` 写入，缺失则跳过）。
- 兼容性样本工具（锁定 variants.js 用）：
  - 造样本：`electron . --make-samples <目录> --mode <模式> [--key <密钥>]`
  - 验样本：`electron . --verify-samples <目录> --key <密钥>` → 输出 `verdict`，`meanDiff` 接近 0 即为手机版所用的模式与变体。

## 改动与提交
- 每次改动完成后创建对应 git commit，便于追踪和回滚。
- 提交信息带类型前缀：fix（修 bug）/ feat（新功能）/ docs（文档）/ chore（维护）。

## 测试与发布
- 每次改动后编写或更新相关测试；交付前所有测试和验证必须全部通过。
- 交付前把免安装版和压缩包按对应版本号整理好；删除旧文件前先评估影响。

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