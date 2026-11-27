@echo off
setlocal
set "CC_ROUTER_ENTRY=kimi"
node "%~dp0cc-router.js" %*
exit /b %ERRORLEVEL%
