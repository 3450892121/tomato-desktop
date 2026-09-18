# AGENTS.md — 番茄图片混淆 桌面版

## 项目概览
把安卓 App「番茄图片混淆」（`番茄图片混淆.apk`）的图片混淆/解混淆能力完整搬到 Windows 电脑上：免安装绿色版、纯离线、与手机版互相兼容；给身边人用的傻瓜化工具。

## 仓库结构
- `AGENTS.md`：本工作守则（动手前必读）。
- `spec/`：目标规格（00-overview 全局地图 / modules 各模块 / acceptance 验收标准）。
- `app/`：Electron 应用源码（`main.js` 主进程、`preload.js` 桥接、`src/core` 算法引擎与图片读写、`src/ui` 界面）。
- `app/release/`：打包产物（不进 git）。
- `番茄图片混淆.apk`：参考实现样本（只读，不修改、不覆盖）。
- `新项目启动指令（合并版）.md`：项目流程文档（只读，修改须先征得用户同意）。
- `.tools/`：本机构建工具（Node 便携版等，不进 git）。

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
- 冒烟自检：`cd app` → `.\node_modules\electron\dist\electron.exe . --smoke-test`（输出 `SMOKE_TEST_OK options=6 …` 即界面框架正常）。
- 打包免安装版：`待定`（打包脚本尚未实现，实现后补全）。

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