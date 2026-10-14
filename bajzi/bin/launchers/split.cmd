@echo off
setlocal
set "CC_ROUTER_ENTRY=split"
node "%~dp0cc-router.js" %*
exit /b %ERRORLEVEL%
