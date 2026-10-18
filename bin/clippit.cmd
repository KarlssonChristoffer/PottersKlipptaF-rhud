@echo off
rem Start Clippit on Windows (after `npm install` in this folder).
set "HERE=%~dp0.."
if defined CLIPPIT_ELECTRON ( "%CLIPPIT_ELECTRON%" "%HERE%" %* ) else ( "%HERE%\node_modules\.bin\electron.cmd" "%HERE%" %* )
