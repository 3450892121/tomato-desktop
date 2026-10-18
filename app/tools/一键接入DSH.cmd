@echo off
chcp 65001 >nul
title 番茄工具箱 - 一键接入 DeepSeek Harness
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-dsh-mcp.ps1"
echo.
pause
