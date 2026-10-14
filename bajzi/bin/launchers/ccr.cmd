@echo off
setlocal
set "CC_ROUTER_ENTRY=ccr"
node "%~dp0cc-router.js" %*
exit /b %ERRORLEVEL%
