@echo off
rem restart-cdp.cmd - close running DSH/TRAE, then relaunch both with CDP ports.
rem WARNING: a running DSH desktop session is terminated (its saved chat stays on disk).
chcp 65001 >nul
setlocal
set "ELECTRON_RUN_AS_NODE="
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
if "%~1"=="" (
  echo [restart-cdp] This will CLOSE any running DSH / TRAE window
  echo [restart-cdp] and relaunch them with CDP debugging ports ^(9223 / 9222^).
  echo [restart-cdp] A DSH session in progress will be interrupted ^(chat history is saved^).
  echo.
  pause
)
pushd "%~dp0"
"%NODE%" "%~dp0tools\launch-cdp.mjs" --restart %*
set "CODE=%ERRORLEVEL%"
popd
if "%~1"=="" pause
exit /b %CODE%
