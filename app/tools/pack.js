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
// 内置降级（Word/Excel→PDF）用：docx-preview + JSZip + SheetJS 的 UMD 构建
copyIfExists(path.join('docx-preview', 'dist', 'docx-preview.js'));
copyIfExists(path.join('docx-preview', 'LICENSE'));
copyIfExists(path.join('jszip', 'dist', 'jszip.min.js'));
copyIfExists(path.join('jszip', 'LICENSE.markdown'));
copyIfExists(path.join('xlsx', 'dist', 'xlsx.full.min.js'));
copyIfExists(path.join('xlsx', 'dist', 'LICENSE'));
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