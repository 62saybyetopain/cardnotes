"""備份：用 SQLite 的備份介面複製資料庫（服務執行中也安全），再複製 media 資料夾。

用法：python scripts/backup.py <備份目的資料夾>
資料位置由環境變數 CARDBOARD_DATA 決定（預設為專案下的 data/）。
備份完成後會開啟備份的資料庫做完整性檢查，並比對媒體檔案數量；任何一項不符就以非 0 結束。
"""
import os
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = Path(__file__).resolve().parents[1]
    data = Path(os.environ.get("CARDBOARD_DATA", root / "data")).resolve()
    src_db, src_media = data / "cardboard.db", data / "media"
    if not src_db.is_file():
        print(f"找不到資料庫：{src_db}")
        return 1
    dest = Path(sys.argv[1]).resolve() / f"cardboard-backup-{datetime.now():%Y%m%d-%H%M%S}"
    dest.mkdir(parents=True)

    src = sqlite3.connect(src_db)
    dst = sqlite3.connect(dest / "cardboard.db")
    try:
        src.backup(dst)
    finally:
        src.close()
        dst.close()

    if src_media.is_dir():
        shutil.copytree(src_media, dest / "media", ignore=shutil.ignore_patterns(".tmp"))

    chk = sqlite3.connect(dest / "cardboard.db")
    try:
        ok = chk.execute("PRAGMA integrity_check").fetchone()[0]
        cards = chk.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
        media_rows = chk.execute("SELECT COUNT(*) FROM media").fetchone()[0]
    finally:
        chk.close()
    files = [p for p in (dest / "media").rglob("*") if p.is_file()] if (dest / "media").is_dir() else []
    print(f"備份位置：{dest}\n完整性檢查：{ok}；卡片 {cards} 張；媒體紀錄 {media_rows} 筆；媒體檔案 {len(files)} 個")
    if ok != "ok":
        return 1
    if len(files) < media_rows:
        print("警告：媒體檔案數量少於資料庫紀錄，來源資料本身可能已有遺失的檔案")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
