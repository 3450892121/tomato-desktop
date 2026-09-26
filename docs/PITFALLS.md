# 踩坑记录

> 规则：只追加、不重写。动手写代码前先读本文件。
> 格式固定，方便搜索与复用。

## YYYY-MM-DD 一句话症状（写上能搜到的关键词）
- 症状：报什么错 / 表现是什么
- 根因：真正的原因
- 解法：具体怎么做
- 连带影响：还要顺带改哪里

---

（下面开始记录，目前为空）
## 2026-09-27 · HEIC 解码只有一条纯离线路
- 症状：想解 HEIC 图片，Chromium 内核解不了（装系统 HEIF 扩展也不行）。
- 根因：Chromium 不支持 HEIC；ffmpeg 6.1 与 master **都没有 HEIF demuxer**（升级无用）；Windows WIC 能解但依赖系统扩展且要逐张起进程。
- 解法：**libheif WASM 是唯一纯离线方案** → heic-decode@2.1.0 + libheif-js@1.23.2，跑在主进程 worker 线程。
- 连带影响：别再花时间试其它路，这条已定。

## 2026-09-27 · APNG 必须显式指定 `-f apng`
- 症状：输出 APNG 失败，退出码 -22。
- 根因：给 `.png` 后缀时 ffmpeg 会把格式推断成单帧 image2。
- 解法：命令里显式写 `-f apng`。

## 2026-09-27 · `fs.cpSync` 在中文路径下崩溃
- 解法：改用 robocopy + 手工复制。

## 2026-09-27 · 动图 WebP 不能用 ffmpeg 校验
- 根因：webp 解复用器不认 ANIM/ANMF 块。
- 解法：用 Chromium 解码 + 容器块检查。

## 2026-09-27 · `%TEMP%\tomato-uitest` 夹具污染会让界面测试假失败
- 症状：图片混淆界面测试的张数断言失败（v1.5.0 曾把 pass 打成 False）。
- 根因：这是所有界面测试共用的夹具目录，别的测试遗留的「测试原图*」被算进来了。
- 解法：新增测试必须**开跑清一次、收尾清一次**，且清所有扩展名。

## 2026-09-27 · 重复打包同一版本号时，步骤 8c 找不到旧版目录
- 根因：旧版已被步骤 9 删掉，8c（迁移上一版设置）没东西可迁。
- 解法：pack 前把备份的设置放回旧版命名目录，或 pack 后手工放回。

## 2026-09-27 · pack.js 步骤 8b 的 powershell 必须走绝对路径
- 症状：execFileSync ENOENT → 快捷方式没同步，而步骤 9 又删了旧版 → 桌面图标指向已删除的目录（v2.7.0 实际踩到）。
- 解法：用 `%SystemRoot%\System32\...` 全路径。
- 连带影响：受限 shell 里跑 pack 时 PATH 可能缺 System32 → 连 spawnSync robocopy 都 ENOENT；命令里显式前置 System32 路径即可。

## 2026-09-27 · pack 后必须读回快捷方式三处验证
- 原因：沙箱里跑 pack，8b 写桌面 .lnk 会被拦，但步骤 9 照样删旧版 → 快捷方式悬空。
- 解法：pack 后读回 `TargetPath` / `WorkingDirectory` / `IconLocation` 三处核对。

## 2026-09-27 · `--ui-test` 要求干净的默认用户档案
- 症状：navSort 断言假失败。
- 根因：`userdata/settings.json` 里已有自定义 navOrder（v2.11.1 手改踩过；v2.12.0 是步骤 8c 从上一版产物迁移设置带进来的）。
- 解法：跑之前把 settings.json 移开，跑完放回。

## 2026-09-27 · pack.js 步骤 4 的 tests/ 是逐个文件白名单
- 解法：新增测试文件必须同步加行；否则出现「窗口开着、测试不跑、也不退出」的静默卡住（v2.8.0 踩过，v2.8.1 起全部包 try + finally app.quit 根除）。

## 2026-09-27 · LibreOffice 多语言目录命名两处规则不一致
- 症状：产出「能跑但中文丢了」的静默劣化产物。
- 根因：`program/resource/` 下是下划线名（`zh_CN`，且没有 `en_US`），`share/registry/res/` 下是连字符名（`registry_zh-CN.xcd`）。用一套连字符白名单去匹配 `resource/`，会一个都匹配不上、把中文翻译一起删光。
- 解法：两处各用对应白名单 + 硬断言（裁完必须仍有 `zh_CN`、`registry_zh-CN.xcd`、`fcfg_langpack_zh-CN.xcd`、`soffice.exe`、`locales/zh-CN.pak`）。

## 2026-09-27 · 混淆用 JPG 是有损的
- 解法：避免反复「混淆←解密」循环，画质会持续劣化。

## 2026-09-27 · 全量自检的已知偶发
- `--imgbatch-test` 批量重命名可能 EPERM（杀毒/索引器瞬时锁文件）→ **单独复跑即过，不是代码问题**。
