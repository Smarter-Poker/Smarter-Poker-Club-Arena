@echo off
REM ═══════════════════════════════════════════════════════════════════════════════
REM PioSolver Batch Processing Setup Script for Windows
REM Run this once to set up the batch processing environment
REM ═══════════════════════════════════════════════════════════════════════════════

echo =========================================================
echo   PioSolver Batch Processing Setup
echo =========================================================
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python 3.10+ from https://python.org
    pause
    exit /b 1
)

REM Create directories
echo Creating directories...
if not exist "C:\PioSolver\trees" mkdir "C:\PioSolver\trees"
if not exist "C:\PioSolver\outputs" mkdir "C:\PioSolver\outputs"
echo   Created C:\PioSolver\trees
echo   Created C:\PioSolver\outputs

REM Install Python dependencies
echo.
echo Installing Python dependencies...
pip install -r requirements.txt

REM Check for .env file
if not exist ".env" (
    echo.
    echo WARNING: .env file not found!
    echo Please copy .env.example to .env and fill in your Supabase credentials.
    copy .env.example .env >nul
    echo Created .env file from template - EDIT THIS WITH YOUR CREDENTIALS
)

echo.
echo =========================================================
echo   Setup Complete!
echo =========================================================
echo.
echo Next steps:
echo   1. Edit .env with your Supabase credentials
echo   2. Ensure PioSolver 3 is installed
echo   3. Run: python piosolver_batch_runner.py
echo.
pause
