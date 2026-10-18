param(
  [ValidateSet('Trae', 'WorkBuddy', 'ZCode')]
  [string]$Client = 'Trae',
  [string]$AppDir = '',
  [string]$ConfigPath = '',
  [string]$SkillRoot = '',
  [switch]$DryRun
)

# 番茄工具箱 · 接入 Trae / WorkBuddy / 智谱 ZCode
# 小白入口是软件目录里的 一键接入Trae.cmd / 一键接入WorkBuddy.cmd / 一键接入ZCode.cmd
#
# 三家客户端的字段都是从各自安装包里核实过的（不是猜的）：
#   Trae       ：%APPDATA%\<产品>\User\mcp.json，顶层 mcpServers，条目 {command,args,cwd,env}
#   WorkBuddy  ：~/.workbuddy/mcp.json，顶层 mcpServers，条目 {type:"stdio",command,args,cwd,env}
#   ZCode      ：~/.zcode/cli/config.json，嵌套 mcp.servers，条目 {type:"stdio",command,args,cwd,env,timeoutMs}
# WorkBuddy 首次使用还要在界面点一次「信任」；ZCode 要在 MCP 服务器页确认开关打开（脚本会提示）。

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

function Ensure-ObjectProp($parent, [string]$name) {
  $prop = $parent.PSObject.Properties[$name]
  if (-not $prop -or $null -eq $prop.Value -or $prop.Value -is [string] -or $prop.Value -is [System.Array]) {
    $parent | Add-Member -NotePropertyName $name -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  return $parent.PSObject.Properties[$name].Value
}

# 找配置文件和 Skill 根目录
$clientName = ''
if (-not $ConfigPath) {
  if ($Client -eq 'Trae') {
    $cands = @(
      @{ Cfg = (Join-Path $env:APPDATA 'Trae CN\User\mcp.json'); Skill = (Join-Path $HOME '.trae-cn') },
      @{ Cfg = (Join-Path $env:APPDATA 'Trae\User\mcp.json'); Skill = (Join-Path $HOME '.trae') },
      @{ Cfg = (Join-Path $env:APPDATA 'TRAE SOLO CN\User\mcp.json'); Skill = (Join-Path $HOME '.trae-cn') },
      @{ Cfg = (Join-Path $env:APPDATA 'TRAE SOLO\User\mcp.json'); Skill = (Join-Path $HOME '.trae') }
    )
    $pick = $cands | Where-Object { Test-Path $_.Cfg } | Select-Object -First 1
    if (-not $pick) { $pick = $cands | Where-Object { Test-Path (Split-Path $_.Cfg -Parent) } | Select-Object -First 1 }
    if (-not $pick) { throw "找不到 Trae 的数据目录（%APPDATA%\Trae CN\User 或 %APPDATA%\Trae\User）。请先安装并打开一次 Trae。" }
    $ConfigPath = $pick.Cfg
    if (-not $SkillRoot) { $SkillRoot = $pick.Skill }
    $clientName = 'Trae'
  } elseif ($Client -eq 'WorkBuddy') {
    $root = Join-Path $HOME '.workbuddy'
    if (-not (Test-Path $root)) { throw "找不到 WorkBuddy 数据目录：$root。请先安装并打开一次 WorkBuddy。" }
    $ConfigPath = Join-Path $root 'mcp.json'
    if (-not $SkillRoot) { $SkillRoot = $root }
    $clientName = 'WorkBuddy'
  } else {
    $root = Join-Path $HOME '.zcode'
    if (-not (Test-Path $root)) { throw "找不到 ZCode 数据目录：$root。请先安装并打开一次 ZCode。" }
    $ConfigPath = Join-Path $root 'cli\config.json'
    if (-not $SkillRoot) { $SkillRoot = $root }
    $clientName = 'ZCode'
  }
} else {
  $clientName = $Client
  $ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
  if (-not $SkillRoot) { $SkillRoot = Split-Path $ConfigPath -Parent }
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
  if (Test-Path $preferred) { $exe = $preferred }
  else {
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
if ($clientName -eq 'Trae') {
  # Trae 的条目 schema 里没有 type（字段见其设置 schema：command/args/env/cwd/url/headers）
  $entry.PSObject.Properties.Remove('type')
} elseif ($clientName -eq 'ZCode') {
  $entry | Add-Member -NotePropertyName 'timeoutMs' -NotePropertyValue 3600000
}

$raw = ''
if (Test-Path $ConfigPath) { $raw = Get-Text $ConfigPath }
if ([string]::IsNullOrWhiteSpace($raw)) { $raw = '{}' }
try { $json = $raw | ConvertFrom-Json } catch { throw "$clientName 的配置不是有效 JSON，未做任何修改：$ConfigPath" }
if ($null -eq $json) { $json = [pscustomobject]@{} }
if ($json -is [System.Array] -or $json -is [string] -or $json -is [ValueType]) {
  throw "$clientName 的配置顶层不是对象，未做任何修改：$ConfigPath"
}

if ($clientName -eq 'ZCode') {
  $mcp = Ensure-ObjectProp $json 'mcp'
  $servers = Ensure-ObjectProp $mcp 'servers'
} else {
  $servers = Ensure-ObjectProp $json 'mcpServers'
}
$servers | Add-Member -NotePropertyName 'tomato-toolbox' -NotePropertyValue $entry -Force

$newText = ($json | ConvertTo-Json -Depth 100) + "`n"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Get-UniquePath "$ConfigPath.tomato-backup-$stamp"
$configExisted = Test-Path $ConfigPath

if ($DryRun) {
  Write-Host "=== DryRun（$clientName） ==="
  Write-Host "配置：$ConfigPath"
  Write-Host "Skill：$SkillRoot"
  Write-Host "启动：$exe"
  $entry | ConvertTo-Json -Depth 10
  exit 0
}

if ($configExisted) { Copy-Item $ConfigPath $backup -Force }
$dir = Split-Path $ConfigPath -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[System.IO.File]::WriteAllText($ConfigPath, $newText, $utf8)

# 写完读回校验：条目必须在、字段必须对，否则回滚
try {
  $check = (Get-Text $ConfigPath) | ConvertFrom-Json
  if ($clientName -eq 'ZCode') { $checkEntry = $check.mcp.servers.'tomato-toolbox' }
  else { $checkEntry = $check.mcpServers.'tomato-toolbox' }
  if ($null -eq $checkEntry -or ([string]$checkEntry.command) -ne $exeF -or @($checkEntry.args)[0] -ne $serverF) {
    throw '条目读回不一致'
  }
} catch {
  if ($configExisted) { Copy-Item $backup $ConfigPath -Force }
  else { Remove-Item $ConfigPath -Force -ErrorAction SilentlyContinue }
  throw "写入后校验失败，已回滚：$ConfigPath"
}

# 安装 Skill（各家的用户技能目录；旧版整体备份后替换）
$skillDst = Join-Path $SkillRoot 'skills\tomato-toolbox'
$skillBackup = ''
$skillInstalled = $false
if (Test-Path $skillSrc) {
  if (Test-Path $skillDst) {
    $skillBackupRoot = Join-Path $SkillRoot 'skill-backups'
    New-Item -ItemType Directory -Force -Path $skillBackupRoot | Out-Null
    $skillBackup = Get-UniquePath (Join-Path $skillBackupRoot "tomato-toolbox-$stamp")
    Copy-Item $skillDst $skillBackup -Recurse -Force
    Remove-Item $skillDst -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $skillDst | Out-Null
  Copy-Item (Join-Path $skillSrc '*') -Destination $skillDst -Recurse -Force
  if (-not (Test-Path (Join-Path $skillDst 'SKILL.md'))) { throw "Skill 复制后校验失败：$skillDst\SKILL.md 不存在" }
  $skillInstalled = $true
}

Write-Host ''
Write-Host '=================================================='
Write-Host ("  番茄工具箱 已接入 " + $clientName)
Write-Host '=================================================='
Write-Host "配置：$ConfigPath"
if ($configExisted) { Write-Host "备份：$backup" }
Write-Host "启动：$exe"
Write-Host '校验：已读回配置，条目字段正确'
if ($skillInstalled) { Write-Host "技能：已安装到 $skillDst" }
if ($skillBackup) { Write-Host "旧技能备份：$skillBackup" }
Write-Host ''
Write-Host '下一步：'
switch ($clientName) {
  'Trae' {
    Write-Host '  1. 完全退出 Trae（含托盘）再打开'
    Write-Host '  2. 点左上「新任务」，新开一个对话'
    Write-Host '  3. 直接说：“用番茄工具箱把这张图压到 500KB 以内”'
    Write-Host '  工具名前缀是 mcp_tomato-toolbox_（Trae 会把名字里的横线保留成下划线形式）'
  }
  'WorkBuddy' {
    Write-Host '  1. 完全退出 WorkBuddy（含托盘）再打开'
    Write-Host '  2. 去「专家·技能·连接器 → 连接器 → 自定义连接器（右上）」打开「MCP 服务管理」'
    Write-Host '  3. 在列表里找到 tomato-toolbox，点「信任」（第一次必须点，否则对话里看不到工具）'
    Write-Host '  4. 新开任务，直接说：“用番茄工具箱把这张图压到 500KB 以内”'
  }
  'ZCode' {
    Write-Host '  1. 完全退出 ZCode（含托盘）再打开'
    Write-Host '  2. Ctrl+K 搜「MCP 服务器」→ 确认 tomato-toolbox 是打开的'
    Write-Host '  3. 新开对话，直接说：“用番茄工具箱把这张图压到 500KB 以内”'
    Write-Host '  如果提示没有可用模型，需要先在 ZCode 里配好模型（这一步和工具箱无关）'
  }
}
Write-Host ''
Write-Host '不确定接好没有？双击「一键体检Agent接入.cmd」，它会真的启动一遍 MCP 数工具。'
Write-Host ''
