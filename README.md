# Cardboard

本地端的卡片＋白板筆記軟體（類 Heptabase）。資料全部在本機：`data/cardboard.db`（SQLite）與 `data/media/`（圖片、影片）。

## 啟動

```bash
./start.sh
```

然後用瀏覽器開 <http://127.0.0.1:8000>。服務只綁定本機，沒有登入驗證，**不要改成對外開放**。

第一次啟動需要 Python 3.11+ 與 Node.js（用來建置前端）。資料位置可用環境變數 `CARDBOARD_DATA` 指定。

## 開發

```bash
cd frontend && npm run dev     # 前端開發伺服器（API 代理到 8000）
cd backend && .venv/bin/python run.py
```

## 驗收

```bash
scripts/check.sh               # 結構檢查 + 後端測試 + 前端型別/測試/建置 + 端到端
```

## 備份

```bash
backend/.venv/bin/python scripts/backup.py ~/cardboard-backups
```

用 SQLite 備份介面複製資料庫（服務執行中也安全），再複製媒體資料夾，最後做完整性檢查。**不要只複製 `cardboard.db` 一個檔案**（WAL 模式下資料可能還在 `-wal` 檔裡，且圖片在 media 資料夾）。

## 與規格的差異

- 所有 API 路徑加上 `/api` 前綴。
- 新增 `GET /api/media/{id}/info`：前端靠它判斷內文引用的是圖片還是影片，並在檔案不存在時顯示「圖片遺失」。
- 行內新增的標籤一律是「自由標籤」；櫃子／抽屜只在左側面板建立。
