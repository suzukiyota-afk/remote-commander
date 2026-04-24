# Remote Commander — starts the FastAPI server and a Cloudflare Quick Tunnel.
# Prints the public https:// URL so you can open it on iPhone Safari.

$ErrorActionPreference = 'Stop'
$ROOT    = $PSScriptRoot
$PY      = "$env:USERPROFILE\anaconda3\python.exe"
$TUNNEL  = "$ROOT\bin\cloudflared.exe"
$PORT    = 8765
$LOG_DIR = "$ROOT\logs"
New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null

# --- start backend ---
Write-Host "[*] starting backend on http://127.0.0.1:$PORT" -ForegroundColor Cyan
$serverLog = "$LOG_DIR\server.log"
$server = Start-Process -FilePath $PY `
    -ArgumentList @("$ROOT\server.py") `
    -WorkingDirectory $ROOT `
    -RedirectStandardOutput $serverLog `
    -RedirectStandardError "$LOG_DIR\server.err.log" `
    -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2

# wait for port to be ready
$ready = $false
for ($i = 0; $i -lt 15; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PORT/api/health" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 800 }
}
if (-not $ready) {
    Write-Host "[!] backend did not become ready. see $serverLog" -ForegroundColor Red
    Get-Content $serverLog -Tail 30
    exit 1
}
Write-Host "[+] backend ready (pid $($server.Id))" -ForegroundColor Green

# --- start cloudflared quick tunnel ---
Write-Host "[*] opening cloudflare quick tunnel…" -ForegroundColor Cyan
$tunnelLog = "$LOG_DIR\tunnel.log"
$tunnel = Start-Process -FilePath $TUNNEL `
    -ArgumentList @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$PORT") `
    -RedirectStandardOutput $tunnelLog `
    -RedirectStandardError "$LOG_DIR\tunnel.err.log" `
    -PassThru -WindowStyle Hidden

# tail tunnel log until we see the public URL
$publicUrl = $null
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $tunnelLog) {
        $line = Select-String -Path $tunnelLog, "$LOG_DIR\tunnel.err.log" -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue |
                Select-Object -First 1
        if ($line) {
            $publicUrl = ($line.Matches[0].Value)
            break
        }
    }
}

if ($publicUrl) {
    Write-Host ""
    Write-Host "==============================================" -ForegroundColor Yellow
    Write-Host " REMOTE COMMANDER READY " -ForegroundColor Yellow
    Write-Host "==============================================" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Public URL: $publicUrl" -ForegroundColor Green
    Write-Host "  Local URL:  http://127.0.0.1:$PORT" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  iPhone: open $publicUrl in Safari, tap share → Add to Home Screen"
    Write-Host "  Stop:   press Ctrl+C, or run stop.ps1"
    Write-Host ""
    # save URL and PIDs so stop.ps1 and other tooling can find them
    @{
        public_url = $publicUrl
        local_url  = "http://127.0.0.1:$PORT"
        server_pid = $server.Id
        tunnel_pid = $tunnel.Id
        started    = (Get-Date).ToString("s")
    } | ConvertTo-Json | Out-File "$ROOT\state.json" -Encoding UTF8
    # also copy the URL to clipboard for convenience
    Set-Clipboard -Value $publicUrl
    Write-Host "  (URL copied to clipboard)" -ForegroundColor DarkGray
} else {
    Write-Host "[!] tunnel did not produce a public URL in 60s. see $tunnelLog" -ForegroundColor Red
    Get-Content $tunnelLog -Tail 30
}

Write-Host ""
Write-Host "tailing logs — Ctrl+C to exit (server & tunnel keep running; use stop.ps1 to stop)"
Write-Host ""
try {
    Get-Content -Path $serverLog, $tunnelLog -Wait -Tail 5
} finally {
    Write-Host ""
    Write-Host "log tail stopped. backend and tunnel still running." -ForegroundColor DarkGray
}
