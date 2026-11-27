# Tries the Windows installers the Desktop installers workflow just built, on a clean GitHub machine (never on a person's
# computer: it installs, closes and uninstalls Rex Desk). For the .exe and then the .msi:
#   1. install the version people have now (stable latest.json), open it, wait for its server, write a marker in its data
#   2. install the new build over it, check the installed version, open it, wait for its server, check the marker is kept
#   3. uninstall
# When the new build is not newer than the live one (a build without a version), step 1 is skipped: a fresh install only.
param([Parameter(Mandatory = $true)][string]$Built)
$ErrorActionPreference = 'Stop'
$work = Join-Path $env:RUNNER_TEMP 'try-installers'
New-Item -ItemType Directory -Force $work | Out-Null

function Get-Version([string]$name) { if ($name -match '_(\d+\.\d+\.\d+)_') { return $Matches[1] } throw "No version in $name" }
function Test-Newer([string]$a, [string]$b) { return ([version]$a) -gt ([version]$b) }

$newExe = Get-ChildItem $Built -Recurse -Filter '*-setup.exe' | Select-Object -First 1
$newMsi = Get-ChildItem $Built -Recurse -Filter '*.msi' | Select-Object -First 1
if (-not $newExe -or -not $newMsi) { throw 'The build has no -setup.exe or no .msi.' }
$version = Get-Version $newExe.Name
Write-Host "New build: $version ($($newExe.Name), $($newMsi.Name))"

$live = Invoke-RestMethod "https://downloads.rexdesk.dev/stable/latest.json?nc=$(Get-Random)"
$upgrade = Test-Newer $version $live.version
Write-Host ("Live stable: {0}. {1}" -f $live.version, ($(if ($upgrade) { 'Testing the upgrade from it.' } else { 'Not older than the build: fresh installs only.' })))

$data = Join-Path $env:APPDATA 'Rex Desk'

# Closes the window and its server: the server outlives the window on purpose, so it is stopped by the id it wrote.
function Stop-RexDesk {
  Get-Process rex-desk -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $lock = Join-Path $data 'runtime.lock'
  if (Test-Path $lock) { Stop-Process -Id ([int](Get-Content $lock -Raw).Trim()) -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
}
function Wait-Server([string]$label) {
  $deadline = (Get-Date).AddMinutes(4)
  while ((Get-Date) -lt $deadline) {
    try { $r = Invoke-WebRequest 'http://127.0.0.1:4317/api/boot' -UseBasicParsing -TimeoutSec 5; Write-Host "$label`: server answered ($($r.StatusCode))"; return } catch { Start-Sleep -Seconds 3 }
  }
  Get-ChildItem $data -Filter 'server*.log' -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "--- $($_.Name)"; Get-Content $_.FullName -Tail 40 }
  throw "$label`: the server did not answer within 4 minutes."
}
function Open-RexDesk([string]$exe, [string]$label) {
  if (-not (Test-Path $exe)) { throw "$label`: $exe is not there." }
  Start-Process $exe | Out-Null
  Wait-Server $label
}
function Get-Live([string]$pattern) {
  $file = $live.downloads | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $file) { throw "The live release has no file like $pattern." }
  $path = Join-Path $work $file.name
  Invoke-WebRequest $file.url -OutFile $path -UseBasicParsing
  if ((Get-FileHash $path -Algorithm SHA256).Hash.ToLower() -ne $file.sha256) { throw "$($file.name) does not match its checksum." }
  return $path
}
function Assert-Version([string]$exe, [string]$label) {
  $installed = (Get-Item $exe).VersionInfo.ProductVersion
  if (-not $installed.StartsWith($version)) { throw "$label`: installed version is $installed, expected $version." }
  Write-Host "$label`: installed version $installed"
}
function Set-Marker { New-Item -ItemType Directory -Force $data | Out-Null; Set-Content (Join-Path $data 'try-marker.txt') 'kept' }
function Assert-Marker([string]$label) { if (-not (Test-Path (Join-Path $data 'try-marker.txt'))) { throw "$label`: data written before the upgrade is gone." }; Write-Host "$label`: data kept" }

# ----- the .exe (per user, %LOCALAPPDATA%\Rex Desk) -----
$exeHome = Join-Path $env:LOCALAPPDATA 'Rex Desk\rex-desk.exe'
if ($upgrade) {
  $old = Get-Live '-setup\.exe$'
  Start-Process $old -ArgumentList '/S' -Wait
  Open-RexDesk $exeHome "exe $($live.version)"
  Set-Marker
  Stop-RexDesk
}
Start-Process $newExe.FullName -ArgumentList '/S' -Wait
Assert-Version $exeHome 'exe'
Open-RexDesk $exeHome "exe $version"
if ($upgrade) { Assert-Marker 'exe' }
Stop-RexDesk
Start-Process (Join-Path $env:LOCALAPPDATA 'Rex Desk\uninstall.exe') -ArgumentList '/S' -Wait
Start-Sleep -Seconds 5
if (Test-Path $exeHome) { throw 'exe: the uninstaller left rex-desk.exe behind.' }
Write-Host 'exe: uninstalled'
Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue

# ----- the .msi (per machine, Program Files\Rex Desk) -----
$msiHome = Join-Path $env:ProgramFiles 'Rex Desk\rex-desk.exe'
function Install-Msi([string]$file, [string]$label) {
  $log = Join-Path $work "$label.log"
  $p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$file`"", '/qn', '/norestart', '/l*v', "`"$log`"") -Wait -PassThru
  if ($p.ExitCode -ne 0) { Get-Content $log -Tail 60; throw "$label`: msiexec ended with $($p.ExitCode)." }
}
if ($upgrade) {
  $oldMsi = Get-Live '\.msi$'
  Install-Msi $oldMsi 'msi-old'
  Open-RexDesk $msiHome "msi $($live.version)"
  Set-Marker
  Stop-RexDesk
}
Install-Msi $newMsi.FullName 'msi-new'
Assert-Version $msiHome 'msi'
$entries = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Rex Desk' }
Write-Host ("msi: {0} entr{1} in Apps & features: {2}" -f @($entries).Count, $(if (@($entries).Count -eq 1) { 'y' } else { 'ies' }), (($entries | ForEach-Object { $_.DisplayVersion }) -join ', '))
if (@($entries).Count -ne 1) { throw 'msi: the upgrade should leave exactly one Rex Desk in Apps & features.' }
Open-RexDesk $msiHome "msi $version"
if ($upgrade) { Assert-Marker 'msi' }
Stop-RexDesk
$p = Start-Process msiexec.exe -ArgumentList @('/x', "`"$($newMsi.FullName)`"", '/qn', '/norestart') -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "msi: uninstall ended with $($p.ExitCode)." }
if (Test-Path $msiHome) { throw 'msi: the uninstall left rex-desk.exe behind.' }
Write-Host 'msi: uninstalled'
Write-Host 'All Windows installer checks passed.'
