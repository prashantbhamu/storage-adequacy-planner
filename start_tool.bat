@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 start_tool.py
) else (
  python start_tool.py
)
endlocal
