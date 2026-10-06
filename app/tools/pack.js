// 打包免安装版：把 Electron 运行时 + 应用源码组装成一个绿色文件夹，并压缩成 zip
// 用法：cd app && npm run pack
// 产物：app/release/番茄图片混淆-桌面版-v<版本>-win64/（可直接运行）与同名 .zip
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const appRoot = path.join(__dirname, '..');       // app/
const repoRoot = path.join(appRoot, '..');        // 仓库根
const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const exeName = '番茄图片混淆桌面版.exe';
const folderName = `番茄图片混淆-桌面版-v${version}-win64`;
const releaseRoot = path.join(appRoot, 'release');
const outDir = path.join(releaseRoot, folderName);

const log = (msg) => console.log(`[pack] ${msg}`);

/** 递归复制目录（不用 fs.cpSync：它在中文路径下会异常崩溃） */
function copyTree(src, dst) {
  const stat = fs.statSync(src);
  if (!stat.isDirectory()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    copyTree(path.join(src, entry.name), path.join(dst, entry.name));
  }
}

// —— 1) 准备输出目录 ——
try {
  fs.rmSync(outDir, { recursive: true, force: true });
} catch (err) {
  if (err.code === 'EBUSY' || err.code === 'EPERM') {
    throw new Error(
      `输出目录被占用：${outDir}\n请先关闭正在运行的「番茄图片混淆桌面版」再重新打包（或手动删除该文件夹）。`
    );
  }
  throw err;
}
fs.mkdirSync(outDir, { recursive: true });

// —— 2) 复制 Electron 运行时，去掉自带示例应用 ——
// 说明：体积大（200MB+）且含超大 exe，用 Windows 自带 robocopy 复制最稳（退出码 <8 视为成功）
const electronDist = path.join(appRoot, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(electronDist)) {
  throw new Error('未找到 Electron 运行时：请先在 app 目录执行 npm install');
}
log('复制 Electron 运行时（约 200MB，稍等）…');
const rc = spawnSync('robocopy', [electronDist, outDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'], {
  stdio: 'ignore'
});
if (rc.error) throw new Error(`robocopy 无法启动：${rc.error.message}`);
if (typeof rc.status === 'number' && rc.status >= 8) throw new Error(`robocopy 复制失败（退出码 ${rc.status}）`);
fs.rmSync(path.join(outDir, 'resources', 'default_app.asar'), { force: true });
fs.rmSync(path.join(outDir, 'resources', 'app'), { recursive: true, force: true });

// —— 3) 主程序改名（用户双击它启动） ——
log('步骤3：重命名主程序');
fs.renameSync(path.join(outDir, 'electron.exe'), path.join(outDir, exeName));

// —— 4) 复制应用源码（只带运行必需内容，不含测试与开发工具） ——
log('步骤4：复制应用源码');
const appTarget = path.join(outDir, 'resources', 'app');
fs.mkdirSync(appTarget, { recursive: true });
fs.copyFileSync(path.join(appRoot, 'main.js'), path.join(appTarget, 'main.js'));
fs.copyFileSync(path.join(appRoot, 'preload.js'), path.join(appTarget, 'preload.js'));
copyTree(path.join(appRoot, 'src'), path.join(appTarget, 'src'));
// 附带自检脚本：打包产物可用 `--ui-test` / `--pdf-test` 自检（交付前验收用）
fs.mkdirSync(path.join(appTarget, 'tests'), { recursive: true });
fs.copyFileSync(path.join(appRoot, 'tests', 'ui-test.js'), path.join(appTarget, 'tests', 'ui-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'pdf-test.js'), path.join(appTarget, 'tests', 'pdf-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'pdf-ui-test.js'), path.join(appTarget, 'tests', 'pdf-ui-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'media-test.js'), path.join(appTarget, 'tests', 'media-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'media-ui-test.js'), path.join(appTarget, 'tests', 'media-ui-test.js'));
// 说明：v1.6.0 曾漏拷音频测试文件（打包产物跑不了 --audio-test/--audio-ui-test）；本次补齐，并带上语音转文字测试
fs.copyFileSync(path.join(appRoot, 'tests', 'audio-test.js'), path.join(appTarget, 'tests', 'audio-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'audio-ui-test.js'), path.join(appTarget, 'tests', 'audio-ui-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'asr-test.js'), path.join(appTarget, 'tests', 'asr-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'asr-ui-test.js'), path.join(appTarget, 'tests', 'asr-ui-test.js'));
// v1.10.0 起：外观主题自检；OCR 引擎 POC 闸门（P0，验证加装包与引擎可用）
fs.copyFileSync(path.join(appRoot, 'tests', 'theme-test.js'), path.join(appTarget, 'tests', 'theme-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'ocr-poc.js'), path.join(appTarget, 'tests', 'ocr-poc.js'));
// v1.11.0 起：A 批媒体工具（视频压缩 / 音频剪辑）自检
fs.copyFileSync(path.join(appRoot, 'tests', 'av-test.js'), path.join(appTarget, 'tests', 'av-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'video-compress-test.js'), path.join(appTarget, 'tests', 'video-compress-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'audio-edit-test.js'), path.join(appTarget, 'tests', 'audio-edit-test.js'));
// v1.12.0 起：B 批图片工具（批量重命名 / 加水印 / 长图拼接 / 九宫格切图）自检
fs.copyFileSync(path.join(appRoot, 'tests', 'imgbatch-test.js'), path.join(appTarget, 'tests', 'imgbatch-test.js'));
for (const f of ['batch-rename-test.js', 'watermark-test.js', 'stitch-test.js', 'grid-slice-test.js']) {
  fs.copyFileSync(path.join(appRoot, 'tests', f), path.join(appTarget, 'tests', f));
}
// v1.12.1 起：设置导入导出自检
fs.copyFileSync(path.join(appRoot, 'tests', 'settingsio-test.js'), path.join(appTarget, 'tests', 'settingsio-test.js'));
// v1.13.0 起：C 批工具（PDF 编辑整理 / 文字识别）自检
fs.copyFileSync(path.join(appRoot, 'tests', 'pdf-ocr-test.js'), path.join(appTarget, 'tests', 'pdf-ocr-test.js'));
for (const f of ['pdf-edit-test.js', 'ocr-test.js']) {
  fs.copyFileSync(path.join(appRoot, 'tests', f), path.join(appTarget, 'tests', f));
}
// v2.0.0 起：任务中心自检（含「切走工具页后任务继续跑完」核心断言）
fs.copyFileSync(path.join(appRoot, 'tests', 'queue-ui-test.js'), path.join(appTarget, 'tests', 'queue-ui-test.js'));
// v2.2.0 起：文件压缩与解压（引擎自检 + 界面自动测试）
fs.copyFileSync(path.join(appRoot, 'tests', 'archive-test.js'), path.join(appTarget, 'tests', 'archive-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'archive-ui-test.js'), path.join(appTarget, 'tests', 'archive-ui-test.js'));
// v2.3.0 起：视频播放器（自检 + 界面自动测试）
fs.copyFileSync(path.join(appRoot, 'tests', 'player-test.js'), path.join(appTarget, 'tests', 'player-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'player-ui-test.js'), path.join(appTarget, 'tests', 'player-ui-test.js'));
// v2.4.0 起：文件藏图（自检 + 界面自动测试；互通裁判是对方的代码，**不随包分发**，
//   所以产物上跑自检必然得到 ok:true / verified:false —— 官方互通只能在开发树上验证）
fs.copyFileSync(path.join(appRoot, 'tests', 'imghide-test.js'), path.join(appTarget, 'tests', 'imghide-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'imghide-ui-test.js'), path.join(appTarget, 'tests', 'imghide-ui-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'tujia-oracle.js'), path.join(appTarget, 'tests', 'tujia-oracle.js'));
// v2.6.0 起：导航手动排序（排序净化纯逻辑，挂 npm test）
fs.copyFileSync(path.join(appRoot, 'tests', 'navorder.test.mjs'), path.join(appTarget, 'tests', 'navorder.test.mjs'));
// v2.8.0 起：软件卸载（自检 + 提权命令构造纯逻辑）
// ★ 注意：这里是**逐个文件的白名单**——新增测试文件必须同步加一行，否则产物里缺文件、
//   该测试在产物上跑不起来（早期版本踩过这个坑）。
//   v2.8.1 起主进程的 require 已包在 try 里、且 finally 必 app.quit()，所以缺文件现在是
//   「打 <TAG>_FAIL + 堆栈后退出」，不再是当年那种「窗口开着、不跑也不退」的静默卡住。
fs.copyFileSync(path.join(appRoot, 'tests', 'uninstall-test.js'), path.join(appTarget, 'tests', 'uninstall-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'uninstall.test.mjs'), path.join(appTarget, 'tests', 'uninstall.test.mjs'));
// v2.12.0 起：视频下载（自检 + 界面自动测试 + 纯逻辑）
fs.copyFileSync(path.join(appRoot, 'tests', 'videodl-test.js'), path.join(appTarget, 'tests', 'videodl-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'videodl-ui-test.js'), path.join(appTarget, 'tests', 'videodl-ui-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'videodl.test.mjs'), path.join(appTarget, 'tests', 'videodl.test.mjs'));
// v2.13.0 起：文档格式转换（引擎自检 + 界面自动测试 + 纯逻辑）；老图片格式输入在 media-test 的 oldimage 段
fs.copyFileSync(path.join(appRoot, 'tests', 'doc-test.js'), path.join(appTarget, 'tests', 'doc-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'doc-ui-test.js'), path.join(appTarget, 'tests', 'doc-ui-test.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'docconvert.test.mjs'), path.join(appTarget, 'tests', 'docconvert.test.mjs'));
// 兼容性样本工具（--make-samples / --verify-samples，锁定 variants.js 用）。
// main.js 里是独立 if 分支 require 它们、不走 AUTO_TESTS 表，所以白名单容易漏——
// 漏了产物上这两个命令只会打 MAKE_SAMPLES_FAIL / VERIFY_SAMPLES_FAIL。
fs.copyFileSync(path.join(appRoot, 'tests', 'make-samples.js'), path.join(appTarget, 'tests', 'make-samples.js'));
fs.copyFileSync(path.join(appRoot, 'tests', 'verify-samples.js'), path.join(appTarget, 'tests', 'verify-samples.js'));
// v2.10.0 起：HEIC/HEIF 解码引擎（「图片格式转换」的手机格式输入）——worker 线程脚本 + media-test 的 HEIC 夹具
fs.copyFileSync(path.join(appRoot, 'heic-worker.js'), path.join(appTarget, 'heic-worker.js'));
copyTree(path.join(appRoot, 'tests', 'assets'), path.join(appTarget, 'tests', 'assets'));

// —— 4b) 复制 PDF 工具运行时依赖（纯 JS，界面进程按相对路径直接引用） ——
// 说明：本项目没有打包器，工具代码里写的是 ../../../../node_modules/pdfjs-dist/... 这样的
// 相对路径；绿色版没有 npm，必须把用到的文件原样带过去（路径结构保持一致）。
log('步骤4b：复制 PDF 依赖（pdfjs-dist / pdf-lib）');
const nmSrc = path.join(appRoot, 'node_modules');
const nmDst = path.join(appTarget, 'node_modules');
const copyIfExists = (relPath) => {
  const from = path.join(nmSrc, relPath);
  if (!fs.existsSync(from)) throw new Error(`缺少 PDF 依赖文件：${relPath}（请先在 app 目录 npm install）`);
  copyTree(from, path.join(nmDst, relPath));
};
// pdfjs-dist：主构建 + worker + 中文等 CID 字体所需的 cmaps / 标准字体数据
copyIfExists(path.join('pdfjs-dist', 'build', 'pdf.mjs'));
copyIfExists(path.join('pdfjs-dist', 'build', 'pdf.worker.mjs'));
copyIfExists(path.join('pdfjs-dist', 'cmaps'));
copyIfExists(path.join('pdfjs-dist', 'standard_fonts'));
copyIfExists(path.join('pdfjs-dist', 'LICENSE'));
// pdf-lib：界面进程用 ESM 产物；自检脚本（Node）用 UMD 产物
copyIfExists(path.join('pdf-lib', 'dist', 'pdf-lib.esm.js'));
copyIfExists(path.join('pdf-lib', 'dist', 'pdf-lib.js'));
copyIfExists(path.join('pdf-lib', 'LICENSE.md'));
// 内置降级（Word/Excel→PDF）用：docx-preview + JSZip 的 UMD 构建
copyIfExists(path.join('docx-preview', 'dist', 'docx-preview.js'));
copyIfExists(path.join('docx-preview', 'LICENSE'));
copyIfExists(path.join('jszip', 'dist', 'jszip.min.js'));
copyIfExists(path.join('jszip', 'LICENSE.markdown'));
// SheetJS（xlsx）：v2.8.1 起走本地内置 vendor/（0.20.3）——npm 版停在 0.18.5 有已知漏洞
// （CVE-2023-30533 / CVE-2024-22363），官方分发货道是 cdn.sheetjs.com。见 app/vendor/xlsx/说明.txt。
{
  const vendorSrc = path.join(appRoot, 'vendor', 'xlsx');
  const vendorDst = path.join(appTarget, 'vendor', 'xlsx');
  if (!fs.existsSync(path.join(vendorSrc, 'xlsx.full.min.js'))) {
    throw new Error('缺少 vendor/xlsx/xlsx.full.min.js（SheetJS 本地内置；来源与升级方法见 app/vendor/xlsx/说明.txt）');
  }
  copyTree(vendorSrc, vendorDst);
}
// 4b-2) C 批工具依赖：@cantoo/pdf-lib（加密 / 隐形文字层）+ @cantoo/fontkit（中文字子集化）
//   **整包复制**而不是只挑单文件——踩过的坑：
//     · 界面进程用 ESM 产物（pdf-lib.esm.js / fontkit.umd.min.js）；
//     · 主进程（自检脚本读回断言）走 Node 分支，require 的是 **CJS 产物**
//       （@cantoo/pdf-lib/dist/pdf-lib.js、@cantoo/fontkit/dist/main.cjs），
//       只复制 ESM 会导致产物里报 `Cannot find module .../dist/pdf-lib.js`（源码环境有完整
//       node_modules 所以看不出来，只有打包后才暴露）。
//     · fontkit 的 Node 分支还会用到它的依赖（brotli / dfa / fflate / restructure）。
//   体积约 40MB；相比 OCR 那步省下的 220MB 可以接受，「解压即用」优先。
log('步骤4b-2：复制 C 批依赖（@cantoo/pdf-lib 与 @cantoo/fontkit 整包 + 其依赖）');
for (const rel of [
  path.join('@cantoo', 'pdf-lib'),
  path.join('@cantoo', 'fontkit'),
  'brotli',
  'dfa',
  'fflate',
  'restructure'
]) {
  const from = path.join(nmSrc, rel);
  if (!fs.existsSync(from)) throw new Error(`缺少 C 批依赖：node_modules/${rel}（请先在 app 目录 npm install）`);
  copyTree(from, path.join(nmDst, rel));
}
// —— 4c) 复制 OCR 引擎运行时依赖（「文字识别」工具；引擎在主进程跑，需完整 Node 依赖树） ——
// 说明：ppu-paddle-ocr 是 ESM 包 + N-API 原生模块，主进程动态 import 它，因此不能像界面依赖那样
//      只挑单文件，必须按 npm 的目录结构带过去。
// 体积控制（重要）：onnxruntime-node 自带 darwin / linux / win32 三平台二进制（共约 287MB），
//      本软件只发 Windows x64，故**只复制 win32/x64**，其余平台全部跳过（省约 220MB）。
log('步骤4c：复制 OCR 引擎运行时依赖（onnxruntime 只带 win32/x64）');
const ocrRuntimeDirs = [
  ['ppu-paddle-ocr', 'ppu-paddle-ocr'],
  ['ppu-ocv', 'ppu-ocv'],
  [path.join('@techstark', 'opencv-js'), path.join('@techstark', 'opencv-js')],
  ['onnxruntime-common', 'onnxruntime-common'],
  [path.join('@napi-rs', 'canvas'), path.join('@napi-rs', 'canvas')],
  [path.join('@napi-rs', 'canvas-win32-x64-msvc'), path.join('@napi-rs', 'canvas-win32-x64-msvc')]
];
for (const [src, dst] of ocrRuntimeDirs) {
  const from = path.join(nmSrc, src);
  if (!fs.existsSync(from)) {
    log(`警告：未发现 node_modules/${src} —— 产物中「文字识别」可能不可用`);
    continue;
  }
  copyTree(from, path.join(nmDst, dst));
}
// onnxruntime-node：只带 win32/x64（其余平台按目录名跳过）
{
  const srcRoot = path.join(nmSrc, 'onnxruntime-node');
  const dstRoot = path.join(nmDst, 'onnxruntime-node');
  if (fs.existsSync(srcRoot)) {
    copyTree(srcRoot, dstRoot);
    // 复制完再删掉非 Windows-x64 的平台目录（copyTree 是通用函数，这里做一次精简）
    const binRoot = path.join(dstRoot, 'bin');
    const keep = path.join('napi-v6', 'win32', 'x64');
    if (fs.existsSync(binRoot)) {
      for (const p of fs.readdirSync(path.join(binRoot, 'napi-v6'), { withFileTypes: true })) {
        if (!p.isDirectory()) continue;
        const platDir = path.join(binRoot, 'napi-v6', p.name);
        if (p.name === 'win32') {
          for (const arch of fs.readdirSync(platDir, { withFileTypes: true })) {
            if (arch.isDirectory() && arch.name !== 'x64') fs.rmSync(path.join(platDir, arch.name), { recursive: true, force: true });
          }
        } else if (path.join('napi-v6', p.name) !== path.dirname(keep)) {
          fs.rmSync(platDir, { recursive: true, force: true });
        }
      }
      log('  onnxruntime-node 已精简为仅 win32/x64');
    }
  } else {
    log('警告：未发现 node_modules/onnxruntime-node —— 产物中「文字识别」将不可用');
  }
}
// —— 4d) HEIC/HEIF 解码引擎依赖（「图片格式转换」的手机格式输入；v2.10.0 起） ——
// 说明：heic-decode（ISC 壳）+ libheif-js（LGPL-3.0，官方 libheif 1.23 的 WASM 构建）由
//      主进程 worker 线程 require（heic-worker.js），必须按 npm 目录结构带过去。
//      libheif-js 的 asm.js 变体（libheif/libheif.js，约 3MB）运行时用不到，不复制；
//      只带 wasm-bundle 所需的文件 + 两级 LICENSE（LGPL 合规：以独立未修改包分发并附许可文本）。
log('步骤4d：复制 HEIC 解码引擎依赖（heic-decode + libheif-js/wasm）');
{
  const need = (rel) => {
    const from = path.join(nmSrc, rel);
    if (!fs.existsSync(from)) throw new Error(`缺少 HEIC 依赖文件：node_modules/${rel}（请先在 app 目录 npm install）`);
    copyTree(from, path.join(nmDst, rel));
  };
  need(path.join('heic-decode')); // 整包仅 3 个 JS 文件 + README/package.json
  need(path.join('libheif-js', 'package.json'));
  need(path.join('libheif-js', 'LICENSE'));
  need(path.join('libheif-js', 'wasm-bundle.js'));
  need(path.join('libheif-js', 'libheif-wasm')); // libheif-bundle.js + libheif.wasm + LICENSE（约 3.4MB）
}

fs.writeFileSync(
  path.join(appTarget, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: pkg.productName,
      version,
      description: pkg.description,
      main: pkg.main,
      private: true
    },
    null,
    2
  ),
  'utf8'
);

// —— 5) 附带文件：使用说明 + 预留的 userdata 目录（设置会写到这里） ——
log('步骤5：附带使用说明');
const readmeSrc = path.join(repoRoot, 'docs', '使用说明.txt');
if (fs.existsSync(readmeSrc)) {
  fs.copyFileSync(readmeSrc, path.join(outDir, '使用说明.txt'));
}
fs.mkdirSync(path.join(outDir, 'userdata'), { recursive: true });

// —— 5b) 可选加装包（LibreOffice）：存在就一起打包，保证「解压即用全部功能」 ——
// 说明：加装包不进 git（体积约 1.5GB），放在 app/addons/libreoffice/（见 spec/modules/pdf-convert.md）。
//       没有它时 PDF→Word 与高保真 Office→PDF 会提示需加装，其余功能不受影响。
const addonSrc = path.join(appRoot, 'addons', 'libreoffice');
if (fs.existsSync(addonSrc)) {
  log('步骤5b：复制 LibreOffice 加装包（约 1.5GB，稍等）…');
  const rc2 = spawnSync('robocopy', [addonSrc, path.join(outDir, 'addons', 'libreoffice'), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', '/MT:8'], { stdio: 'ignore' });
  if (rc2.error) throw new Error(`robocopy 复制加装包失败：${rc2.error.message}`);
  if (typeof rc2.status === 'number' && rc2.status >= 8) throw new Error(`robocopy 复制加装包失败（退出码 ${rc2.status}）`);
  const addonReadme = path.join(repoRoot, 'docs', '加装包说明.txt');
  if (fs.existsSync(addonReadme)) {
    fs.copyFileSync(addonReadme, path.join(outDir, '加装包说明.txt'));
  }
} else {
  log('未发现 app/addons/libreoffice：本次不打包加装包（PDF→Word / 高保真转换将提示需加装）');
}

// —— 5c) ffmpeg 加装包（视频格式转换 / 动图与视频互转 必需，随主包分发） ——
// 说明：单文件静态构建（约 83MB），放在 app/addons/ffmpeg/（不进 git，见 spec/modules/video-convert.md）。
const ffmpegAddon = path.join(appRoot, 'addons', 'ffmpeg');
if (fs.existsSync(path.join(ffmpegAddon, 'ffmpeg.exe'))) {
  log('步骤5c：复制 ffmpeg 加装包（约 83MB）…');
  copyTree(ffmpegAddon, path.join(outDir, 'addons', 'ffmpeg'));
} else {
  log('警告：未发现 app/addons/ffmpeg/ffmpeg.exe —— 产物中视频类工具将不可用（其余工具不受影响）');
}

// —— 5d) Real-ESRGAN 加装包（「图片变清晰」的 AI 放大 / 超分，随主包分发） ——
// 说明：ncnn+Vulkan 便携版（exe + 模型，约 50MB），放在 app/addons/realesrgan/（不进 git）。
//      需要支持 Vulkan 的显卡；缺失时工具会提示「未检测到 AI 放大加装包」，其余功能不受影响。
const aiAddon = path.join(appRoot, 'addons', 'realesrgan');
if (fs.existsSync(path.join(aiAddon, 'realesrgan-ncnn-vulkan.exe'))) {
  log('步骤5d：复制 Real-ESRGAN 加装包（约 50MB）…');
  copyTree(aiAddon, path.join(outDir, 'addons', 'realesrgan'));
} else {
  log('警告：未发现 app/addons/realesrgan —— 产物中「AI 放大」将不可用（其余功能不受影响）');
}

// —— 5e) FunASR 语音识别加装包（「语音转文字」必需，随主包分发） ——
// 说明：单文件 exe + SenseVoice q8 + FSMN-VAD（约 246MB，MIT 许可），放在 app/addons/asr/（不进 git）。
//      缺失时工具会提示「未检测到语音识别加装包」，其余工具不受影响。
const asrAddon = path.join(appRoot, 'addons', 'asr');
if (fs.existsSync(path.join(asrAddon, 'llama-funasr-sensevoice.exe'))) {
  log('步骤5e：复制 FunASR 语音识别加装包（约 246MB）…');
  copyTree(asrAddon, path.join(outDir, 'addons', 'asr'));
} else {
  log('警告：未发现 app/addons/asr —— 产物中「语音转文字」将不可用（其余工具不受影响）');
}

// —— 5f) OCR 加装包（「文字识别」必需：模型 + 中文字体，随主包分发） ——
// 说明：PP-OCRv5 mobile 的 det/rec ONNX 模型（约 20MB）+ NotoSansSC-VF.ttf（约 17MB，做可搜索 PDF 的
//      隐形文字层要嵌中文字体），放在 app/addons/ocr/（不进 git）。
//      缺失时工具会提示「未检测到文字识别加装包」，其余工具不受影响。
const ocrAddon = path.join(appRoot, 'addons', 'ocr');
if (fs.existsSync(path.join(ocrAddon, 'det.onnx')) && fs.existsSync(path.join(ocrAddon, 'rec.onnx'))) {
  log('步骤5f：复制 OCR 加装包（模型约 20MB + 中文字体约 17MB）…');
  copyTree(ocrAddon, path.join(outDir, 'addons', 'ocr'));
} else {
  log('警告：未发现 app/addons/ocr（或缺 det.onnx/rec.onnx）—— 产物中「文字识别」将不可用（其余功能不受影响）');
}

// —— 5g) 7-Zip 加装包（「文件压缩与解压」必需，随主包分发） ——
// 说明：7z.exe + 7z.dll（约 2.4MB，LGPL 2.1+，unRAR 部分带「不得用于制作 RAR 压缩器」的额外限制），
//      放在 app/addons/7zip/（不进 git，见 spec/modules/archive.md）。
//      缺失时工具会显示「未检测到 7-Zip 加装包」；ZSTANDARD / BROTLI 走 Node 内置 zlib 仍可用，
//      其余格式如实提示不可用，软件不崩。
const sevenZipAddon = path.join(appRoot, 'addons', '7zip');
if (fs.existsSync(path.join(sevenZipAddon, '7z.exe')) && fs.existsSync(path.join(sevenZipAddon, '7z.dll'))) {
  log('步骤5g：复制 7-Zip 加装包（约 2.4MB）…');
  copyTree(sevenZipAddon, path.join(outDir, 'addons', '7zip'));
} else {
  log('警告：未发现 app/addons/7zip（或缺 7z.exe / 7z.dll）—— 产物中「压缩与解压」除 ZSTD/BROTLI 外将不可用');
}

// —— 5h) HiBit Uninstaller 加装包（「软件卸载」必需，随主包分发） ——
// 说明：官方原版便携版单文件 exe（约 15.4MB，官网标注个人与商业使用均免费），放在 app/addons/hibit/
//      （不进 git，见 spec/modules/uninstall.md）。该 exe 清单声明 requireAdministrator，
//      工具页用 Windows 标准提权（RunAs）启动它。
//      缺失时工具页显示「未检测到软件卸载加装包」与放置说明，其余工具不受影响。
const hibitAddon = path.join(appRoot, 'addons', 'hibit');
if (fs.existsSync(path.join(hibitAddon, 'HiBitUninstaller-Portable.exe'))) {
  log('步骤5h：复制 HiBit Uninstaller 加装包（约 15MB）…');
  copyTree(hibitAddon, path.join(outDir, 'addons', 'hibit'));
} else {
  log('警告：未发现 app/addons/hibit/HiBitUninstaller-Portable.exe —— 产物中「软件卸载」将提示需加装');
}

// —— 5h-2) yt-dlp 加装包（「视频下载」必需，随主包分发；v2.12.0 起） ——
// 说明：yt-dlp.exe（约 16.6MB，nightly 固定版 + SHA-256 记录在 addons/ytdlp/说明.txt）+
//      可选 node/node.exe（约 82MB，仅 YouTube 挑战求解用）。放在 app/addons/ytdlp/（不进 git，见 spec/modules/videodl.md）。
//       缺失时工具页显示「未检测到下载引擎」与放置说明，其余工具不受影响；
//       引擎可自更新（下载到 userdata/videodl-engine，本加装包始终作为兜底）。
const ytdlpAddon = path.join(appRoot, 'addons', 'ytdlp');
if (fs.existsSync(path.join(ytdlpAddon, 'yt-dlp.exe'))) {
  log('步骤5h-2：复制 yt-dlp 加装包（yt-dlp.exe + 可选 node 运行时）…');
  copyTree(ytdlpAddon, path.join(outDir, 'addons', 'ytdlp'));
} else {
  log('警告：未发现 app/addons/ytdlp/yt-dlp.exe —— 产物中「视频下载」将提示需加装');
}

// —— 5i) 产物瘦身：删掉随上游整包带进来、但本软件运行期用不到的东西 ——
// 原则（改动前请读完）：
//   · **只删产物（outDir）**，绝不动 app/addons 与 node_modules 源树——开发树上保留完整依赖便于排查，
//     也保证「裁剪只影响交付物」，出问题重新 pack 即可，不必重装加装包。
//   · 每条规则是 PRUNE_RULES 里的独立一项，**删掉一行即回滚该项**，互不牵连。
//   · 规则按「前缀 / 模式」匹配，不硬编码版本号（如 python-core-3.12.14）——否则上游升级后目录名一变，
//     裁剪会静默失效、体积悄悄涨回去。为此每条规则命中 0 字节都会打警告，提示上游布局可能已变。
//   · 判据来源（勿凭印象改）：
//       - 拼写字典：share/extensions/dict-* 共 57 种语言且**不含中文**；本项目只跑
//         `soffice --headless --convert-to`（见 main.js 的 libreofficeConvert），全程不触发拼写检查。
//       - DirectML：ppu-paddle-ocr/constants.js 的 DEFAULT_SESSION_OPTIONS 为 executionProviders:['cpu']，
//         main.js 创建 PaddleOcrService 时也没覆盖，故 DML EP 永不被请求。
//       - @cantoo/pdf-lib：源码与测试全部走显式路径 dist/pdf-lib.esm.js（searchable.js / ops.js /
//         pdf-edit-test.js 另有 dist/pdf-lib.js 的 Node 分支），src/ 是 TS 源、ts3.4/ 是给老版本
//         TypeScript 的降级声明，均无人引用。**cjs/ 与 es/ 是 package.json 里 exports 的真实解析目标，
//         保留**（pack.js 步骤4b-2 的注释记着「只复制 ESM 导致产物 Cannot find module」这个坑）。
//       - locales：Windows 原生文件对话框由系统提供、不受 Chromium 语言包影响；删多余的 .pak 只会让
//         非中英文系统下 Chromium 自带字符串（输入框右键菜单等）退回英文，故保留 en-US 兜底。
log('步骤5i：产物瘦身（多语言资源 / 拼写字典 / sourcemap / 未用的原生 DLL）');

const LO_ROOT = path.join(outDir, 'addons', 'libreoffice');
const NM_OUT = path.join(outDir, 'resources', 'app', 'node_modules');
// 命名陷阱（实测踩过，勿凭印象改）：LibreOffice 两处多语言目录的命名规则**不一样**——
//   · program/resource/ 下是**下划线**目录名：zh_CN / zh_TW / en_GB / en_ZA（且**没有 en_US**，
//     因为英文原文是编进二进制的，不需要 .mo）；
//   · share/registry/res/ 下是**连字符**文件名：registry_zh-CN.xcd / fcfg_langpack_en-US.xcd。
// 用连字符白名单去匹配 resource/ 会一个都匹配不上，把中文翻译一起删光（干跑校验时抓到过）。
const LO_KEEP_RESOURCE_DIRS = new Set(['zh_CN', 'zh_TW', 'en_GB', 'en_ZA']);
const LO_KEEP_TAGS = ['zh-CN', 'zh-TW', 'en-US', 'en-GB', 'en-ZA'];
const PAK_KEEP = new Set(['zh-CN.pak', 'en-US.pak', 'en-GB.pak']);
const ORT_BIN = path.join(NM_OUT, 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64');
// 注意：步骤7 里的 mb 是 const 箭头函数，不会提升到本步骤之前，故这里自带一个（不改动原有定义）
const mb0 = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 文件名（去 .xcd 后）是否属于要保留的语言。用后缀匹配兼容 registry_ / fcfg_langpack_ / Langpack- 三种前缀 */
const keepsLocale = (name) => {
  const base = name.replace(/\.xcd$/i, '');
  return LO_KEEP_TAGS.some((tag) => base === tag || base.endsWith(`-${tag}`) || base.endsWith(`_${tag}`));
};

/** 目录（或文件）占用字节数 */
function bytesOf(target) {
  const st = fs.statSync(target);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    total += bytesOf(path.join(target, e.name));
  }
  return total;
}

/** 删除单个目标，返回省下的字节；不存在返回 0 */
function removeTarget(target) {
  if (!fs.existsSync(target)) return 0;
  const freed = bytesOf(target);
  fs.rmSync(target, { recursive: true, force: true });
  return freed;
}

/**
 * 删除 dir 下的子项，返回省下字节；dir 本身不存在返回 -1（表示「本规则不适用」）。
 * @param {Set<string>} [keep]  白名单：不在其中的都删
 * @param {(name:string)=>boolean} [pick]  只删名字命中的（与 keep 二选一）
 */
function pruneChildren(dir, keep, pick) {
  if (!fs.existsSync(dir)) return -1;
  let freed = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (keep ? keep.has(e.name) : (pick && !pick(e.name))) continue;
    freed += removeTarget(path.join(dir, e.name));
  }
  return freed;
}

/** 递归删除目录下所有 *.map（sourcemap 运行期不需要） */
function removeSourceMaps(dir) {
  if (!fs.existsSync(dir)) return -1;
  let freed = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      const sub = removeSourceMaps(full);
      if (sub > 0) freed += sub;
    } else if (e.name.endsWith('.map')) {
      freed += removeTarget(full);
    }
  }
  return freed;
}

const hasLo = fs.existsSync(LO_ROOT);
const loRel = (...segs) => path.join(LO_ROOT, ...segs);

const PRUNE_RULES = [
  {
    name: 'LibreOffice 拼写字典 dict-*（57 种语言、不含中文；headless 转换不做拼写检查）',
    needsLo: true,
    run: () => pruneChildren(loRel('share', 'extensions'), null, (n) => n.startsWith('dict-'))
  },
  {
    name: 'LibreOffice 界面翻译 .mo（保留 zh_CN / zh_TW / en_GB / en_ZA；下划线命名）',
    needsLo: true,
    run: () => pruneChildren(loRel('program', 'resource'), LO_KEEP_RESOURCE_DIRS)
  },
  {
    // res/ 里只有 registry_<lang>.xcd 与 fcfg_langpack_<lang>.xcd 两个纯语言包家族（实测 247 个文件）。
    // 只删这两个家族里非保留语言的；任何其它命名的文件一律不动，避免误删功能性配置。
    // 语言数据（数字/日期/货币格式）在 program/localedata_*.dll，与此处无关，故不影响转换结果。
    name: 'LibreOffice 语言包 registry_*/fcfg_langpack_*（保留 zh-CN / zh-TW / en-US / en-GB / en-ZA）',
    needsLo: true,
    run: () => pruneChildren(loRel('share', 'registry', 'res'), null,
      (n) => /^(registry|fcfg_langpack)_.+\.xcd$/i.test(n) && !keepsLocale(n))
  },
  {
    // 与上一条配套：顶层 Langpack-<lang>.xcd 是这些语言包的注册项，一并清掉保持 registry 自洽
    // （否则注册项指向已删除的语言包）。功能性 xcd（writer / pdfimport / xsltfilter / ctl* / cjk* 等）不匹配此前缀，保留。
    name: 'LibreOffice 顶层 Langpack-*.xcd 注册项（与 res/ 语言包保持一致）',
    needsLo: true,
    run: () => pruneChildren(loRel('share', 'registry'), null,
      (n) => /^Langpack-.+\.xcd$/i.test(n) && !keepsLocale(n))
  },
  {
    name: 'LibreOffice Python 脚本 provider（转换不跑宏；按 python*/pyuno* 前缀匹配，免版本号硬编码）',
    needsLo: true,
    run: () => pruneChildren(loRel('program'), null, (n) => n.startsWith('python') || n.startsWith('pyuno'))
  },
  {
    name: 'LibreOffice 帮助 / 图库 / 模板 / 自动图文集 / 向导 / 自述',
    needsLo: true,
    run: () => ['help', 'readmes', 'share/gallery', 'share/template', 'share/autotext', 'share/wizards']
      .reduce((sum, rel) => sum + removeTarget(loRel(...rel.split('/'))), 0)
  },
  {
    name: 'LibreOffice 安装器 *.msi（躺在运行目录里的死重）',
    needsLo: true,
    run: () => pruneChildren(LO_ROOT, null, (n) => n.toLowerCase().endsWith('.msi'))
  },
  {
    name: 'Electron 语言包 *.pak（保留 zh-CN / en-US / en-GB）',
    run: () => pruneChildren(path.join(outDir, 'locales'), PAK_KEEP)
  },
  {
    name: 'onnxruntime DirectML 三件套（EP 默认 cpu，从不加载）',
    run: () => ['DirectML.dll', 'dxcompiler.dll', 'dxil.dll']
      .reduce((sum, f) => sum + removeTarget(path.join(ORT_BIN, f)), 0)
  },
  {
    name: 'node_modules 内全部 sourcemap *.map',
    run: () => removeSourceMaps(NM_OUT)
  },
  {
    name: '@cantoo/pdf-lib 的 src/（TS 源）与 ts3.4/（降级声明）',
    run: () => ['src', 'ts3.4']
      .reduce((sum, d) => sum + removeTarget(path.join(NM_OUT, '@cantoo', 'pdf-lib', d)), 0)
  }
];

let pruneTotal = 0;
let pruneWarned = 0;
for (const rule of PRUNE_RULES) {
  if (rule.needsLo && !hasLo) continue;   // 本次没打包 LibreOffice，相关规则整体不适用
  const freed = rule.run();
  if (freed < 0) {
    log(`  跳过（目标目录不存在）：${rule.name}`);
    continue;
  }
  if (freed === 0) {
    // 命中 0 字节 = 上游布局可能变了，裁剪静默失效。只警告不失败：体积涨回去要能被发现。
    log(`  警告：未命中任何文件，请复核上游布局是否已变 → ${rule.name}`);
    pruneWarned += 1;
    continue;
  }
  log(`  省下 ${mb0(freed)}：${rule.name}`);
  pruneTotal += freed;
}
// 下限自检：LO 在位时应省下约 900MB，不在位时约 100MB。低于下限说明规则大面积失效。
const pruneFloor = hasLo ? 800 : 80;
if (pruneTotal < pruneFloor * 1024 * 1024) {
  log(`警告：本次仅瘦身 ${mb0(pruneTotal)}，低于预期下限 ${pruneFloor} MB —— 裁剪规则可能已失效，请复核`);
} else {
  log(`瘦身合计 ${mb0(pruneTotal)}${pruneWarned ? `（${pruneWarned} 条规则未命中）` : ''}`);
}

// 硬断言：中文与兜底英文必须还在。上游若改了命名规则，白名单会全落空并把中文一起删光——
// 那是「产物能跑但中文变英文/语言包缺失」的静默劣化，必须让它在这里就炸掉，而不是发到用户手上。
if (hasLo) {
  const mustExist = [
    loRel('program', 'resource', 'zh_CN'),
    loRel('share', 'registry', 'res', 'registry_zh-CN.xcd'),
    loRel('share', 'registry', 'res', 'fcfg_langpack_zh-CN.xcd'),
    loRel('program', 'soffice.exe')
  ];
  const missing = mustExist.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    throw new Error(
      `产物瘦身误删了必需文件（上游命名规则可能已变，请复核步骤5i 的白名单）：\n  ${missing.join('\n  ')}`
    );
  }
}
const pakDir = path.join(outDir, 'locales');
if (fs.existsSync(pakDir) && !fs.existsSync(path.join(pakDir, 'zh-CN.pak'))) {
  throw new Error('产物瘦身误删了 locales/zh-CN.pak —— 请复核步骤5i 的 PAK_KEEP 白名单');
}

// —— 6) 设置 exe 图标与版本信息（需要 build/rcedit.exe，缺失则跳过） ——
log('步骤6：设置 exe 图标与版本信息');
const rcedit = path.join(appRoot, 'build', 'rcedit.exe');
const icon = path.join(appRoot, 'build', 'icon.ico');
if (fs.existsSync(rcedit) && fs.existsSync(icon)) {
  try {
    execFileSync(
      rcedit,
      [
        path.join(outDir, exeName),
        '--set-icon', icon,
        '--set-version-string', 'ProductName', pkg.productName || pkg.name,
        '--set-version-string', 'FileDescription', pkg.productName || pkg.name,
        '--set-file-version', version,
        '--set-product-version', version
      ],
      { stdio: 'ignore' }
    );
    log('已写入 exe 图标与版本信息');
  } catch (err) {
    log(`rcedit 执行失败（不影响使用）：${err.message}`);
  }
} else {
  log('未找到 build/rcedit.exe 或 build/icon.ico，跳过 exe 图标设置');
}

// —— 7) 统计体积 ——
log('步骤7：统计体积');
function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
log(`免安装文件夹已生成：${outDir}（${mb(dirSize(outDir))}）`);

// —— 8) 压缩为 zip（优先用系统自带 tar，失败则退回 PowerShell Compress-Archive） ——
const zipPath = path.join(releaseRoot, `${folderName}.zip`);
fs.rmSync(zipPath, { force: true });
log('压缩中…');
let zipped = false;
try {
  const tar = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', releaseRoot, folderName], { stdio: 'ignore' });
  zipped = !tar.error && tar.status === 0 && fs.existsSync(zipPath);
  if (!zipped && tar.error) log(`tar 不可用：${tar.error.message}`);
} catch (err) {
  log(`tar 失败：${err.message}`);
}
if (!zipped) {
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${outDir}' -DestinationPath '${zipPath}' -Force`],
      { stdio: 'ignore' }
    );
    zipped = fs.existsSync(zipPath);
  } catch (err) {
    log(`压缩失败（文件夹仍可直接使用）：${err.message}`);
  }
}
if (zipped) log(`压缩包已生成：${zipPath}（${mb(fs.statSync(zipPath).size)}）`);

// —— 8b) 同步桌面快捷方式（用户要求：每次换版本必须同步，且必须在删旧版之前） ——
// 教训 v2.2.0：桌面「番茄图片混淆 桌面版.lnk」的「目标/起始位置」指向了新版 exe，但「图标位置」
// 仍指向已删除的 v2.1.1 旧目录，导致桌面图标变白。此处一次性把 TargetPath / WorkingDirectory /
// IconLocation 全部指向本次产物并读回验证，根除该复发问题。
log('步骤8b：同步桌面快捷方式');
{
  const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
  const exePath = path.join(outDir, exeName);
  const desktopLnkName = '番茄图片混淆 桌面版.lnk';
  const script = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$desktop = [Environment]::GetFolderPath('Desktop')`,
    `$lnkPath = Join-Path $desktop ${psQuote(desktopLnkName)}`,
    `if (Test-Path $lnkPath) {`,
    `  $lnk = $ws.CreateShortcut($lnkPath)`,
    `  $lnk.TargetPath = ${psQuote(exePath)}`,
    `  $lnk.WorkingDirectory = ${psQuote(outDir)}`,
    `  $lnk.IconLocation = ${psQuote(`${exePath},0`)}`,
    `  $lnk.Save()`,
    `  $v = $ws.CreateShortcut($lnkPath)`,
    `  if ($v.TargetPath -eq ${psQuote(exePath)} -and $v.WorkingDirectory -eq ${psQuote(outDir)} -and $v.IconLocation -eq ${psQuote(`${exePath},0`)}) { Write-Output 'LNK_OK' } else { Write-Output 'LNK_MISMATCH' }`,
    `} else { Write-Output 'LNK_NOT_FOUND' }`
  ].join('\n');
  try {
    // powershell 走绝对路径解析，不依赖 PATH：曾因环境 PATH 不完整导致 `spawnSync powershell ENOENT`，
    // 结果快捷方式没同步、而步骤 9 又把旧版删了 → 桌面图标指向已删除目录，用户双击打不开（教训）。
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const psAbs = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const psExe = fs.existsSync(psAbs) ? psAbs : 'powershell';
    const result = execFileSync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' }).trim();
    if (result.includes('LNK_OK')) {
      log('桌面快捷方式已指向本次版本并读回验证（含图标位置）');
    } else if (result.includes('LNK_NOT_FOUND')) {
      log('未在桌面找到「番茄图片混淆 桌面版.lnk」，跳过快捷方式同步');
    } else {
      log(`警告：快捷方式已写入但读回不一致（${result}），请手动检查图标`);
    }
  } catch (err) {
    // 同步失败时旧版可能已被步骤 9 删除：必须说清后果与要改成什么，别让用户双击到已删除的目录
    log(`警告：桌面快捷方式同步失败（${err.message}）`);
    log(`      请手动把「番茄图片混淆 桌面版.lnk」指向：${exePath}（起始位置 ${outDir}，图标同路径）`);
  }
}

// —— 8c) 迁移上一版的用户设置（升级不丢偏好，必须在删旧版之前执行） ——
// 背景：用户偏好（工具排序 navOrder、分组折叠、输出目录等）写在软件目录的 userdata/settings.json 里；
//       步骤 9 会把旧版目录整个删掉。不搬这一份，升级后用户排的顺序与折叠习惯全部回默认，
//       用户会以为「说好改好的行为没生效」（与「快捷方式指向旧目录」同一类教训）。
// 规则：只搬 settings.json 这一个小文件；本版目录已有 settings.json（例如用户已在新版里改过）时不覆盖；
//       失败不影响本次产物（用户将在新版里从默认设置开始）。
log('步骤8c：迁移上一版用户设置');
try {
  const newSettingsPath = path.join(outDir, 'userdata', 'settings.json');
  if (fs.existsSync(newSettingsPath)) {
    log('本版目录已有 settings.json，跳过迁移（不覆盖）');
  } else {
    // 在 release 里找全部旧版本目录的 settings.json，取修改时间最新的那一份（通常只有一个旧版本）
    const candidates = fs.readdirSync(releaseRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('番茄图片混淆-桌面版-v') && e.name.endsWith('-win64') && e.name !== folderName)
      .map((e) => path.join(releaseRoot, e.name, 'userdata', 'settings.json'))
      .filter((p) => fs.existsSync(p))
      .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (candidates.length) {
      fs.copyFileSync(candidates[0].p, newSettingsPath);
      log(`已把上一版的用户设置迁移到本版：${candidates[0].p}`);
    } else {
      log('没有可迁移的旧版设置（首次打包或旧版没生成过设置）');
    }
  }
} catch (err) {
  log(`用户设置迁移失败（不影响本次产物，用户将从默认设置开始）：${err.message}`);
}

// —— 9) 清理旧版本产物（用户要求：只保留最新版本，避免拿错） ——
// 只在本次打包产出成功后执行；只删本软件的旧版文件夹/压缩包，不动其它文件。
log('步骤9：清理旧版本产物');
try {
  let removed = 0;
  // 注意：必须同时排除本次的文件夹与压缩包——否则会把刚生成的 zip 自己删掉
  const keep = new Set([folderName, `${folderName}.zip`]);
  for (const entry of fs.readdirSync(releaseRoot, { withFileTypes: true })) {
    if (keep.has(entry.name)) continue;
    const oldFolder = entry.isDirectory() && entry.name.startsWith('番茄图片混淆-桌面版-v') && entry.name.endsWith('-win64');
    const oldZip = entry.isFile() && entry.name.startsWith('番茄图片混淆-桌面版-v') && entry.name.endsWith('-win64.zip');
    if (oldFolder || oldZip) {
      fs.rmSync(path.join(releaseRoot, entry.name), { recursive: true, force: true });
      log(`已删除旧版本产物：${entry.name}`);
      removed += 1;
    }
  }
  if (removed === 0) log('没有需要清理的旧版本产物');
} catch (err) {
  log(`旧版本清理失败（不影响本次产物）：${err.message}`);
}

log('完成。可双击文件夹内的 exe 直接使用，或把 zip 发给别人。');