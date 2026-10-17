@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist "backend\.venv\Scripts\python.exe" (
    echo [1/3] 正在建立 Python 虛擬環境並安裝依賴...
    python -m venv backend\.venv
    if errorlevel 1 goto :error
    backend\.venv\Scripts\pip.exe install -q -r backend\requirements.txt
    if errorlevel 1 goto :error
)

if not exist "frontend\dist\index.html" (
    echo [2/3] 正在建置前端靜態檔案...
    pushd frontend
    call npm install
    if errorlevel 1 ( popd & goto :error )
    call npm run build
    if errorlevel 1 ( popd & goto :error )
    popd
)

echo [3/3] 正在啟動 Cardboard 服務 (http://127.0.0.1:8000)...
echo 請保持此視窗開啟；欲關閉服務請直接關閉此視窗或按 Ctrl+C。
start "" "http://127.0.0.1:8000"

cd /d "%~dp0backend"
.venv\Scripts\python.exe run.py
if errorlevel 1 goto :error
goto :eof

:error
echo.
echo [錯誤] 服務啟動失敗或異常中斷（若顯示 10048 代表已有另一個服務視窗正在執行）。
pause
exit /b 1