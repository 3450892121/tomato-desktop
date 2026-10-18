param(
  [string]$QoderRoot = '',
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
  Write-Host '没有找到 Qoder 数据目录（~/.qoder-cn 或 ~/.qoder），说明这台电脑还没装 Qoder，或从没接入过；不需要移除。'
  exit 0
}

$configPath = Join-Path $QoderRoot 'settings.json'
$skillDst = Join-Path $QoderRoot 'skills\tomato-toolbox'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = ''
$removedConfig = $false
$removedSkill = $false
$json = $null
$oldText = ''

if (Test-Path $configPath) {
  $oldText = Get-Text $configPath
  if (-not [string]::IsNullOrWhiteSpace($oldText)) {
    try {
      $json = $oldText | ConvertFrom-Json
    } catch {
      throw "Qoder 的 settings.json 不是有效 JSON，未做任何修改：$configPath"
    }
    if ($json -and $json.PSObject.Properties['mcpServers'] -and $json.mcpServers.PSObject.Properties['tomato-toolbox']) {
      if ($DryRun) {
        Write-Host "将移除 MCP 配置：$configPath"
      } else {
        $backup = Get-UniquePath "$configPath.tomato-backup-$stamp"
        Copy-Item $configPath $backup -Force
        $json.mcpServers.PSObject.Properties.Remove('tomato-toolbox')
        $newText = ($json | ConvertTo-Json -Depth 100) + "`n"
        [System.IO.File]::WriteAllText($configPath, $newText, $utf8)

        # 写完读回校验：条目必须真的没了
        $check = (Get-Text $configPath) | ConvertFrom-Json
        if ($check.mcpServers.PSObject.Properties['tomato-toolbox']) {
          Copy-Item $backup $configPath -Force
          throw "移除后校验失败（条目还在），已用备份恢复：$backup"
        }
        $removedConfig = $true
      }
    }
  }
}

if (Test-Path $skillDst) {
  if ($DryRun) {
    Write-Host "将删除技能目录：$skillDst"
  } else {
    $skillBackupRoot = Join-Path $QoderRoot 'skill-backups'
    New-Item -ItemType Directory -Force -Path $skillBackupRoot | Out-Null
    $skillBackup = Get-UniquePath (Join-Path $skillBackupRoot "tomato-toolbox-$stamp")
    Copy-Item $skillDst $skillBackup -Recurse -Force
    Remove-Item $skillDst -Recurse -Force
    if (Test-Path $skillDst) { throw "技能目录没有删干净：$skillDst" }
    $removedSkill = $true
  }
}

if ($DryRun) {
  if (-not $removedConfig -and -not (Test-Path $skillDst) -and -not ($json -and $json.PSObject.Properties['mcpServers'] -and $json.mcpServers.PSObject.Properties['tomato-toolbox'])) {
    Write-Host '没有找到番茄工具箱的 Qoder 配置，可能已经移除过了。'
  }
  exit 0
}

if (-not $removedConfig -and -not $removedSkill) {
  Write-Host '没有找到番茄工具箱的 Qoder 配置，可能已经移除过了。'
  exit 0
}

Write-Host ''
Write-Host '已从 Qoder 移除番茄工具箱接入。'
Write-Host "配置：$configPath"
if ($backup) { Write-Host "备份：$backup" }
if ($removedSkill) { Write-Host "技能目录已删除，备份在：$skillBackup" }
Write-Host ''
Write-Host '完全退出并重新打开 Qoder 后生效。'
Write-Host '移除后如果想确认真的没了，可双击「一键体检Agent接入.cmd」看结论。'
Write-Host ''
