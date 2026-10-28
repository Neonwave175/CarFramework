$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
    Write-Error 'Python launcher "py" was not found. Install Python 3.11+ from python.org and enable the launcher.'
}

if (-not (Test-Path '.venv')) {
    py -3 -m venv .venv
}
$Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
& $Python -m pip install --upgrade pip
& $Python -m pip install -r requirements.txt

if (-not $env:ROBOT_DEVICE_TOKEN) {
    Write-Warning 'ROBOT_DEVICE_TOKEN is not set. The dashboard and login can run, but robot clients will not authenticate.'
}
if (-not $env:AVIF_COOKIE_SECURE) { $env:AVIF_COOKIE_SECURE = '0' }
Write-Host ''
Write-Host 'AVIF Lab API starting at http://localhost:8000' -ForegroundColor Cyan
Write-Host 'Keep this window open while using the dashboard.' -ForegroundColor DarkGray
& $Python -m uvicorn server:app --host 0.0.0.0 --port 8000
