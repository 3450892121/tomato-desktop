param(
  [switch]$NoProbe,
  [switch]$Json
)

# 番茄工具箱 · Agent 接入体检
# 用法：双击「一键体检Agent接入.cmd」，或在 PowerShell 里：
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-agent-mcp.ps1
#   powershell ... -NoProbe    只查配置文件，不启动 MCP（更快）
#   powershell ... -Json       输出 JSON（给程序读）
#
# 判定口径：
#   正常   = 配置在、路径都在、MCP 真的能启动并列出工具、Skill 已安装
#   异常   = 已接入但有问题（路径失效 / 配置损坏 / 启动失败）
#   未接入 = 装了这个 agent，但没有番茄工具箱的配置
#   未安装 = 电脑上没找到这个 agent
# 退出码：0 = 没有「异常」；1 = 至少一个「异常」。

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

trap {
  Write-Host ''
  Write-Host ('体检中断：' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}

function Read-Text([string]$p) { return [System.IO.File]::ReadAllText($p, $utf8) }

function Get-Prop($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  $prop = $obj.PSObject.Properties[$name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

function Expand-Quoted([string]$s) { return $s.Replace("''", "'") }

function Test-Skill([string]$skillDir) {
  if (-not $skillDir) { return '无' }
  if (Test-Path (Join-Path $skillDir 'SKILL.md')) { return '已安装' }
  return '未安装'
}

function First-Existing([string[]]$paths) {
  foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { return $p } }
  return $paths[0]
}

function New-Result([string]$name, [string]$installDir) {
  $installed = $false
  if ($installDir) { $installed = [bool](Test-Path -LiteralPath $installDir) }
  return [pscustomobject]@{
    Agent     = $name
    Installed = $installed
    Config    = ''
    State     = '未安装'
    Detail    = ''
    Tools     = -1
    Server    = ''
    Skill     = '无'
    Entry     = $null
  }
}

# 真拉起 MCP：给 3 行 JSON-RPC，等它回 initialize + tools/list 后退出。
function Invoke-Probe([string]$command, $argList, [string]$cwd, $envMap) {
  $result = @{ ok = $false; tools = -1; server = ''; error = ''; stderr = '' }
  if (-not (Test-Path -LiteralPath $command)) {
    $result.error = "找不到启动程序：$command"
    return $result
  }
  $inFile = [System.IO.Path]::GetTempFileName()
  $outFile = [System.IO.Path]::GetTempFileName()
  $errFile = [System.IO.Path]::GetTempFileName()
  $saved = @{}
  try {
    $lines = @(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"tomato-verify","version":"1"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
    )
    [System.IO.File]::WriteAllLines($inFile, $lines, $utf8)

    if ($envMap) {
      foreach ($k in $envMap.Keys) {
        $saved[$k] = [System.Environment]::GetEnvironmentVariable($k, 'Process')
        [System.Environment]::SetEnvironmentVariable($k, [string]$envMap[$k], 'Process')
      }
    }

    $quoted = @()
    foreach ($a in @($argList)) { if ($null -ne $a -and "$a" -ne '') { $quoted += ('"' + ([string]$a).Replace('"', '""') + '"') } }

    $startArgs = @{
      FilePath               = $command
      ArgumentList           = ($quoted -join ' ')
      RedirectStandardInput  = $inFile
      RedirectStandardOutput = $outFile
      RedirectStandardError  = $errFile
      PassThru               = $true
      WindowStyle            = 'Hidden'
    }
    if ($cwd) { $startArgs['WorkingDirectory'] = $cwd }
    $proc = Start-Process @startArgs
    if (-not $proc.WaitForExit(20000)) {
      try { $proc.Kill() } catch {}
      $result.error = '启动后 20 秒没有退出（MCP 可能卡住）'
      return $result
    }
    $outText = ''
    $errText = ''
    if (Test-Path $outFile) { $outText = Read-Text $outFile }
    if (Test-Path $errFile) { $errText = Read-Text $errFile }
    $result.stderr = $errText.Trim()
    foreach ($line in ($outText -split "`n")) {
      $t = $line.Trim()
      if (-not $t) { continue }
      $msg = $null
      try { $msg = $t | ConvertFrom-Json } catch { continue }
      if ($null -eq $msg) { continue }
      if ($msg.id -eq 1 -and $msg.result) {
        $si = Get-Prop $msg.result 'serverInfo'
        if ($si) { $result.server = ([string](Get-Prop $si 'name')) + ' ' + ([string](Get-Prop $si 'version')) }
      }
      if ($msg.id -eq 2 -and $msg.result) {
        $list = Get-Prop $msg.result 'tools'
        if ($null -ne $list) { $result.tools = @($list).Count }
      }
    }
    if ($result.tools -ge 0) { $result.ok = $true }
    elseif (-not $result.error) { $result.error = 'MCP 没有返回工具列表' }
    return $result
  } finally {
    foreach ($k in $saved.Keys) { [System.Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    foreach ($f in @($inFile, $outFile, $errFile)) { if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue } }
  }
}

# 校验一条 stdio 配置；返回 $true 表示体检结论为「正常」
function Test-StdioEntry($r, $entry) {
  $command = [string](Get-Prop $entry 'command')
  $argList = @(Get-Prop $entry 'args')
  $cwd = [string](Get-Prop $entry 'cwd')
  $envObj = Get-Prop $entry 'env'
  $r.Entry = $entry

  if (-not $command) {
    $r.State = '异常'
    $r.Detail = '配置里没有 command（不是 stdio 条目，或是手动配错了）'
    return $false
  }
  if (-not (Test-Path -LiteralPath $command)) {
    $r.State = '异常'
    $r.Detail = "启动程序不存在：$command"
    return $false
  }
  if ($argList.Count -gt 0) {
    $serverFile = [string]$argList[0]
    if ($serverFile -and -not (Test-Path -LiteralPath $serverFile)) {
      $r.State = '异常'
      $r.Detail = "MCP server 不存在：$serverFile"
      return $false
    }
  } else {
    $r.State = '异常'
    $r.Detail = '配置里没有 args（缺 MCP server 路径）'
    return $false
  }
  if ($cwd -and -not (Test-Path -LiteralPath $cwd)) {
    $r.State = '异常'
    $r.Detail = "工作目录不存在：$cwd"
    return $false
  }
  $envMap = @{}
  if ($envObj) { foreach ($p in $envObj.PSObject.Properties) { $envMap[$p.Name] = [string]$p.Value } }

  if ($NoProbe) {
    $r.State = '正常'
    $r.Detail = '配置与路径都在（-NoProbe：没启动 MCP）'
    return $true
  }

  $probe = Invoke-Probe $command $argList $cwd $envMap
  if (-not $probe.ok) {
    $r.State = '异常'
    $r.Detail = "MCP 启动失败：$($probe.error)"
    return $false
  }
  $r.Tools = $probe.tools
  $r.Server = $probe.server
  if ($probe.tools -le 0) {
    $r.State = '异常'
    $r.Detail = 'MCP 启动了但工具列表是空的'
    return $false
  }
  $r.State = '正常'
  $r.Detail = '配置、路径、MCP 启动都正常'
  return $true
}

# 读取「顶层 mcpServers 的对象」这类配置
function Test-JsonMcpServers($r, [string]$configPath, [string]$skillDir, [string]$entriesPath = 'mcpServers') {
  $r.Config = $configPath
  $r.Skill = Test-Skill $skillDir
  if (-not (Test-Path $configPath)) {
    if ($r.Installed) { $r.State = '未接入' } else { $r.State = '未安装' }
    return
  }
  $raw = Read-Text $configPath
  $json = $null
  try { $json = $raw | ConvertFrom-Json } catch {
    $r.State = '异常'
    $r.Detail = '配置文件不是有效 JSON（脚本不会去动它）'
    return
  }
  $servers = $null
  if ($entriesPath -eq 'mcpServers') {
    $servers = Get-Prop $json 'mcpServers'
  } else {
    $mcp = Get-Prop $json 'mcp'
    if ($mcp) { $servers = Get-Prop $mcp 'servers' }
  }
  $entry = Get-Prop $servers 'tomato-toolbox'
  if ($null -eq $entry) {
    $r.State = '未接入'
    return
  }
  [void](Test-StdioEntry $r $entry)
}

# DSH 的 cordis.patch.yml：从标记块里抠出 stdio 条目
function Get-DshEntry([string]$configPath) {
  $raw = Read-Text $configPath
  $startMark = '# >>> tomato-toolbox-mcp'
  $endMark = '# <<< tomato-toolbox-mcp'
  $start = $raw.IndexOf($startMark)
  if ($start -lt 0) { return $null }
  $end = $raw.IndexOf($endMark, $start)
  if ($end -lt 0) { return $null }
  $block = $raw.Substring($start, $end - $start)

  $command = ''
  $m = [regex]::Match($block, "(?m)^\s*command:\s*'([^']*)'")
  if ($m.Success) { $command = Expand-Quoted $m.Groups[1].Value }

  $cwd = ''
  $m = [regex]::Match($block, "(?m)^\s*cwd:\s*'([^']*)'")
  if ($m.Success) { $cwd = Expand-Quoted $m.Groups[1].Value }

  $argList = @()
  $am = [regex]::Match($block, '(?s)args:\s*(.*?)\s*cwd:')
  if (-not $am.Success) { $am = [regex]::Match($block, '(?s)args:\s*(.*?)(?:\r?\n\s*env:|$)') }
  if ($am.Success) {
    foreach ($x in [regex]::Matches($am.Groups[1].Value, "'([^']*)'")) { $argList += (Expand-Quoted $x.Groups[1].Value) }
  }

  $envMap = [ordered]@{}
  $m = [regex]::Match($block, "(?m)^\s*ELECTRON_RUN_AS_NODE:\s*'([^']*)'")
  if ($m.Success) { $envMap['ELECTRON_RUN_AS_NODE'] = $m.Groups[1].Value }
  $m = [regex]::Match($block, "(?m)^\s*TOMATO_USERDATA_DIR:\s*'([^']*)'")
  if ($m.Success) { $envMap['TOMATO_USERDATA_DIR'] = Expand-Quoted $m.Groups[1].Value }
  $envObj = [pscustomobject]$envMap

  return [pscustomobject]@{ command = $command; args = $argList; cwd = $cwd; env = $envObj }
}

$results = New-Object System.Collections.ArrayList
$localApps = Join-Path $env:LOCALAPPDATA 'Programs'

# ---------- DeepSeek Harness（DSH） ----------
$dsh = New-Result 'DeepSeek Harness（DSH）' (Join-Path $localApps 'DeepSeek Harness')
$dshRoot = Join-Path $HOME '.dsh'
$profilesRoot = Join-Path $dshRoot 'profiles'
$profile = $null
if (Test-Path $profilesRoot) {
  $dirs = @(Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue)
  $profile = $dirs | Where-Object { $_.Name -eq 'desktop' } | Select-Object -First 1
  if (-not $profile) { $profile = $dirs | Select-Object -First 1 }
}
if ($profile) {
  $configPath = Join-Path $profile.FullName 'cordis.patch.yml'
  $dsh.Config = $configPath
  $dsh.Skill = Test-Skill (Join-Path $dshRoot 'skills\tomato-toolbox')
  if (Test-Path $configPath) {
    $entry = Get-DshEntry $configPath
    if ($null -eq $entry) { $dsh.State = '未接入' } else { [void](Test-StdioEntry $dsh $entry) }
  } else {
    if ($dsh.Installed) { $dsh.State = '未接入' } else { $dsh.State = '未安装' }
  }
} elseif ($dsh.Installed) {
  $dsh.Config = $profilesRoot
  $dsh.State = '未接入'
  $dsh.Detail = '找不到 DSH profile（先打开一次 DSH 再来体检）'
}
[void]$results.Add($dsh)

# ---------- Qoder CN / Qoder ----------
foreach ($q in @(
    @{ Name = 'Qoder CN'; Root = (Join-Path $HOME '.qoder-cn'); Install = (Join-Path $localApps 'Qoder CN') },
    @{ Name = 'Qoder（国际版）'; Root = (Join-Path $HOME '.qoder'); Install = (Join-Path $localApps 'Qoder') }
  )) {
  $r = New-Result $q.Name $q.Install
  Test-JsonMcpServers $r (Join-Path $q.Root 'settings.json') (Join-Path $q.Root 'skills\tomato-toolbox')
  [void]$results.Add($r)
}

# ---------- Trae CN / Trae ----------
# Trae 不同版本把配置放在 Trae CN\User 或 TRAE SOLO CN\User，两种都查
foreach ($t in @(
    @{ Name = 'Trae CN'; Cfg = (First-Existing @((Join-Path $env:APPDATA 'Trae CN\User\mcp.json'), (Join-Path $env:APPDATA 'TRAE SOLO CN\User\mcp.json'))); Skill = (Join-Path $HOME '.trae-cn\skills\tomato-toolbox'); Install = (Join-Path $localApps 'Trae CN') },
    @{ Name = 'Trae（国际版）'; Cfg = (First-Existing @((Join-Path $env:APPDATA 'Trae\User\mcp.json'), (Join-Path $env:APPDATA 'TRAE SOLO\User\mcp.json'))); Skill = (Join-Path $HOME '.trae\skills\tomato-toolbox'); Install = (Join-Path $localApps 'Trae') }
  )) {
  $r = New-Result $t.Name $t.Install
  Test-JsonMcpServers $r $t.Cfg $t.Skill
  [void]$results.Add($r)
}

# ---------- WorkBuddy（腾讯 CodeBuddy） ----------
$wb = New-Result 'WorkBuddy' (Join-Path $localApps 'WorkBuddy')
Test-JsonMcpServers $wb (Join-Path $HOME '.workbuddy\mcp.json') (Join-Path $HOME '.workbuddy\skills\tomato-toolbox')
[void]$results.Add($wb)

# ---------- 智谱 ZCode ----------
$zc = New-Result '智谱 ZCode' (Join-Path $localApps 'ZCode')
Test-JsonMcpServers $zc (Join-Path $HOME '.zcode\cli\config.json') (Join-Path $HOME '.zcode\skills\tomato-toolbox') 'mcp.servers'
[void]$results.Add($zc)

# ---------- Claude Desktop ----------
$claude = New-Result 'Claude Desktop' (Join-Path $localApps 'Claude')
Test-JsonMcpServers $claude (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json') ''
[void]$results.Add($claude)

# ---------- 输出 ----------
$shown = @($results | Where-Object { $_.Installed -or $_.State -ne '未安装' })
$bad = @($results | Where-Object { $_.State -eq '异常' })
$ok = @($results | Where-Object { $_.State -eq '正常' })

if ($Json) {
  $jsonOut = @()
  foreach ($r in $shown) {
    $jsonOut += [pscustomobject]@{
      agent = $r.Agent; state = $r.State; config = $r.Config; detail = $r.Detail;
      tools = $r.Tools; server = $r.Server; skill = $r.Skill
    }
  }
  Write-Output ($jsonOut | ConvertTo-Json -Depth 6)
} else {
  Write-Host ''
  Write-Host '=================================================='
  Write-Host '  番茄工具箱 · Agent 接入体检'
  Write-Host '=================================================='
  $idx = 1
  foreach ($r in $shown) {
    Write-Host ''
    Write-Host ("[$idx] " + $r.Agent)
    Write-Host ("    结论：" + $r.State + $(if ($r.Detail) { '（' + $r.Detail + '）' } else { '' }))
    if ($r.Config) { Write-Host ("    配置：" + $r.Config) }
    if ($r.Tools -ge 0) { Write-Host ("    MCP：列出 " + $r.Tools + " 个工具；服务 " + $r.Server) }
    if ($r.Skill -ne '无') { Write-Host ("    技能：" + $r.Skill) }
    $idx++
  }
  Write-Host ''
  Write-Host '--------------------------------------------------'
  Write-Host ("已接入且正常：" + $ok.Count + " 个；异常：" + $bad.Count + " 个；未接入：" + @($shown | Where-Object { $_.State -eq '未接入' }).Count + " 个")
  Write-Host ''
  if ($bad.Count -gt 0) {
    Write-Host '有异常。处理办法：' -ForegroundColor Yellow
    Write-Host '  · 配置坏了/路径失效：先双击「一键移除…接入」，再双击「一键接入…」，然后完全退出重开该客户端。'
    Write-Host '  · 刚接入完还没重启：完全退出（不是关窗口）再打开，新开一个对话。'
    Write-Host '  · 视频下载仍然要在软件「视频下载」页授权，体检不检查这一项。'
  } else {
    Write-Host '没有发现异常。' -ForegroundColor Green
    Write-Host '  注意：体检能证明「配置对、MCP 能启动、工具列得出来」，但不能代替在客户端里新开对话实际调用一次。'
  }
  Write-Host ''
  Write-Host '说明：DSH / Qoder / Trae / WorkBuddy / ZCode 都有一键接入脚本；Claude Desktop 目前只有手动配置，本程序只体检、不会替你写配置。'
  Write-Host '      WorkBuddy 首次要在界面点「信任」；ZCode 要在 MCP 服务器页确认开关打开，否则体检正常但对话里仍看不到工具。'
  Write-Host ''
}

if ($bad.Count -gt 0) { exit 1 }
exit 0
