param(
  [string]$QoderRoot = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

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
  throw "找不到 Qoder 数据目录（~/.qoder-cn 或 ~/.qoder）。"
}

$configPath = Join-Path $QoderRoot 'settings.json'
$skillDst = Join-Path $QoderRoot 'skills\tomato-toolbox'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = ''
$removedConfig = $false
$removedSkill = $false

if (Test-Path $configPath) {
  $raw = [System.IO.File]::ReadAllText($configPath, $utf8)
  if (-not [string]::IsNullOrWhiteSpace($raw)) {
    try {
      $json = $raw | ConvertFrom-Json
    } catch {
      throw "Qoder 的 settings.json 不是有效 JSON，未做任何修改：$configPath"
    }
    if ($json -and $json.PSObject.Properties['mcpServers'] -and $json.mcpServers.PSObject.Properties['tomato-toolbox']) {
      if ($DryRun) {
        Write-Host "将移除 MCP 配置：$configPath"
      } else {
        Copy-Item $configPath "$configPath.tomato-backup-$stamp" -Force
        $backup = "$configPath.tomato-backup-$stamp"
        $json.mcpServers.PSObject.Properties.Remove('tomato-toolbox')
        $newText = ($json | ConvertTo-Json -Depth 100) + "`n"
        [System.IO.File]::WriteAllText($configPath, $newText, $utf8)
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
    $skillBackup = Join-Path $skillBackupRoot "tomato-toolbox-$stamp"
    Copy-Item $skillDst $skillBackup -Recurse -Force
    Remove-Item $skillDst -Recurse -Force
    $removedSkill = $true
  }
}

if ($DryRun) { exit 0 }

if (-not $removedConfig -and -not $removedSkill) {
  Write-Host '没有找到番茄工具箱的 Qoder 配置，可能已经移除过了。'
  exit 0
}

Write-Host ''
Write-Host '已从 Qoder 移除番茄工具箱 MCP 配置。'
Write-Host "配置：$configPath"
if ($backup) { Write-Host "备份：$backup" }
if ($removedSkill) { Write-Host '技能目录已删除（备份在 skill-backups）。' }
Write-Host ''
Write-Host '完全退出并重新打开 Qoder 后生效。'
Write-Host ''
