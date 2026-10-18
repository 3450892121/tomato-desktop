param(
  [string]$DshRoot = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not $DshRoot) { $DshRoot = Join-Path $env:USERPROFILE '.dsh' }
$profilesRoot = Join-Path $DshRoot 'profiles'
if (-not (Test-Path $profilesRoot)) { throw "找不到 DSH profiles：$profilesRoot" }

$profile = Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'desktop' } | Select-Object -First 1
if (-not $profile) { $profile = Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $profile) { throw "DSH profiles 里没有可用 profile" }

$configPath = Join-Path $profile.FullName 'cordis.patch.yml'
if (-not (Test-Path $configPath)) { Write-Host "没有找到配置：$configPath"; exit 0 }

$startMark = '# >>> tomato-toolbox-mcp'
$endMark = '# <<< tomato-toolbox-mcp'
$old = [System.IO.File]::ReadAllText($configPath, $utf8)
if (-not $old.Contains($startMark)) { Write-Host "没有找到番茄工具箱的 MCP 配置，可能已经移除过了。"; exit 0 }

if ($DryRun) {
  Write-Host "将移除：$configPath"
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $configPath "$configPath.tomato-backup-$stamp" -Force
$pattern = "(?s)\r?\n?" + [regex]::Escape($startMark) + ".*?" + [regex]::Escape($endMark) + "\r?\n?"
$clean = [regex]::Replace($old, $pattern, "`n").TrimEnd() + "`n"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $clean, $utf8)

Write-Host ''
Write-Host '已从 DSH 移除番茄工具箱 MCP 配置。'
Write-Host "配置：$configPath"
Write-Host "备份：$configPath.tomato-backup-$stamp"
Write-Host '技能目录（skills\tomato-toolbox）没有删；需要的话手动删。'
Write-Host ''
Write-Host '重启 DeepSeek Harness 后生效。'
Write-Host ''
