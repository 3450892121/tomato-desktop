@echo off
chcp 65001 >nul
title 番茄工具箱 - 重启 DSH
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-dsh.ps1"
echo.
pause
