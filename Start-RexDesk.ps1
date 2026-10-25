param([switch]$NoBrowser, [switch]$App)
# Agent sign-in profiles are saved in Rex Desk Settings, so this launcher needs no CLAUDE_CONFIG_DIR or CODEX_HOME.
$ErrorActionPreference = 'Stop'
$rexProject = $PSScriptRoot
$rexAddress = 'http://127.0.0.1:4317'
$rexRunning = $false
try {
    $rexResponse = Invoke-WebRequest -Uri "$rexAddress/api/state" -UseBasicParsing -TimeoutSec 2
    $rexRunning = $rexResponse.StatusCode -eq 200
} catch {
    $rexRunning = $false
}
if (-not $rexRunning) {
    $rexLocal = Join-Path $rexProject '.local'
    New-Item -ItemType Directory -Path $rexLocal -Force | Out-Null
    $rexNode = (Get-Command node -ErrorAction Stop).Source
    Start-Process -FilePath $rexNode -ArgumentList @('src/server.js') -WorkingDirectory $rexProject -WindowStyle Hidden -RedirectStandardOutput (Join-Path $rexLocal 'server.log') -RedirectStandardError (Join-Path $rexLocal 'server-error.log')
    for ($rexAttempt = 0; $rexAttempt -lt 20; $rexAttempt++) {
        try {
            $rexResponse = Invoke-WebRequest -Uri "$rexAddress/api/state" -UseBasicParsing -TimeoutSec 1
            if ($rexResponse.StatusCode -eq 200) { $rexRunning = $true; break }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
}
if (-not $rexRunning) { throw 'Rex Desk did not start. Check .local/server-error.log.' }
if ($App) {
    # A separate Edge profile gives the dashboard its own window and taskbar entry, apart from normal browsing.
    $rexEdge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $rexEdge) { throw 'Microsoft Edge was not found; run without -App to use the default browser.' }
    Start-Process -FilePath $rexEdge -ArgumentList @("--app=$rexAddress", "--user-data-dir=$(Join-Path $rexProject '.local\app-window')", '--window-size=1440,900')
} elseif (-not $NoBrowser) { Start-Process $rexAddress }
