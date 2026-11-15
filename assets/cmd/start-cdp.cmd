@echo off
rem start-cdp.cmd - launch DSH + TRAE with CDP debugging ports (9223 / 9222)
rem No arguments (double-click): ask before restarting an app that runs without CDP,
rem then pause so the result stays on screen.
rem
rem Workspace discovery order: DSH_TRAE_ROOT, this .cmd folder, one and two folders up,
rem then the current directory and up to 5 of its parents. A trailing backslash is stripped,
rem otherwise %~dp0 would escape the closing quote when passed as --root.
chcp 65001 >nul 2>&1
setlocal
rem DSH shell exports this; Electron would treat flags as "bad option".
set "ELECTRON_RUN_AS_NODE="
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"

rem --- workspace discovery: DSH_TRAE_ROOT, this folder, 1-2 levels up, then %CD% and 5 ancestors ---
call :findroot
if not defined ROOT goto :noroot
goto :afterfind

:findroot
set "ROOT="
if defined DSH_TRAE_ROOT call :try "%DSH_TRAE_ROOT%"
call :try "%~dp0"
call :try "%~dp0.."
call :try "%~dp0..\.."
if defined ROOT goto :eof
set "P=%CD%"
for /l %%i in (1,1,5) do (
  if not defined ROOT call :try "%P%"
  if not defined ROOT for %%d in ("%P%\..") do set "P=%%~fd"
)
goto :eof

:try
if defined ROOT goto :eof
if not exist "%~1\tools\launch-cdp.mjs" goto :eof
for %%d in ("%~1") do set "ROOT=%%~fd"
:stripslash
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
goto :eof

:noroot
echo [start-cdp] Cannot find tools\launch-cdp.mjs near this file.
echo [start-cdp] Put this .cmd in the workspace root, or set the workspace first:
echo     set "DSH_TRAE_ROOT=C:\path\to\DSH-TRAE"
echo     start-cdp.cmd
echo.
pause
exit /b 8

:afterfind
set "ASK="
if "%~1"=="" set "ASK=--ask"
pushd "%ROOT%"
"%NODE%" "%ROOT%\tools\launch-cdp.mjs" --root "%ROOT%" %ASK% %*
set "CODE=%ERRORLEVEL%"
popd
if "%~1"=="" pause
exit /b %CODE%
