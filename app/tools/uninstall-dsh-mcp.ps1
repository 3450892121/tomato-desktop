param(
  [string]$DshRoot = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

trap {
  Write-Host ''
  Write-Host ('移除失败：' + $_.Exception.Message) -ForegroundColor Red
  Write-Host '如果配置已被改动，脚本会尽量用备份恢复；也可以手动把 .tomato-backup-* 放回原位置。'
  exit 1
}

function Get-UniquePath([string]$basePath) {
  if (-not (Test-Path -LiteralPath $basePath)) { return $basePath }
  $i = 2
  while (Test-Path -LiteralPath ($basePath + '-' + $i)) { $i++ }
  return ($basePath + '-' + $i)
}

function Get-Text([string]$p) { return [System.IO.File]::ReadAllText($p, $utf8) }

if (-not $DshRoot) { $DshRoot = Join-Path $env:USERPROFILE '.dsh' }
$profilesRoot = Join-Path $DshRoot 'profiles'
$skillDst = Join-Path $DshRoot 'skills\tomato-toolbox'

if (-not (Test-Path $DshRoot) -or -not (Test-Path $profilesRoot)) {
  Write-Host '没有找到 DSH 数据目录，说明这台电脑还没装 DSH，或从没接入过；不需要移除。'
  exit 0
}

$profile = Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'desktop' } | Select-Object -First 1
if (-not $profile) { $profile = Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $profile) {
  Write-Host 'DSH profiles 里没有可用 profile；不需要移除。'
  exit 0
}

$configPath = Join-Path $profile.FullName 'cordis.patch.yml'
$startMark = '# >>> tomato-toolbox-mcp'
$endMark = '# <<< tomato-toolbox-mcp'
$hasConfig = $false
$old = ''
if (Test-Path $configPath) {
  $old = Get-Text $configPath
  if ($old.Contains($startMark)) { $hasConfig = $true }
}
$hasSkill = Test-Path $skillDst

if (-not $hasConfig -and -not $hasSkill) {
  Write-Host '没有找到番茄工具箱的 MCP 配置和技能，可能已经移除过了。'
  exit 0
}

if ($DryRun) {
  if ($hasConfig) { Write-Host "将移除配置块：$configPath" }
  if ($hasSkill) { Write-Host "将移除技能目录：$skillDst" }
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$configBackup = ''
if ($hasConfig) {
  $configBackup = Get-UniquePath "$configPath.tomato-backup-$stamp"
  Copy-Item $configPath $configBackup -Force
  $pattern = "(?s)\r?\n?" + [regex]::Escape($startMark) + ".*?" + [regex]::Escape($endMark) + "\r?\n?"
  if ($old.Contains($endMark)) {
    $clean = [regex]::Replace($old, $pattern, "`n").TrimEnd() + "`n"
  } else {
    # 配置块不完整（没有结束标记）：从开始标记处截断
    $clean = $old.Substring(0, $old.IndexOf($startMark)).TrimEnd() + "`n"
  }
  [System.IO.File]::WriteAllText($configPath, $clean, $utf8)

  # 写完读回校验：标记必须真的没了，否则用备份回滚
  $check = Get-Text $configPath
  if ($check.Contains($startMark) -or $check.Contains($endMark)) {
    Copy-Item $configBackup $configPath -Force
    throw "移除后校验失败（配置块还在），已用备份恢复：$configBackup"
  }
}

$skillBackup = ''
if ($hasSkill) {
  $skillBackupRoot = Join-Path $DshRoot 'skill-backups'
  New-Item -ItemType Directory -Force -Path $skillBackupRoot | Out-Null
  $skillBackup = Get-UniquePath (Join-Path $skillBackupRoot "tomato-toolbox-$stamp")
  Copy-Item $skillDst $skillBackup -Recurse -Force
  Remove-Item $skillDst -Recurse -Force
  if (Test-Path $skillDst) { throw "技能目录没有删干净：$skillDst" }
}

Write-Host ''
Write-Host '已从 DSH 移除番茄工具箱接入。'
if ($hasConfig) {
  Write-Host "配置：$configPath"
  Write-Host "备份：$configBackup"
}
if ($hasSkill) {
  Write-Host "技能目录已删除，备份在：$skillBackup"
}
Write-Host ''
Write-Host '完全退出并重新打开 DeepSeek Harness 后生效。'
Write-Host '移除后如果想确认真的没了，可双击「一键体检Agent接入.cmd」看结论。'
Write-Host ''
