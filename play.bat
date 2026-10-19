@echo off
rem Double-click to play Back Room Poker on Windows (needs Node.js from nodejs.org).
cd /d "%~dp0"
call npm start
if errorlevel 1 pause
