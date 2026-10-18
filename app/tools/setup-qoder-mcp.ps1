param(
  [string]$AppDir = '',
  [string]$QoderRoot = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

trap {
  Write-Host ''
  Write-Host ('接入失败：' + $_.Exception.Message) -ForegroundColor Red
  Write-Host '如果配置已被改动，脚本会尽量用备份恢复；没有恢复成功的话，用同目录下的 .tomato-backup-* 手动放回。'
  exit 1
}

function Get-UniquePath([string]$basePath) {
  if (-not (Test-Path -LiteralPath $basePath)) { return $basePath }
  $i = 2
  while (Test-Path -LiteralPath ($basePath + '-' + $i)) { $i++ }
  return ($basePath + '-' + $i)
}

function Get-Text([string]$p) { return [System.IO.File]::ReadAllText($p, $utf8) }

function Resolve-QoderRoot {
  param([string]$Explicit)
  if ($Explicit) {
    if (-not (Test-Path $Explicit)) { throw "指定的 Qoder 目录不存在：$Explicit" }
    return (Resolve-Path $Explicit).Path
  }
  $candidates = @(
    (Join-Path $env:USERPROFILE '.qoder-cn'),
    (Join-Path $env:USERPROFILE '.qoder')
  )
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c 'settings.json')) { return $c }
  }
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

$QoderRoot = Resolve-QoderRoot $QoderRoot
if (-not $QoderRoot) {
  throw "找不到 Qoder 数据目录（~/.qoder-cn 或 ~/.qoder）。请先安装并打开一次 Qoder。"
}

# 定位软件目录：打包版根目录（有 exe）或开发树 app/ 目录
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
$userdata = $null
$skillSrc = $null
if (Test-Path (Join-Path $AppDir 'resources\app\mcp\server.mjs')) {
  $preferred = Join-Path $AppDir '番茄图片混淆桌面版.exe'
  if (Test-Path $preferred) {
    $exe = $preferred
  } else {
    $exe = (Get-ChildItem $AppDir -File -Filter '*.exe' |
      Where-Object { $_.Name -notlike '*卸载*' -and $_.Name -notlike 'unins*' } |
      Select-Object -First 1).FullName
  }
  $server = Join-Path $AppDir 'resources\app\mcp\server.mjs'
  $cwd = Join-Path $AppDir 'resources\app'
  $userdata = Join-Path $AppDir 'userdata'
  $skillSrc = Join-Path $AppDir 'skills\tomato-toolbox'
} elseif (Test-Path (Join-Path $AppDir 'mcp\server.mjs')) {
  $exe = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
  $server = Join-Path $AppDir 'mcp\server.mjs'
  $cwd = $AppDir
  $userdata = Join-Path $AppDir 'userdata'
  $skillSrc = Join-Path (Split-Path $AppDir -Parent) 'skills\tomato-toolbox'
} else {
  throw "找不到 MCP server（既不是打包版也不是开发树）：$AppDir"
}
if (-not $exe -or -not (Test-Path $exe)) { throw "找不到用于启动 MCP 的 exe：$exe" }
if (-not (Test-Path $server)) { throw "找不到 MCP server：$server" }

$exeF = $exe.Replace('\', '/')
$serverF = $server.Replace('\', '/')
$cwdF = $cwd.Replace('\', '/')
$userdataF = $userdata.Replace('\', '/')

$entry = [pscustomobject]([ordered]@{
  type = 'stdio'
  command = $exeF
  args = @($serverF)
  cwd = $cwdF
  env = [pscustomobject]([ordered]@{
    ELECTRON_RUN_AS_NODE = '1'
    TOMATO_USERDATA_DIR = $userdataF
  })
})

$configPath = Join-Path $QoderRoot 'settings.json'
$raw = ''
if (Test-Path $configPath) {
  $raw = Get-Text $configPath
}
if ([string]::IsNullOrWhiteSpace($raw)) { $raw = '{}' }
try {
  $json = $raw | ConvertFrom-Json
} catch {
  throw "Qoder 的 settings.json 不是有效 JSON，未做任何修改：$configPath"
}
if ($null -eq $json) { $json = [pscustomobject]@{} }
if ($json -is [System.Array] -or $json -is [string] -or $json -is [ValueType]) {
  throw "Qoder 的 settings.json 顶层不是对象，未做任何修改：$configPath"
}

$mcpProp = $json.PSObject.Properties['mcpServers']
if (-not $mcpProp) {
  $json | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([pscustomobject]@{})
} elseif ($null -eq $json.mcpServers) {
  $json.mcpServers = [pscustomobject]@{}
}
if ($json.mcpServers -is [System.Array] -or $json.mcpServers -is [string]) {
  throw "Qoder 配置里的 mcpServers 不是对象，未做任何修改：$configPath"
}

$json.mcpServers | Add-Member -NotePropertyName 'tomato-toolbox' -NotePropertyValue $entry -Force
$newText = ($json | ConvertTo-Json -Depth 100) + "`n"

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Get-UniquePath "$configPath.tomato-backup-$stamp"
$configExisted = Test-Path $configPath

if ($DryRun) {
  Write-Host '=== DryRun ==='
  Write-Host "Qoder:  $QoderRoot"
  Write-Host "Config: $configPath"
  Write-Host "Exe:    $exe"
  Write-Host "Server: $server"
  Write-Host "Skill:  $skillSrc"
  Write-Host '=== mcpServers.tomato-toolbox ==='
  $entry | ConvertTo-Json -Depth 10
  exit 0
}

$qoderProc = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -like 'Qoder*' } |
  Select-Object -First 1
if ($qoderProc) {
  Write-Host '提示：检测到 Qoder 正在运行。建议先完全退出 Qoder 再运行本脚本，装完再打开。'
  Write-Host ''
}

if ($configExisted) { Copy-Item $configPath $backup -Force }
[System.IO.File]::WriteAllText($configPath, $newText, $utf8)

# 写完读回校验：JSON 必须还能解析、条目字段必须对，否则回滚
try {
  $check = (Get-Text $configPath) | ConvertFrom-Json
  $checkEntry = $check.mcpServers.'tomato-toolbox'
  if ($null -eq $checkEntry -or ([string]$checkEntry.command) -ne $exeF -or @($checkEntry.args)[0] -ne $serverF) {
    throw '条目读回不一致'
  }
} catch {
  if ($configExisted) { Copy-Item $backup $configPath -Force }
  else { Remove-Item $configPath -Force -ErrorAction SilentlyContinue }
  throw "写入后校验失败，已回滚：$configPath"
}

$skillDst = Join-Path $QoderRoot 'skills\tomato-toolbox'
$skillInstalled = $false
$skillBackup = ''
if (Test-Path $skillSrc) {
  if (Test-Path $skillDst) {
    $skillBackupRoot = Join-Path $QoderRoot 'skill-backups'
    New-Item -ItemType Directory -Force -Path $skillBackupRoot | Out-Null
    $skillBackup = Get-UniquePath (Join-Path $skillBackupRoot "tomato-toolbox-$stamp")
    Copy-Item $skillDst $skillBackup -Recurse -Force
    Remove-Item $skillDst -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $skillDst | Out-Null
  Copy-Item (Join-Path $skillSrc '*') -Destination $skillDst -Recurse -Force
  if (-not (Test-Path (Join-Path $skillDst 'SKILL.md'))) {
    throw "Skill 复制后校验失败：$skillDst\SKILL.md 不存在"
  }
  $skillInstalled = $true
}

Write-Host ''
Write-Host '=================================================='
Write-Host '  番茄工具箱 已接入 Qoder'
Write-Host '=================================================='
Write-Host "配置：$configPath"
if ($configExisted) { Write-Host "备份：$backup" }
Write-Host "启动：$exe"
Write-Host '校验：已读回配置，条目字段正确'
if ($skillInstalled) { Write-Host "技能：已安装到 $skillDst" }
if ($skillBackup) { Write-Host "旧技能备份：$skillBackup" }
Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 如果 Qoder 正在运行，完全退出 Qoder（不是关窗口）再打开'
Write-Host '  2. 在 Qoder 里新开一个对话，直接说：'
Write-Host '     “用番茄工具箱把这个文件夹的图片压到 500KB 以内”'
Write-Host '  3. 视频下载仍然要在软件「视频下载」页授权'
Write-Host ''
Write-Host '不确定接好没有？双击「一键体检Agent接入.cmd」，它会真的启动一遍 MCP 数工具。'
Write-Host ''
