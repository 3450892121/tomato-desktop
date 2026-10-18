# 开发树全量自检（按 AGENTS.md「构建与测试命令」逐项跑）
# 用法：cd app
#   powershell -ExecutionPolicy Bypass -File tools/run-all-self-tests.ps1
# 结果：控制台表格 + %TEMP%\tomato-run-all.json
#
# 判定：
#   - smoke：stdout 出现 SMOKE_TEST_OK
#   - 其它：控制台 TAG {...} 里 pass:true 或 ok:true
#   - imghide / videodl：开发树额外要求 verified:true
# 注意：--ui-test 要求 settings.json 不存在（有自定义 navOrder 会挂），脚本会先备份再删，跑完恢复。

param(
  [switch]$Packaged,
  [string]$ReleaseDir = ''
)

$ErrorActionPreference = 'Stop'
$devAppDir = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $devAppDir

if ($Packaged) {
  if (-not $ReleaseDir) {
    $releaseRoot = Join-Path $devAppDir 'release'
    $latest = Get-ChildItem $releaseRoot -Directory -Filter '番茄图片混淆-桌面版-v*-win64' -ErrorAction SilentlyContinue |
      Sort-Object Name | Select-Object -Last 1
    if (-not $latest) { throw "release 目录里没有免安装版：$releaseRoot" }
    $ReleaseDir = $latest.FullName
  }
  $appDir = (Resolve-Path $ReleaseDir).Path
  $exe = (Get-ChildItem $appDir -Filter '*.exe' -File | Where-Object { $_.Name -notlike '*卸载*' } | Select-Object -First 1).FullName
  if (-not $exe) { throw "release 目录里没有 exe：$appDir" }
  $argPrefix = @()
  $env:VIDEODL_TEST_SKIP_UPDATE = '1'
  Write-Host "打包产物全量自检：$appDir"
} else {
  $appDir = $devAppDir
  $exe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $exe)) { throw "找不到 electron.exe：$exe" }
  $argPrefix = @('.')
  Remove-Item Env:VIDEODL_TEST_SKIP_UPDATE -ErrorAction SilentlyContinue
}

Set-Location $appDir

$settingsFile = Join-Path $appDir 'userdata\settings.json'
$settingsBackup = $null
if (Test-Path $settingsFile) {
  $settingsBackup = Get-Content $settingsFile -Raw
  Remove-Item $settingsFile -Force
}

$env:ELECTRON_RUN_AS_NODE = $null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$tests = @(
  @{ switch = '--smoke-test';      tag = 'SMOKE_TEST_OK'; kind = 'smoke';    timeout = 120000 },
  @{ switch = '--self-test';       tag = 'SELF_TEST';     kind = 'auto';     timeout = 180000 },
  @{ switch = '--ui-test';         tag = 'UI_TEST';       kind = 'auto';     timeout = 300000 },
  @{ switch = '--pdf-test';        tag = 'PDF_TEST';      kind = 'auto';     timeout = 180000 },
  @{ switch = '--pdf-ui-test';     tag = 'PDF_UI_TEST';   kind = 'auto';     timeout = 300000 },
  @{ switch = '--ocr-poc';         tag = 'OCR_POC';       kind = 'auto';     timeout = 300000 },
  @{ switch = '--media-test';      tag = 'MEDIA_TEST';    kind = 'auto';     timeout = 300000 },
  @{ switch = '--media-ui-test';   tag = 'MEDIA_UI_TEST'; kind = 'auto';     timeout = 300000 },
  @{ switch = '--av-test';         tag = 'AV_TEST';       kind = 'auto';     timeout = 300000 },
  @{ switch = '--imgbatch-test';   tag = 'IMGBATCH_TEST'; kind = 'auto';     timeout = 300000 },
  @{ switch = '--audio-test';      tag = 'AUDIO_TEST';    kind = 'auto';     timeout = 300000 },
  @{ switch = '--audio-ui-test';   tag = 'AUDIO_UI_TEST'; kind = 'auto';     timeout = 300000 },
  @{ switch = '--asr-test';        tag = 'ASR_TEST';      kind = 'auto';     timeout = 600000 },
  @{ switch = '--asr-ui-test';     tag = 'ASR_UI_TEST';   kind = 'auto';     timeout = 300000 },
  @{ switch = '--archive-test';    tag = 'ARCHIVE_TEST';  kind = 'auto';     timeout = 900000 },
  @{ switch = '--archive-ui-test'; tag = 'ARCHIVE_UI_TEST'; kind = 'auto';   timeout = 300000 },
  @{ switch = '--player-test';     tag = 'PLAYER_TEST';   kind = 'auto';     timeout = 300000 },
  @{ switch = '--player-ui-test';  tag = 'PLAYER_UI_TEST'; kind = 'auto';    timeout = 300000 },
  @{ switch = '--theme-test';      tag = 'THEME_TEST';    kind = 'auto';     timeout = 180000 },
  @{ switch = '--settingsio-test'; tag = 'SETTINGSIO_TEST'; kind = 'auto';   timeout = 180000 },
  @{ switch = '--queue-ui-test';   tag = 'QUEUE_UI_TEST'; kind = 'auto';     timeout = 300000 },
  @{ switch = '--imghide-test';    tag = 'IMGHIDE_TEST';  kind = 'verified'; timeout = 600000 },
  @{ switch = '--imghide-ui-test'; tag = 'IMGHIDE_UI_TEST'; kind = 'auto';   timeout = 300000 },
  @{ switch = '--videodl-test';    tag = 'VIDEODL_TEST';  kind = 'verified'; timeout = 900000 },
  @{ switch = '--videodl-ui-test'; tag = 'VIDEODL_UI_TEST'; kind = 'auto';   timeout = 300000 },
  @{ switch = '--uninstall-test';  tag = 'UNINSTALL_TEST'; kind = 'auto';    timeout = 180000 },
  @{ switch = '--doc-test';        tag = 'DOC_TEST';      kind = 'auto';     timeout = 300000 },
  @{ switch = '--doc-ui-test';     tag = 'DOC_UI_TEST';   kind = 'auto';     timeout = 300000 },
  @{ switch = '--pdf-ocr-test';    tag = 'PDF_OCR_TEST';  kind = 'auto';     timeout = 600000 }
)

$results = @()
$startAll = Get-Date
foreach ($t in $tests) {
  $start = Get-Date
  # --ui-test 要求测试目录里只有它自己生成的 2 张原图；残留会让 stateKeep 张数断言挂掉
  if ($t.switch -eq '--ui-test') {
    $uiDir = Join-Path $env:TEMP 'tomato-uitest'
    if (Test-Path $uiDir) {
      Get-ChildItem $uiDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '测试原图*' -or $_.Name -like 'shot-*' } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    }
  }
  $outFile = Join-Path $env:TEMP ("tomato-run-" + ($t.switch.TrimStart('-')) + '.log')
  $errFile = $outFile + '.err'
  Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $exe -ArgumentList ($argPrefix + @($t.switch)) -WorkingDirectory $appDir -PassThru `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile -WindowStyle Hidden
  $exited = $p.WaitForExit($t.timeout)
  if (-not $exited) {
    try { $p.Kill($true) } catch {}
  }
  $stdout = ''
  $stderr = ''
  if (Test-Path $outFile) { $stdout = Get-Content $outFile -Raw -ErrorAction SilentlyContinue }
  if (Test-Path $errFile) { $stderr = Get-Content $errFile -Raw -ErrorAction SilentlyContinue }
  $ms = [int]((Get-Date) - $start).TotalMilliseconds

  $ok = $false
  $detail = ''
  if ($t.kind -eq 'smoke') {
    $ok = $stdout -match 'SMOKE_TEST_OK'
    $detail = if ($ok) { 'SMOKE_TEST_OK' } else { '未出现 SMOKE_TEST_OK' }
  } elseif ($t.switch -eq '--self-test') {
    $line = ($stdout -split "`r?`n" | Where-Object { $_ -like 'SELF_TEST *' } | Select-Object -Last 1)
    if ($line) {
      $obj = $line.Substring(10).Trim() | ConvertFrom-Json
      $ok = ($obj.pngRoundTrip -eq 'OK') -and ($obj.pipelineRoundTrip -eq 'OK')
      $detail = $line
    } else {
      $detail = '没有找到 SELF_TEST 输出'
    }
  } elseif ($t.switch -eq '--pdf-test') {
    # pdf-test 的控制台 JSON 没有 pass/ok；以落盘结果的 ok 为准
    $pdfJson = Join-Path $env:TEMP 'tomato-pdf-test.json'
    if (Test-Path $pdfJson) {
      $obj = Get-Content $pdfJson -Raw | ConvertFrom-Json
      $ok = ($obj.ok -eq $true)
      $detail = "tomato-pdf-test.json ok=$($obj.ok)"
    } else {
      $detail = '没有找到 tomato-pdf-test.json'
    }
  } else {
    $line = ($stdout -split "`r?`n" | Where-Object { $_ -match ("^" + [regex]::Escape($t.tag) + "\s") } | Select-Object -Last 1)
    if (-not $line) {
      $failLine = ($stdout -split "`r?`n" | Where-Object { $_ -match ("^" + [regex]::Escape($t.tag) + "_FAIL") } | Select-Object -Last 1)
      $detail = if ($failLine) { $failLine } else { "没有找到 $($t.tag) 输出" }
    } else {
      $jsonText = $line.Substring($line.IndexOf(' ')).Trim()
      try {
        $obj = $jsonText | ConvertFrom-Json
        $ok = ($obj.pass -eq $true) -or ($obj.ok -eq $true)
        if ($t.kind -eq 'verified' -and -not $Packaged) { $ok = $ok -and ($obj.verified -eq $true) }
        # 打包产物上：视频下载只要求 ok:true（引擎更新项联网，预期 skipped 只有它）
        if ($Packaged -and $t.tag -eq 'VIDEODL_TEST') {
          $badSkipped = @($obj.skipped | Where-Object { "$_" -notmatch '引擎更新' })
          $ok = $ok -and ($badSkipped.Count -eq 0)
        }
        $detail = $jsonText
      } catch {
        $ok = $jsonText -match 'pass"\s*:\s*true|ok"\s*:\s*true'
        $detail = $jsonText
      }
    }
  }

  $results += [pscustomobject]@{
    switch = $t.switch
    ok = $ok
    exit = $p.ExitCode
    ms = $ms
    detail = ($detail -replace "`r?`n", ' ').Substring(0, [Math]::Min(300, ($detail -replace "`r?`n", ' ').Length))
  }
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("[{0}] {1} ({2} ms) {3}" -f $mark, $t.switch, $ms, $results[-1].detail)
}

$summary = [pscustomobject]@{
  at = (Get-Date).ToString('o')
  total = $results.Count
  passed = ($results | Where-Object ok).Count
  failed = ($results | Where-Object { -not $_.ok }).Count
  results = $results
}
$jsonPath = Join-Path $env:TEMP 'tomato-run-all.json'
$summary | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $jsonPath

if ($settingsBackup -ne $null) {
  New-Item -ItemType Directory -Force -Path (Split-Path $settingsFile -Parent) | Out-Null
  Set-Content -Path $settingsFile -Value $settingsBackup -NoNewline -Encoding UTF8
}

Write-Host ''
Write-Host ("合计：{0}/{1} 通过，{2} 失败；总耗时 {3:N1} 分钟" -f $summary.passed, $summary.total, $summary.failed, ((Get-Date) - $startAll).TotalMinutes)
Write-Host "结果：$jsonPath"
if ($summary.failed -gt 0) { exit 1 }
