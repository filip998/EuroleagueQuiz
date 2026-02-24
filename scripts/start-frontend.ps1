# Start the EuroLeague Quiz frontend dev server
$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\..\frontend"

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    npm install
}

Write-Host ""
Write-Host "Starting frontend at http://localhost:5173" -ForegroundColor Green
Write-Host ""
npm run dev
