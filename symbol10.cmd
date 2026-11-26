@echo off
setlocal DisableDelayedExpansion
where.exe node.exe >nul 2>&1
if errorlevel 1 (
    echo Symbol10 needs Node.js on PATH. Install Node.js 24 for Zstandard support. 1>&2
    exit /b 9009
)
if "%~1"=="bitline" goto bitline
node.exe "%~dp0symbol10.cjs" v3 %*
exit /b %errorlevel%

:bitline
node.exe "%~dp0symbol10.cjs" %*
exit /b %errorlevel%
