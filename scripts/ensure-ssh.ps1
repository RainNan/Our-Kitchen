param([switch]$Elevated)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
if ((Get-Command ssh.exe -ErrorAction SilentlyContinue) -and (Get-Command scp.exe -ErrorAction SilentlyContinue)) { exit 0 }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$admin) {
    if ($Elevated) { throw 'Administrator approval is required to install OpenSSH.' }
    Write-Host 'Installing the Windows OpenSSH Client optional feature; Windows may request administrator approval.'
    $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),'-Elevated')
    exit $process.ExitCode
}
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'))) { throw 'OpenSSH installation failed. Restart Windows if the feature requires it.' }
