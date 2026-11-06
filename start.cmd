@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo Please install Node.js 24.22.1 LTS or later security release first. & pause & exit /b 1)
node scripts/check-runtime.mjs
if errorlevel 1 (pause & exit /b 1)
if not exist node_modules call npm.cmd ci
if errorlevel 1 (pause & exit /b 1)
node --env-file-if-exists=.env src/cli.js init
if errorlevel 1 (pause & exit /b 1)
node --expose-gc --env-file-if-exists=.env src/server.js
pause
