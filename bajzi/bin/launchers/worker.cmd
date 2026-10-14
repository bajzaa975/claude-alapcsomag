@echo off
setlocal
set "CC_ROUTER_ENTRY=worker"
node "%~dp0cc-router.js" %*
exit /b %ERRORLEVEL%
