@echo off
REM Start the EuroLeague Quiz frontend dev server
cd /d "%~dp0..\frontend"
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)
echo.
echo Starting frontend at http://localhost:5173
echo.
call npm run dev
