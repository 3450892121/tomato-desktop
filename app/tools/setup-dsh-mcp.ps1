param(
  [string]$AppDir = '',
  [string]$DshRoot = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not $DshRoot) { $DshRoot = Join-Path $env:USERPROFILE '.dsh' }
if (-not (Test-Path $DshRoot)) { throw "找不到 DSH 数据目录：$DshRoot（请先安装/打开一次 DeepSeek Harness）" }

# 定位软件目录：release 根目录（有 exe）或开发树 app/ 目录
if (-not $AppDir) {
  $here = $PSScriptRoot
  if (Test-Path (Join-Path $here 'app\mcp\server.mjs')) { $AppDir = Join-Path $here 'app' }
  elseif (Test-Path (Join-Path $here 'mcp\server.mjs')) { $AppDir = $here }
  elseif (Test-Path (Join-Path (Split-Path $here -Parent) 'mcp\server.mjs')) { $AppDir = Split-Path $here -Parent }
  elseif (Test-Path (Join-Path $here 'resources\app\mcp\server.mjs')) { $AppDir = $here }
  else { $AppDir = $here }
}
$AppDir = (Resolve-Path $AppDir).Path

$exe = $null
$server = $null
$cwd = $null
if (Test-Path (Join-Path $AppDir 'resources\app\mcp\server.mjs')) {
  # 打包版：优先用软件自己的 exe 以 Node 模式启动，用户不需要装 Node
  $exe = (Get-ChildItem $AppDir -File -Filter '*.exe' | Where-Object { $_.Name -notlike '*卸载*' } | Select-Object -First 1).FullName
  $server = Join-Path $AppDir 'resources\app\mcp\server.mjs'
  $cwd = Join-Path $AppDir 'resources\app'
  $userdata = Join-Path $AppDir 'userdata'
  $skillSrc = Join-Path $AppDir 'skills\tomato-toolbox'
  $env:ELECTRON_RUN_AS_NODE = '1'
} elseif (Test-Path (Join-Path $AppDir 'mcp\server.mjs')) {
  # 开发树：用 Electron 的 Node 模式
  $exe = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
  $server = Join-Path $AppDir 'mcp\server.mjs'
  $cwd = $AppDir
  $userdata = Join-Path $AppDir 'userdata'
  $skillSrc = Join-Path (Split-Path $AppDir -Parent) 'skills\tomato-toolbox'
  $env:ELECTRON_RUN_AS_NODE = '1'
} else {
  throw "找不到 MCP server（既不是打包版也不是开发树）：$AppDir"
}
if (-not $exe -or -not (Test-Path $exe)) { throw "找不到用于启动 MCP 的 exe：$exe" }
if (-not (Test-Path $server)) { throw "找不到 MCP server：$server" }

# DSH profile：优先 desktop，其次第一个；都没有就建 desktop
$profilesRoot = Join-Path $DshRoot 'profiles'
$profile = $null
if (Test-Path $profilesRoot) {
  $dirs = Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue
  $profile = $dirs | Where-Object { $_.Name -eq 'desktop' } | Select-Object -First 1
  if (-not $profile) { $profile = $dirs | Select-Object -First 1 }
}
if (-not $profile) {
  $profileDir = Join-Path $profilesRoot 'desktop'
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  $profile = Get-Item $profileDir
}
$configPath = Join-Path $profile.FullName 'cordis.patch.yml'
if (-not (Test-Path $configPath)) {
  Set-Content -Path $configPath -Value "# Your patch layer for this dsh profile`n" -Encoding UTF8
}

$fwd = { param($s) ($s -replace '\\', '/').Replace("'", "''") }
$exeF = & $fwd $exe
$serverF = & $fwd $server
$cwdF = & $fwd $cwd
$userdataF = & $fwd $userdata
$startMark = '# >>> tomato-toolbox-mcp'
$endMark = '# <<< tomato-toolbox-mcp'

$block = @"
$startMark
- insert:
    - id: mcp-tomato-toolbox
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tomato-toolbox
        transport: stdio
        command: '$exeF'
        args: ['$serverF']
        cwd: '$cwdF'
        env:
          ELECTRON_RUN_AS_NODE: '1'
          TOMATO_USERDATA_DIR: '$userdataF'
        toolCallTimeoutMs: 3600000
$endMark
"@

$old = [System.IO.File]::ReadAllText($configPath, $utf8)
if ($null -eq $old) { $old = '' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$configPath.tomato-backup-$stamp"

if ($DryRun) {
  Write-Host "=== DryRun ==="
  Write-Host "AppDir:   $AppDir"
  Write-Host "Exe:      $exe"
  Write-Host "Server:   $server"
  Write-Host "Config:   $configPath"
  Write-Host "Skill:    $skillSrc"
  Write-Host "=== Block ==="
  Write-Host $block
  exit 0
}

Copy-Item $configPath $backup -Force
$clean = $old
if ($clean.Contains($startMark)) {
  $pattern = "(?s)\r?\n?" + [regex]::Escape($startMark) + ".*?" + [regex]::Escape($endMark) + "\r?\n?"
  $clean = [regex]::Replace($clean, $pattern, "`n")
}
$clean = $clean.TrimEnd()
$newText = $clean + "`n`n" + $block + "`n"
[System.IO.File]::WriteAllText($configPath, $newText, $utf8)

# 安装 Skill（DSH 技能目录）
$skillDst = Join-Path $DshRoot 'skills\tomato-toolbox'
$skillInstalled = $false
if (Test-Path $skillSrc) {
  if (Test-Path $skillDst) {
    Copy-Item $skillDst "$skillDst.tomato-backup-$stamp" -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $skillDst | Out-Null
  Copy-Item (Join-Path $skillSrc '*') -Destination $skillDst -Recurse -Force
  $skillInstalled = $true
}

Write-Host ''
Write-Host '=================================================='
Write-Host '  番茄工具箱 已接入 DeepSeek Harness（DSH）'
Write-Host '=================================================='
Write-Host "配置：$configPath"
Write-Host "备份：$backup"
Write-Host "启动：$exe"
if ($skillInstalled) { Write-Host "技能：已安装到 $skillDst" }
Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 完全退出并重启 DeepSeek Harness（不是关窗口，是退出程序）'
Write-Host '  2. 在 DSH 里直接说：“用番茄工具箱把这个文件夹的图片压到 500KB 以内”'
Write-Host '  3. 视频下载默认每次都要你在软件里点“允许一次”'
Write-Host ''
Write-Host '如果 DSH 里没出现工具：重启 DSH，或看 软件目录\Agent接入说明.md'
Write-Host ''
