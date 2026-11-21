@echo off
setlocal
"%~dp0backend\.venv\Scripts\python.exe" "%~dp0scripts\defense_shift.py" run %*
if errorlevel 1 (
  pause
  exit /b 1
)
