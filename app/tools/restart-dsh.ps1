param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

$exe = $null
$proc = Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc -and $proc.Path) { $exe = $proc.Path }
if (-not $exe) {
  $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
  if (Test-Path $candidate) { $exe = $candidate }
}
if (-not $exe -or -not (Test-Path $exe)) {
  throw "找不到 DeepSeek Harness.exe；请手动完全退出 DSH 再打开。"
}

Write-Host ''
Write-Host '=================================================='
Write-Host '  重启 DeepSeek Harness（让番茄工具箱 MCP 生效）'
Write-Host '=================================================='
Write-Host "程序：$exe"
Write-Host ''
Write-Host '注意：会完全退出 DSH，当前未发送的内容可能丢失；会话记录会保留。'
if ($DryRun) {
  Write-Host 'DryRun：不实际退出/启动。'
  exit 0
}
Read-Host '按回车继续（Ctrl+C 取消）'

$procs = Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue
foreach ($p in $procs) {
  try { $p.CloseMainWindow() | Out-Null } catch {}
}
Start-Sleep -Seconds 3
Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Start-Process -FilePath $exe
Write-Host ''
Write-Host 'DSH 已重新启动。等它打开后，再回到对话里说：'
Write-Host '  “用番茄工具箱把这个文件转成 xlsx”'
Write-Host ''
