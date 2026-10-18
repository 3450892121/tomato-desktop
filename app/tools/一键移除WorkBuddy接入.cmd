@echo off
chcp 65001 >nul
title 番茄工具箱 - 移除 WorkBuddy 接入
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-agent-mcp.ps1" -Client WorkBuddy
echo.
pause
