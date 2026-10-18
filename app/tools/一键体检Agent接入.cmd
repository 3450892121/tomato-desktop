@echo off
chcp 65001 >nul
title 番茄工具箱 - Agent 接入体检
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-agent-mcp.ps1"
echo.
pause
