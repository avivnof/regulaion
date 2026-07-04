@echo off
cd /d "%~dp0"
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%NODE_EXE%" (
  echo Node.js לא נמצא בסביבת Codex.
  echo אפשר להפעיל את לוח הניהול דרך Codex, או להתקין Node.js במחשב.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:8020/admin"
"%NODE_EXE%" "tools\admin-server.mjs"
pause
