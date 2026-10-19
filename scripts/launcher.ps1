param([switch]$Server, [switch]$Check)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
Set-Location -LiteralPath $projectRoot
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# Avoid importing PowerShell 7 modules into Windows PowerShell 5.1.
$env:PSModulePath = Join-Path $PSHOME 'Modules'
function Protect-LocalDirectory {
    $directory = Join-Path $projectRoot '.local'
    if (!(Test-Path -LiteralPath $directory)) { $null = New-Item -ItemType Directory -Path $directory }
    if ((Get-Item -LiteralPath $directory).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw '.local must not be a symlink.' }
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($owner)
    foreach ($sid in @($owner, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
}
function Test-Node([string]$Executable) {
    if (!$Executable -or !(Test-Path -LiteralPath $Executable)) { return $false }
    try { & $Executable -e 'if(Number(process.versions.node.split(String.fromCharCode(46))[0])!==24||Number(process.versions.node.split(String.fromCharCode(46))[1])<14)process.exit(1)' 2>$null; return $LASTEXITCODE -eq 0 } catch { return $false }
}
function Ensure-Node {
    $version = '24.21.0'
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $runtime = Join-Path $projectRoot ".local\runtime\node-v$version-win-$architecture"
    $portable = Join-Path $runtime 'node.exe'
    if (Test-Node $portable) { return $portable }
    $installed = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($installed -and (Test-Node $installed.Source)) {
        if (Test-Path -LiteralPath (Join-Path (Split-Path $installed.Source -Parent) 'node_modules\npm\bin\npm-cli.js')) { return $installed.Source }
    }
    Write-Host 'Installing private Node.js 24 from nodejs.org...'
    $parent = Split-Path $runtime -Parent
    $null = New-Item -ItemType Directory -Force -Path $parent
    $fileName = "node-v$version-win-$architecture.zip"
    $download = Join-Path $parent ($fileName + '.download')
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$version/SHASUMS256.txt").Content
    $expected = ($checksums -split "`n" | Where-Object { $_ -match ('\s+' + [regex]::Escape($fileName) + '$') })
    if (!$expected -or @($expected).Count -ne 1) { throw 'Cannot verify official Node checksum.' }
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$version/$fileName" -OutFile $download
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne ($expected -split '\s+')[0]) { throw 'Node checksum mismatch.' }
        $zip = Join-Path $parent $fileName
        Move-Item -LiteralPath $download -Destination $zip -Force
        Expand-Archive -LiteralPath $zip -DestinationPath $parent -Force
        Remove-Item -LiteralPath $zip -Force
    } finally { if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force } }
    if (!(Test-Node $portable)) { throw 'Node installation failed.' }
    return $portable
}
try {
    Write-Host '  ___              _  ___ _ _      _                '
    Write-Host ' / _ \ _   _ _ __ | |/ (_) |_ ___| |__   ___ _ __  '
    Write-Host '| |_| | |_| | |   | . \ | || (__| | | |  __/ | | | '
    Write-Host ' \___/ \__,_|_|   |_|\_\_|\__\___|_| |_|\___|_| |_| '
    Write-Host 'Our Kitchen / 我们的厨房'
    Protect-LocalDirectory
    $nodePath = Ensure-Node
    $env:PATH = (Split-Path $nodePath -Parent) + ';' + $env:PATH
    $arguments = @((Join-Path $PSScriptRoot 'launcher.js'))
    if ($Server) { $arguments += '--server' }
    if ($Check) { $arguments += '--check' }
    & $nodePath @arguments
    exit $LASTEXITCODE
} catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
