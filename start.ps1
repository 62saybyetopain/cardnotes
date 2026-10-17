Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# 切換至腳本所在之專案根目錄
Set-Location $PSScriptRoot

# 1. 後端虛擬環境檢查與依賴安裝
if (-not (Test-Path "backend\.venv")) {
    Write-Host "[1/3] 建立 Python 虛擬環境並安裝依賴..." -ForegroundColor Cyan
    python -m venv backend\.venv
    & ".\backend\.venv\Scripts\pip.exe" install -q -r backend\requirements.txt
}

# 2. 前端靜態資源建置檢查
if (-not (Test-Path "frontend\dist")) {
    Write-Host "[2/3] 安裝前端依賴並編譯靜態產物..." -ForegroundColor Cyan
    Push-Location frontend
    try {
        npm install
        npm run build
    }
    finally {
        Pop-Location
    }
}

# 3. 啟動後端服務（只綁定 127.0.0.1:8000）
Write-Host "[3/3] 啟動 Cardboard 服務..." -ForegroundColor Green
Push-Location backend
try {
    & ".\.venv\Scripts\python.exe" run.py
}
finally {
    Pop-Location
}