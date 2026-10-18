@echo off
chcp 65001 >nul
title 番茄工具箱 - 移除 Qoder 接入
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-qoder-mcp.ps1"
echo.
pause
