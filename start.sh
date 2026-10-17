#!/usr/bin/env bash
# 一個指令啟動：必要時先建置前端，然後啟動服務（只綁 127.0.0.1:8000）
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d backend/.venv ]; then
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install -q -r backend/requirements.txt
fi
if [ ! -d frontend/dist ]; then
  (cd frontend && npm install && npm run build)
fi
cd backend
exec .venv/bin/python run.py
