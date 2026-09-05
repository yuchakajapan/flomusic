@echo off
cd /d "%~dp0public"
set PORT=8899

where python >nul 2>&1
if errorlevel 1 goto nopython

start "flomusic server" /min cmd /c python -m http.server %PORT% --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" http://localhost:%PORT%/

echo.
echo   flomusic をローカルで起動しました。
echo   http://localhost:%PORT%/
echo.
echo   この状態なら「保存先フォルダ」を指定できます。
echo   終了するには、このウィンドウで何かキーを押してください。
echo.
pause >nul
taskkill /fi "WINDOWTITLE eq flomusic server*" /t /f >nul 2>&1
exit /b

:nopython
echo.
echo   Python が見つかりませんでした。
echo.
pause
