@echo off
rem Start Clippit on Windows (after `npm install` and `npm run setup` in this folder). Returns at once:
rem Clippit lives in the tray, and a second `clippit` just brings him back.
setlocal
set "HERE=%~dp0.."
set "CLAUDECODE="
if defined CLIPPIT_ELECTRON ( set "EXE=%CLIPPIT_ELECTRON%" ) else ( set "EXE=%HERE%\node_modules\electron\dist\electron.exe" )
if not exist "%EXE%" ( echo clippit: Electron is missing, run `npm install` in %HERE% & exit /b 1 )
start "" "%EXE%" "%HERE%" %*
