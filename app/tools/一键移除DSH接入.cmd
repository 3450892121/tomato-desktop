@echo off
chcp 65001 >nul
title 番茄工具箱 - 移除 DeepSeek Harness 接入
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-dsh-mcp.ps1"
echo.
pause
