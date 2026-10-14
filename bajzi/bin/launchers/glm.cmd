@echo off
setlocal
set "CC_ROUTER_ENTRY=glm"
node "%~dp0cc-router.js" %*
exit /b %ERRORLEVEL%
