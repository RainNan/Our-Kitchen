param([ValidateSet('start','inspect','stop')][string]$Action, [string]$NodePath, [string]$Instance, [int]$ProcessId)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$entry = Join-Path $PSScriptRoot 'local-server.js'
if ($Action -eq 'start') {
    if ($Instance -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid instance token.' }
    $directory = Join-Path $projectRoot '.local\local'
    $process = Start-Process -FilePath $NodePath -ArgumentList @(('"' + $entry + '"'), '--instance', $Instance) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $directory 'server.log') -RedirectStandardError (Join-Path $directory 'server.err.log')
    Write-Output $process.Id
    exit 0
}
if ($Instance -notmatch '^[a-f0-9-]{36}$' -or $ProcessId -lt 1) { exit 2 }
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
if (!$process -or $process.ExecutablePath -ne $NodePath -or !$process.CommandLine.Contains($entry) -or !$process.CommandLine.Contains('--instance ' + $Instance)) { exit 2 }
if ($Action -eq 'stop') { Stop-Process -Id $ProcessId -ErrorAction Stop }
Write-Output 'owned'
