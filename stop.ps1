# Stop the Remote Commander server + tunnel started by run.ps1
$ROOT = $PSScriptRoot
$state = "$ROOT\state.json"
if (-not (Test-Path $state)) {
    Write-Host "no state.json found — nothing to stop (or run.ps1 wasn't used)" -ForegroundColor Yellow
    exit 0
}
$s = Get-Content $state | ConvertFrom-Json
foreach ($pid_ in @($s.server_pid, $s.tunnel_pid)) {
    if ($pid_) {
        try {
            Stop-Process -Id $pid_ -Force -ErrorAction Stop
            Write-Host "stopped pid $pid_" -ForegroundColor Green
        } catch {
            Write-Host "could not stop pid $pid_ (already gone?)" -ForegroundColor DarkGray
        }
    }
}
Remove-Item $state -ErrorAction SilentlyContinue
Write-Host "done."
