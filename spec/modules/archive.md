# 文件压缩与解压（工具：`archive`）

> 范围：主流格式 + 至少 2 种非主流格式双向、界面一致、进度与错误反馈、大文件分块、密码加密、免解压预览、跨平台压缩包、测试与文档。
> 关键前置结论（已与用户确认，四问四答）：
> 1. **RAR 仅支持解压**——RAR 是专有格式，任何免费/开源工具都**不得创建**（7-Zip 的 unRAR 代码带「不得用于制作 RAR 压缩器」的限制）。界面必须如实标注「仅解压」，不做伪装实现。
> 2. 左侧**新建「压缩」分组**（`GROUPS` 新增 `archive`）。
> 3. 引擎**随包内置 7-Zip**（`app/addons/7zip/`，LGPL 2.1+，约 2.5MB），保证「解压即用」。
> 4. 跨平台范围 = **产出的压缩包是标准格式、任何系统可解** + 引擎可替换（加装包 → 系统 PATH 的 `7z/7za`），不新增 mac/linux 打包。

## 目标
在工具箱里提供一个「文件压缩与解压」工具：把文件/文件夹打成压缩包，或把压缩包解回文件；
支持主流格式 + 若干非主流格式的**双向**操作，支持密码保护、分卷（大文件分块）、免解压预览内容列表，
并复用框架既有能力（任务队列、进度遮罩、拖拽、设置、主题变量）。

## 范围

### 格式矩阵（唯一事实来源：`src/tools/archive/core/formats.js`）
**双向（可压缩 + 可解压）**——引擎为 7-Zip 时参数见「参数拼装」：

| id | 显示名 | 扩展名 | 引擎 | 加密 | 备注 |
|---|---|---|---|---|---|
| `zip` | ZIP | `.zip` | 7z | AES-256 / ZipCrypto | 最通用；AES-256 需 7-Zip/WinRAR 打开，资源管理器打不开 |
| `7z` | 7Z | `.7z` | 7z | AES-256（含文件名加密） | 压缩率最好 |
| `tar` | TAR | `.tar` | 7z | 不支持 | 仅打包不压缩 |
| `gzip` | GZIP | `.gz` | 7z | 不支持 | 单文件流式格式 |
| `tar.gz` | TAR.GZ | `.tar.gz` | 7z | 不支持 | Linux 常见 |
| `bz2` | BZIP2 | `.bz2` | 7z | 不支持 | 单文件流式格式 |
| `tar.bz2` | TAR.BZ2 | `.tar.bz2` | 7z | 不支持 | |
| `xz` | XZ | `.xz` | 7z | 不支持 | 单文件流式格式 |
| `tar.xz` | TAR.XZ | `.tar.xz` | 7z | 不支持 | 压缩率高于 gz |
| `zst` | ZSTANDARD | `.zst` | Node zlib | 不支持 | 单文件流式格式；7-Zip 只能解不能压 |
| `tar.zst` | TAR.ZST | `.tar.zst` | 7z(tar) + Node zstd | 不支持 | |
| `br` | BROTLI | `.br` | Node zlib | 不支持 | 单文件流式格式 |
| `tar.br` | TAR.BR | `.tar.br` | 7z(tar) + Node brotli | 不支持 | |

> 主流 4 种（ZIP / 7Z / TAR / GZIP）全部双向；**非主流双向 5 种**（BZIP2 / XZ / ZSTANDARD / BROTLI 及其 TAR 组合），满足「至少 2 种」。
> `zst` / `br` 走 Node 22 内置 `zlib`（本机实测 `zstdCompressSync` / `brotliCompressSync` 均存在），不新增任何依赖。

**仅解压**（7-Zip 能识别、但免费工具不能创建）：
`rar`（RAR/RAR5）、`cab`、`iso`、`arj`、`lzh`、`cpio`、`z`、`wim`、`msi`、`deb`、`rpm`、`chm`、`dmg`、`xar`、`udf`、`vhd`、`vmdk`、`squashfs`、`cramfs`、`hfs`、`apfs`、`ext`、`ntfs`、`fat`、`qcow`、`vdi`、`mslz`、`nsis`、`swf` 等（以 `7z i` 实际输出为准）。
界面在「更多格式（仅解压）」里列出常用的十余种；**解压默认「自动识别」**（按文件签名），扩展名不对也能解。

### 非目标（本期明确不做）
- 不创建 RAR（见前置结论 1）；不提供「用 ZIP 伪装 .rar 后缀」这类欺骗性实现。
- 不做压缩包内文件的**在线编辑/增删**（只做整包压缩与整包解压；`7z d` 等改包操作不在本期）。
- 不做压缩包的**断点续传**（7-Zip CLI 不支持中断续跑；改为「分卷 + 逐项独立任务 + 失败可重试」应对大文件，见下）。
- 不做 mac/linux 打包产物（跨平台只保证**压缩包格式**与**引擎可替换**）。
- 不做压缩包内单文件的内容预览（预览 = 内容列表，不含「解出单个文件看内容」）。

### 大文件策略（对应「断点续传或分块处理」）
7-Zip CLI 无断点续传能力，本期用三条措施替代，并在使用说明中如实说明：
1. **分卷（分块）**：`-v<size>`，界面提供 不分卷 / 10MB / 100MB / 500MB / 1GB / 2GB / 4GB / 自定义；仅 `zip` / `7z` / `tar` 支持（流式单文件格式与 tar.* 不支持，界面自动禁用并说明）。解压分卷包时只选第一卷（`.001`）即可自动续接。
2. **逐项任务化**：每个「不同来源目录」是一组，整包压缩算 1 个任务；解压按压缩包逐个任务。单包失败不影响其余，可在任务中心重试。
3. **不占内存**：文件读写全部由 7-Zip / Node 流（`createReadStream` + `createZstdCompress`）完成，GB 级文件不进界面进程内存。

### 密码保护（对应「支持主流加密算法」）
| 容器 | 算法 | 参数 | 说明 |
|---|---|---|---|
| 7z | AES-256 + 文件名加密 | `-p<pw> -mhe=on` | 默认；连文件名都看不到 |
| zip | AES-256 | `-p<pw> -mem=AES256` | 安全，但 Windows 资源管理器打不开（需 7-Zip/WinRAR） |
| zip | ZipCrypto（传统） | `-p<pw> -mem=ZipCrypto` | 兼容资源管理器，但**弱加密**，界面必须标注 |
| 其余 | 不支持 | — | 界面禁用密码框并给出原因 |

## 界面
沿用工具箱既有形态与组件（`shell/components.css` 的 `card / btn / input / select / control-row`，颜色字号只用 `shell/theme.css` 变量）：
- **顶部模式切换**：`压缩` / `解压` 两个分段按钮（同一工具页内切换，不新增工具）。
- **压缩模式**
  - 参数卡：格式（分组：常用 / 非主流 / 更多·仅解压）、压缩级别（存储/最快/较快/标准/较小/极限）、分卷、密码 + 加密方式（选 zip 时）、输出位置（原处旁边 / 设置里的输出目录）。
  - 文件区：添加文件 / 添加文件夹 / 拖拽入窗；列表显示名称、大小、来源目录、移除；重复基名自动加序号并提示。
  - 底部：开始压缩 / 清空 / 结果行（产物路径与体积、压缩率、耗时）。
- **解压模式**
  - 参数卡：输出目录（默认压缩包旁边的同名文件夹）、覆盖策略（跳过已存在 / 覆盖）、目录结构（保留 / 全部平铺）、密码。
  - 压缩包列表：添加压缩包 / 拖拽；每项显示格式识别结果与体积。
  - **内容预览**：选中一个压缩包即调用 `archive:list`（`7z l -slt`，**不解压**）展示条目表：名称 / 原始大小 / 压缩后 / 修改时间 / 加密标记；含搜索框与汇总（条目数、总大小、压缩率）。
  - 底部：开始解压 / 清空 / 结果行。
- **状态与错误**：顶栏 `ctx.setStatus`、全屏进度 `ctx.showProgress` + 进度百分比与当前文件；错误给可读中文（密码错误 / 文件被占用 / 磁盘空间不足 / 格式不支持）并保留原始 7-Zip 尾部输出便于排障。

## 参数拼装（`core/params.js`，纯函数、可单测）
- 压缩：`a -t<type> -mx=<0|1|3|5|7|9> -bsp1 -bb1 -y [-p<pw>] [-mhe=on] [-mem=AES256|ZipCrypto] [-v<size>] <archive> <names...>`（`cwd` = 各来源目录）
- 解压：`x -bsp1 -bb1 -y [-p<pw>] [-aoa|-aos] [-e] -o<dir> <archive>`
- 列表：`l -slt -ba [-p<pw>] <archive>`
- 分卷识别：`.001` / `.7z.001` 视为首卷，解压时自动指向首卷。
- **多趟解压**：`tar.gz / tar.bz2 / tar.xz / tar.zst / tar.br` 需要两趟（先解外层得到 `.tar`，再解 tar）；实现为「解压后若输出目录只多出一个 `.tar` 且原格式为 tar.*，则继续解该 tar 并删除中间文件」。
- **压缩级别映射**：`store→-mx=0`、`fastest→-mx=1`、`fast→-mx=3`、`normal→-mx=5`、`small→-mx=7`、`extreme→-mx=9`；Node 侧 `zstd level = [1,1,3,6,15,19]`、`brotli quality = [0,1,4,6,9,11]`。
- **路径安全**：条目的绝对路径或含 `..` 视为可疑，列表中标红、解压时拒绝执行该包（防止 zip-slip 路径穿越）。**闸门基于完整列表输出**（v2.8.1 起）：`7z l` 的 stdout 不做「只留尾部」截断（那会让归档头部的可疑条目漏检、绕过闸门）；超上限（64MB）列不完的极端大包直接拒绝列出与解压——宁可拒绝，不可漏检。

## 引擎与加装包
- 位置：`app/addons/7zip/7z.exe` + `7z.dll` + `License.txt` + `说明.txt`（版本 / 来源 / 许可）。查找顺序：加装包 → 系统 PATH 的 `7z` / `7za` → 常见安装目录（`C:\Program Files\7-Zip\7z.exe`）。
- 缺失时：工具顶部显示「未检测到 7-Zip 加装包」与放置说明，`zst` / `br` 两个 Node 原生格式仍可用（如实标注哪些格式因此不可用）。
- `pack.js` 新增步骤 5g 随包复制；测试文件（`archive-test.js` / `archive-ui-test.js`）同步加入步骤 4。
- 许可：7-Zip 为 **GNU LGPL 2.1+（unRAR 部分带额外限制）**，随包附 `License.txt`；加装包**不进 git**（与 ffmpeg / asr / ocr / realesrgan 一致）。

## 主进程接线（`main.js`）
| 通道 | 入参 | 返回 |
|---|---|---|
| `archive:status` | — | `{found, where:'addon'|'system'|'path', version, path, node:{zstd, brotli}}` |
| `archive:list` | `{archivePath, password?}` | `{ok, entries[], summary{}, format, suspicious[], message?}` |
| `archive:create` | `{inputs[], format, level, password?, encrypt?, volumeBytes?, outputDir?, baseName?, jobId}` | `{ok, paths[], size, ms, groups}` |
| `archive:extract` | `{archivePath, outputDir?, password?, overwrite?, flatten?, jobId}` | `{ok, dir, files, ms}` |
| `archive:cancel` | `jobId` | `{ok}` |
| `archive:progress`（事件） | — | `{jobId, percent, text}` |

- 专用对话框：`dialog:open-archive-files`（可多选文件+文件夹）、`dialog:open-archives`（压缩包，含「仅解压」扩展名）；测试模式返回 `测试压缩*` 夹具（**独立前缀**，避免污染其它工具夹具）。
- 进度解析：7-Zip `-bsp1` 的 `NN%` + `-bb1` 的当前文件名；Node 流按字节数上报。取消 = 杀整棵进程树（复用既有 `killConvertTree`）。
- 产物不覆盖已有文件：重名自动加序号（复用既有 `uniqueTargetPath`）。

## 测试
- **纯逻辑单测** `app/tests/archive.test.mjs`（挂进 `npm test`）：格式矩阵自洽（双向格式必有 create 参数、仅解压格式必无 create）、级别映射、分卷参数、多趟解压判定、`7z l -slt` 输出解析（含加密/目录/中文名）、路径穿越识别、重名序号、进度行解析。
- **引擎自检** `app/tests/archive-test.js`（`electron . --archive-test`）：对**每一个双向格式**做真实「压缩 → 列目录 → 解压 → 逐字节比对」；密码往返（7z AES-256 含文件名加密、zip AES-256、zip ZipCrypto）；错误密码必须失败且不产出垃圾；分卷往返（解第一卷还原全部）；仅解压格式清单核对；大文件（≥100MB 伪随机）压缩耗时与内存记录；结果写 `%TEMP%\tomato-archive-test.json`，`ok:true` 为通过。
- **界面自动测试** `app/tests/archive-ui-test.js`（`electron . --archive-ui-test`）：切到工具 → 压缩（7z）→ 校验产物 → 切解压模式 → 预览列表断言 → 解压 → 内容比对 → 密码往返 → 分卷往返 → 清空；逐步截图 `shot-archive-*.png`，结果写 `%TEMP%\tomato-archive-ui-test.json`，`pass:true` 为通过。
- **夹具纪律**：开跑前、收尾后各清一次 `%TEMP%\tomato-uitest\测试压缩*`（含所有扩展名），绝不残留其它工具会误选的夹具。

## 验收
- 4 个主流格式 + ≥2 个非主流格式**双向**全部真实往返成功，逐字节一致。
- 密码：7z AES-256（含文件名加密）、zip AES-256、zip ZipCrypto 三种往返成功；错误密码给出可读错误且不产出空文件。
- 分卷：压出的 `.001` 起首卷能独立解出完整内容。
- 预览：`7z l -slt` 解析出的条目数/名称/大小与真实内容一致，且**全程未解压**（断言解压目录不存在）。
- 仅解压格式：界面标注「仅解压」，选中后压缩按钮禁用并给出原因。
- 大文件：≥100MB 文件压缩/解压成功（记录耗时与峰值内存），且压缩过程界面进程内存无 GB 级增长。
- 引擎缺失：隐藏加装包后工具给出放置说明，`zst`/`br` 仍可用，其余功能不崩。
- 文档：使用说明（面向使用者）、技术实现与格式性能对比（含各格式压缩率/耗时实测表）、测试报告（逐条对照）。

## 关键事实来源
- `7z i` 本机实测输出（7-Zip 26.03 x64）：可创建 = `7z / zip / tar / gzip / bzip2 / xz / wim`；`rar`/`rar5` 无 `C` 标志（仅解压）；`zstd` 无 `C` 标志（仅解压）。
- Node v22.20.0 实测：`zlib.zstdCompressSync` / `zlib.brotliCompressSync` / `zlib.createZstdCompress` 存在。
- 7-Zip 官方文档：`-mx` 级别、`-mhe`、`-mem=AES256`、`-v` 分卷、`-bsp1` 进度、`-slt` 详细列表。
- RAR 许可限制：7-Zip `License.txt` 的 unRAR restriction（不得用于创建 RAR 压缩器）。
