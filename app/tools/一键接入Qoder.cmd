@echo off
chcp 65001 >nul
title 番茄工具箱 - 一键接入 Qoder
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-qoder-mcp.ps1"
echo.
pause
