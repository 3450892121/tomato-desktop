param(
  [ValidateSet('Trae', 'WorkBuddy', 'ZCode')]
  [string]$Client = 'Trae',
  [string]$ConfigPath = '',
  [string]$SkillRoot = '',
  [switch]$DryRun
)

# 番茄工具箱 · 移除 Trae / WorkBuddy / 智谱 ZCode 的接入
# 小白入口：软件目录里的 一键移除Trae接入.cmd / 一键移除WorkBuddy接入.cmd / 一键移除ZCode接入.cmd

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
    if (-not $pick) { Write-Host '找不到 Trae 的数据目录，说明这台电脑还没装 Trae；不需要移除。'; exit 0 }
    $ConfigPath = $pick.Cfg
    if (-not $SkillRoot) { $SkillRoot = $pick.Skill }
    $clientName = 'Trae'
  } elseif ($Client -eq 'WorkBuddy') {
    $root = Join-Path $HOME '.workbuddy'
    if (-not (Test-Path $root)) { Write-Host '找不到 WorkBuddy 数据目录；不需要移除。'; exit 0 }
    $ConfigPath = Join-Path $root 'mcp.json'
    if (-not $SkillRoot) { $SkillRoot = $root }
    $clientName = 'WorkBuddy'
  } else {
    $root = Join-Path $HOME '.zcode'
    if (-not (Test-Path $root)) { Write-Host '找不到 ZCode 数据目录；不需要移除。'; exit 0 }
    $ConfigPath = Join-Path $root 'cli\config.json'
    if (-not $SkillRoot) { $SkillRoot = $root }
    $clientName = 'ZCode'
  }
} else {
  $clientName = $Client
  $ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
  if (-not $SkillRoot) { $SkillRoot = Split-Path $ConfigPath -Parent }
}

$skillDst = Join-Path $SkillRoot 'skills\tomato-toolbox'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = ''
$removedConfig = $false
$removedSkill = $false

$json = $null
$oldText = ''
if (Test-Path $ConfigPath) {
  $oldText = Get-Text $ConfigPath
  if (-not [string]::IsNullOrWhiteSpace($oldText)) {
    try { $json = $oldText | ConvertFrom-Json } catch { throw "$clientName 的配置不是有效 JSON，未做任何修改：$ConfigPath" }
    $hasEntry = $false
    if ($clientName -eq 'ZCode') {
      if ($json.mcp -and $json.mcp.servers -and $json.mcp.servers.PSObject.Properties['tomato-toolbox']) { $hasEntry = $true }
    } else {
      if ($json.mcpServers -and $json.mcpServers.PSObject.Properties['tomato-toolbox']) { $hasEntry = $true }
    }
    if ($hasEntry) {
      if ($DryRun) {
        Write-Host "将移除 MCP 配置：$ConfigPath"
      } else {
        $backup = Get-UniquePath "$ConfigPath.tomato-backup-$stamp"
        Copy-Item $ConfigPath $backup -Force
        if ($clientName -eq 'ZCode') { $json.mcp.servers.PSObject.Properties.Remove('tomato-toolbox') }
        else { $json.mcpServers.PSObject.Properties.Remove('tomato-toolbox') }
        [System.IO.File]::WriteAllText($ConfigPath, (($json | ConvertTo-Json -Depth 100) + "`n"), $utf8)

        $check = (Get-Text $ConfigPath) | ConvertFrom-Json
        $still = $false
        if ($clientName -eq 'ZCode') { $still = [bool]($check.mcp -and $check.mcp.servers -and $check.mcp.servers.PSObject.Properties['tomato-toolbox']) }
        else { $still = [bool]($check.mcpServers -and $check.mcpServers.PSObject.Properties['tomato-toolbox']) }
        if ($still) {
          Copy-Item $backup $ConfigPath -Force
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
    $skillBackupRoot = Join-Path $SkillRoot 'skill-backups'
    New-Item -ItemType Directory -Force -Path $skillBackupRoot | Out-Null
    $skillBackup = Get-UniquePath (Join-Path $skillBackupRoot "tomato-toolbox-$stamp")
    Copy-Item $skillDst $skillBackup -Recurse -Force
    Remove-Item $skillDst -Recurse -Force
    if (Test-Path $skillDst) { throw "技能目录没有删干净：$skillDst" }
    $removedSkill = $true
  }
}

if ($DryRun) { exit 0 }

if (-not $removedConfig -and -not $removedSkill) {
  Write-Host ("没有找到番茄工具箱的 " + $clientName + " 配置，可能已经移除过了。")
  exit 0
}

Write-Host ''
Write-Host ("已从 " + $clientName + " 移除番茄工具箱接入。")
Write-Host "配置：$ConfigPath"
if ($backup) { Write-Host "备份：$backup" }
if ($removedSkill) { Write-Host "技能目录已删除，备份在：$skillBackup" }
Write-Host ''
if ($clientName -eq 'Trae') { Write-Host '完全退出并重新打开 Trae 后生效。' }
elseif ($clientName -eq 'WorkBuddy') { Write-Host '完全退出并重新打开 WorkBuddy 后生效。' }
else { Write-Host '完全退出并重新打开 ZCode 后生效。' }
Write-Host '移除后如果想确认真的没了，可双击「一键体检Agent接入.cmd」看结论。'
Write-Host ''
