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
Start-Process $rexAddress
