@echo off
REM Start the EuroLeague Quiz backend API server
cd /d "%~dp0..\backend"
if not exist ".venv" (
    echo Creating virtual environment...
    python -m venv .venv
    call .venv\Scripts\activate.bat
    echo Installing dependencies...
    pip install -e ".[dev]" --quiet
) else (
    call .venv\Scripts\activate.bat
)
echo Running Alembic migrations...
alembic upgrade head
echo.
echo Starting backend at http://localhost:8000
echo API docs at http://localhost:8000/docs
echo.
uvicorn app.main:app --reload
