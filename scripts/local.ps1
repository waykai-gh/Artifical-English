param([ValidateSet('Start','Stop','Status')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mainPath = Join-Path $projectRoot 'dist\main.js'
$runtimeDir = Join-Path $projectRoot '.tmp'
$recordPath = Join-Path $runtimeDir 'local-process.json'
$runningProcess = $null
if (Test-Path -LiteralPath $recordPath) {
  $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  $candidate = Get-Process -Id $record.id -ErrorAction SilentlyContinue
  if ($candidate -and $candidate.ProcessName -eq 'node' -and $candidate.StartTime.ToUniversalTime().ToString('o') -eq $record.startedAt) {
    $details = Get-CimInstance Win32_Process -Filter "ProcessId = $($candidate.Id)"
    if ($details.CommandLine -and $details.CommandLine.Contains($mainPath)) { $runningProcess = $candidate }
  }
}
if ($Action -eq 'Status') {
  if ($runningProcess) { Write-Output "Bot is running, PID $($runningProcess.Id). Logs: .tmp/bot.log" }
  else { Write-Output 'Bot is stopped.' }
  exit
}
if ($Action -eq 'Stop') {
  if ($runningProcess) {
    $stoppedGracefully = $false
    $pipe = $null
    try {
      $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', "english-tutor-$($runningProcess.Id)", [System.IO.Pipes.PipeDirection]::Out)
      $pipe.Connect(2000)
      $writer = [System.IO.StreamWriter]::new($pipe)
      $writer.AutoFlush = $true
      $writer.WriteLine('stop')
      $writer.Dispose()
      $pipe.Dispose()
      $pipe = $null
      $stoppedGracefully = $runningProcess.WaitForExit(30000)
    } catch {
      if ($pipe) { $pipe.Dispose() }
    }
    if (-not $stoppedGracefully) {
      Stop-Process -Id $runningProcess.Id -Force -ErrorAction SilentlyContinue
      Write-Output 'Local bot process stopped (forced fallback). PostgreSQL is still running.'
    } else {
      Write-Output 'Local bot process stopped gracefully. PostgreSQL is still running.'
    }
  } else { Write-Output 'No matching local bot process is running.' }
  exit
}
if ($runningProcess) { Write-Output "Bot is already running, PID $($runningProcess.Id)."; exit }
if (-not (Test-Path -LiteralPath $mainPath)) { throw 'Run npm run build first.' }
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$nodePath = (Get-Command node.exe).Source
$started = Start-Process -FilePath $nodePath -ArgumentList ('"' + $mainPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'bot.log') -RedirectStandardError (Join-Path $runtimeDir 'bot-error.log') -PassThru
@{ id=$started.Id; startedAt=$started.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
Write-Output "Bot process started, PID $($started.Id). Check npm run status:local and .tmp/bot.log."
