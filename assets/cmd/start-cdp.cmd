@echo off
rem start-cdp.cmd - launch DSH + TRAE with CDP debugging ports (9223 / 9222)
rem No arguments (double-click): ask before restarting an app that runs without CDP,
rem then pause so the result stays on screen.
chcp 65001 >nul
setlocal
rem DSH shell exports this; Electron would treat flags as "bad option".
set "ELECTRON_RUN_AS_NODE="
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
set "ASK="
if "%~1"=="" set "ASK=--ask"
pushd "%~dp0"
"%NODE%" "%~dp0tools\launch-cdp.mjs" %ASK% %*
set "CODE=%ERRORLEVEL%"
popd
if "%~1"=="" pause
exit /b %CODE%
