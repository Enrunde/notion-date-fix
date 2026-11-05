@echo off
chcp 65001 >nul
title Notion 自动修正 · 状态自检
cd /d "%~dp0"

echo.
echo   Notion 自动修正 - 状态自检
echo   -------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] 没找到 node.exe
  echo       请安装 Node.js: https://nodejs.org
  echo.
  pause
  exit /b 1
)

node 检查云端状态.js

echo   按任意键关闭...
pause >nul
