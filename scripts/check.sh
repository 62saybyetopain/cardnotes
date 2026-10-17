#!/usr/bin/env bash
# 全部驗收：後端測試、前端型別/測試/建置、端到端、結構檢查。任何一步失敗就中止。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 結構檢查：白板相關程式碼不得有任何刪除卡片本身的路徑 =="
if grep -n "deleteCard" frontend/src/components/Board.tsx frontend/src/components/CardNode.tsx; then
  echo "FAIL：白板程式碼引用了 deleteCard"; exit 1
fi
echo "PASS"

echo "== 後端測試 =="
(cd backend && .venv/bin/python -m pytest -q 2>&1 | tail -3)
echo "== 前端型別檢查、測試、建置 =="
(cd frontend && npx tsc --noEmit && npx vitest run 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Test Files|Tests " && npm run build 2>&1 | grep -E "built in|error")
echo "== 端到端 =="
backend/.venv/bin/python scripts/e2e.py | tail -3
