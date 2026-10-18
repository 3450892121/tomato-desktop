@echo off
chcp 65001 >nul
title 番茄工具箱 - 一键接入 ZCode
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-agent-mcp.ps1" -Client ZCode
echo.
pause
