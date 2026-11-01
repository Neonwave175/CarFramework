$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not $env:ROBOT_DEVICE_TOKEN) {
  Write-Host "Set a long device token before connecting your robot:" -ForegroundColor Yellow
  Write-Host '$env:ROBOT_DEVICE_TOKEN = "your-long-random-secret"'
  Write-Host 'Keep this token private. It is for the dashboard WebSocket API, not CarFramework UDP key files.'
  Write-Host 'The dashboard and accounts still run without a token; robot connections will be rejected.'
}
if (-not $env:AVIF_COOKIE_SECURE) { $env:AVIF_COOKIE_SECURE = '0' }

if (-not (Test-Path '.venv')) {
  py -m venv .venv
}
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
Write-Host "Starting AVIF Lab at http://localhost:8000" -ForegroundColor Cyan
Write-Host "For robot access, allow Python through Windows Firewall on a private network only." -ForegroundColor Yellow
& .\.venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000
