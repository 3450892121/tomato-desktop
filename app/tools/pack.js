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
// 附带自检脚本：打包产物可用 `--ui-test` 自检（交付前验收用）
fs.mkdirSync(path.join(appTarget, 'tests'), { recursive: true });
fs.copyFileSync(path.join(appRoot, 'tests', 'ui-test.js'), path.join(appTarget, 'tests', 'ui-test.js'));
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

log('完成。可双击文件夹内的 exe 直接使用，或把 zip 发给别人。');