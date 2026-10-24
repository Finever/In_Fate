@echo off
rem 从终端快速启动桌面壳；双击请用 In_Fate.lnk。
cd /d "%~dp0"
node run.mjs %*
