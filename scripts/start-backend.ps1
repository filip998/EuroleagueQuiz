# Start the EuroLeague Quiz backend API server
$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\..\backend"

if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    python -m venv .venv
    & .venv\Scripts\Activate.ps1
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    pip install -e ".[dev]" --quiet
} else {
    & .venv\Scripts\Activate.ps1
}

Write-Host "Running Alembic migrations..." -ForegroundColor Cyan
alembic upgrade head

Write-Host ""
Write-Host "Starting backend at http://localhost:8000" -ForegroundColor Green
Write-Host "API docs at http://localhost:8000/docs" -ForegroundColor Green
Write-Host ""
uvicorn app.main:app --reload
