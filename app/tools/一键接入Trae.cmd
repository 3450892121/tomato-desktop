@echo off
chcp 65001 >nul
title 番茄工具箱 - 一键接入 Trae
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-agent-mcp.ps1" -Client Trae
echo.
pause
