@echo off
REM Upload the local SQLite database to Azure App Service.
REM Run this after schema changes (alembic migrations) or data ingestion.

setlocal

set RG=euroleague-quiz-rg
set APP=euroleague-quiz-backend-app
set DB_PATH=%~dp0..\backend\data\euroleague.db

if not exist "%DB_PATH%" (
    echo ERROR: Database not found at %DB_PATH%
    exit /b 1
)

echo Uploading database to Azure...
echo   Source: %DB_PATH%
echo   Target: %APP% / data/euroleague.db

az webapp deploy --resource-group %RG% --name %APP% --src-path "%DB_PATH%" --target-path data/euroleague.db --type static --restart true

if %ERRORLEVEL% equ 0 (
    echo.
    echo Database uploaded and app restarted successfully.
) else (
    echo.
    echo ERROR: Upload failed. Make sure you are logged in with: az login
)
