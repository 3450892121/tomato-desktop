@echo off
chcp 65001 >nul
title 番茄工具箱 - 移除 ZCode 接入
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-agent-mcp.ps1" -Client ZCode
echo.
pause
