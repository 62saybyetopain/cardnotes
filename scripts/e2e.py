"""端到端驗證：啟動真實服務（run.py），用 HTTP 跑完整流程，重啟後再驗證資料仍在。

用法：backend/.venv/bin/python scripts/e2e.py
每一項輸出 PASS/FAIL；任何一項失敗，結束碼為 1。
"""
import io
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
BASE = "http://127.0.0.1:8000"
results: list[tuple[bool, str]] = []


def check(name: str, cond: bool, detail: str = ""):
    results.append((cond, name))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  → {detail}" if detail and not cond else ""))


def listening_addrs(port: int) -> set[str]:
    """讀 /proc/net/tcp(6)，回傳正在監聽該連接埠的本機位址（沒有 ss/netstat 也能用）。"""
    out: set[str] = set()
    for fname, width in (("/proc/net/tcp", 8), ("/proc/net/tcp6", 32)):
        try:
            lines = Path(fname).read_text().splitlines()[1:]
        except FileNotFoundError:
            continue
        for line in lines:
            parts = line.split()
            local, state = parts[1], parts[3]
            addr_hex, port_hex = local.split(":")
            if state != "0A" or int(port_hex, 16) != port:
                continue
            if set(addr_hex) == {"0"}:
                out.add("ALL")
            elif width == 8:
                b = bytes.fromhex(addr_hex)[::-1]
                out.add(".".join(str(x) for x in b))
            else:
                out.add("ipv6:" + addr_hex)
    return out


def start(data_dir: str) -> subprocess.Popen:
    env = {**os.environ, "CARDBOARD_DATA": data_dir}
    proc = subprocess.Popen(
        [sys.executable, "run.py"], cwd=BACKEND, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    for _ in range(100):
        try:
            if httpx.get(f"{BASE}/api/boards", timeout=0.5).status_code == 200:
                return proc
        except httpx.HTTPError:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("服務沒有在 10 秒內啟動：\n" + (proc.stdout.read() if proc.stdout else ""))


def stop(proc: subprocess.Popen):
    proc.send_signal(signal.SIGINT)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def png(color: str) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(buf, "PNG")
    return buf.getvalue()


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="cardboard-e2e-")
    proc = start(data_dir)
    c = httpx.Client(base_url=BASE, timeout=10)
    try:
        # E1：只綁本機、單一服務同時提供前端與 API
        addrs = listening_addrs(8000)
        check("E1 只綁定 127.0.0.1:8000（沒有對外開放）", addrs == {"127.0.0.1"}, f"實際監聽：{addrs}")
        home = c.get("/")
        check("E1 同一個服務提供前端頁面", home.status_code == 200 and "<div id=\"root\">" in home.text)
        js = re.search(r'src="(/assets/[^"]+\.js)"', home.text)
        check("E1 前端打包檔可取得", bool(js) and c.get(js.group(1)).status_code == 200)

        # E2：完整流程
        cab = c.post("/api/tags", json={"name": "解剖", "axis": "domain"}).json()
        dr = c.post("/api/tags", json={"name": "下肢", "axis": "domain", "parent_id": cab["id"]}).json()
        sub = c.post("/api/tags", json={"name": "股四頭肌", "axis": "domain", "parent_id": dr["id"]}).json()
        free = c.post("/api/tags", json={"name": "待讀", "axis": "free"}).json()
        check("E2 建立櫃子/抽屜/小格/自由標籤", all("id" in x for x in (cab, dr, sub, free)))

        inbox = c.post("/api/cards", json={"title": "收件匣卡片", "body": "未歸檔"}).json()
        check("E2 不指定標籤的新卡片是未分類", c.get("/api/tags").json()["unclassified_count"] == 1)

        img = c.post("/api/media", files={"file": ("貼上的圖.png", png("red"), "image/png")})
        mid = img.json()["id"]
        check("E2 上傳圖片成功（201）", img.status_code == 201 and img.json()["kind"] == "image")
        again = c.post("/api/media", files={"file": ("另一個名字.png", png("red"), "image/png")})
        check("E2 同圖重傳去重（200、同 id）", again.status_code == 200 and again.json()["id"] == mid)
        fake = c.post("/api/media", files={"file": ("x.png", b"not an image", "image/png")})
        check("E2 偽裝成圖片的文字檔被拒絕（415）", fake.status_code == 415)
        got = c.get(f"/api/media/{mid}")
        check("E2 圖片可取回且內容一致", got.status_code == 200 and got.headers["content-type"] == "image/png" and got.content == png("red"))

        card = c.post("/api/cards", json={"title": "股四頭肌筆記", "body": f"結構圖：\n![](media:{mid})\n重點：50% 的案例", "tag_ids": [sub["id"], free["id"]]}).json()
        check("E2 在小格底下建立卡片並帶圖片引用，無遺失媒體警告", card["warnings"] == [])

        r = c.get("/api/cards", params={"q": "50%"}).json()["items"]
        check("E2 關鍵字搜尋（含 % 特殊字元）只找到該卡片", [x["id"] for x in r] == [card["id"]])
        r = c.get("/api/cards", params={"tag_id": cab["id"]}).json()["items"]
        check("E2 以最上層櫃子篩選，包含深層後代的卡片", [x["id"] for x in r] == [card["id"]])

        board = c.post("/api/boards", json={"name": "下肢整理"}).json()
        c.post(f"/api/boards/{board['id']}/cards", json={"card_id": card["id"], "x": 10, "y": 20})
        c.post(f"/api/boards/{board['id']}/cards", json={"card_id": inbox["id"], "x": 400, "y": 20})
        c.patch(f"/api/boards/{board['id']}/cards", json={"items": [{"card_id": card["id"], "x": 111.5, "y": 222.5, "w": 320, "h": 240}]})
        c.put("/api/links", json={"card_id": card["id"], "other_id": inbox["id"]})
        b = c.get(f"/api/boards/{board['id']}").json()
        pos = {x["card_id"]: (x["x"], x["y"], x["w"], x["h"]) for x in b["cards"]}
        check("E2 改位置與大小後重新讀取，數值不變", pos[card["id"]] == (111.5, 222.5, 320, 240))
        check("E2 白板回傳兩端都在板上的連結", len(b["links"]) == 1)

        # 刪最上層之下的抽屜：卡片改歸屬到上一層，小格上移
        prev = c.get(f"/api/tags/{dr['id']}/delete-preview").json()
        check("E2 刪抽屜前的影響預覽正確", prev["child_count"] == 1 and prev["new_parent"]["id"] == cab["id"] and prev["conflicts"] == [])
        c.delete(f"/api/tags/{dr['id']}")
        tags = {t["id"]: t for t in c.get("/api/tags").json()["tags"]}
        check("E2 刪抽屜後：小格上移接到櫃子", dr["id"] not in tags and tags[sub["id"]]["parent_id"] == cab["id"])

        # 從白板移除 ≠ 刪卡片
        c.delete(f"/api/boards/{board['id']}/cards/{inbox['id']}")
        check("E2 從白板移除後卡片仍存在", c.get(f"/api/cards/{inbox['id']}").status_code == 200)

        # 版本衝突
        cur = c.get(f"/api/cards/{card['id']}").json()
        ok = c.patch(f"/api/cards/{card['id']}", json={"title": "改過的標題", "expected_updated_at": cur["updated_at"]})
        stale = c.patch(f"/api/cards/{card['id']}", json={"title": "過期的修改", "expected_updated_at": cur["updated_at"]})
        check("E2 過期版本的儲存被拒絕（409），且不覆蓋", ok.status_code == 200 and stale.status_code == 409 and c.get(f"/api/cards/{card['id']}").json()["title"] == "改過的標題")

        # 孤兒清理預設不動東西
        cl = c.post("/api/media/cleanup").json()
        check("E2 孤兒清理預設為 dry-run 且不列出剛建立或被引用的圖片", cl["dry_run"] is True and cl["orphans"] == [])

        snapshot = {
            "title": c.get(f"/api/cards/{card['id']}").json()["title"],
            "pos": pos[card["id"]],
            "tags": sorted(t["name"] for t in c.get("/api/tags").json()["tags"]),
        }
        c.close()
        stop(proc)

        # E2：重啟後資料仍在
        proc = start(data_dir)
        c = httpx.Client(base_url=BASE, timeout=10)
        b2 = c.get(f"/api/boards/{board['id']}").json()
        pos2 = {x["card_id"]: (x["x"], x["y"], x["w"], x["h"]) for x in b2["cards"]}
        check("E2 重啟後：卡片位置與大小仍在", pos2.get(card["id"]) == snapshot["pos"] and len(b2["cards"]) == 1)
        check("E2 重啟後：卡片標題與標籤仍在", c.get(f"/api/cards/{card['id']}").json()["title"] == snapshot["title"] and sorted(t["name"] for t in c.get("/api/tags").json()["tags"]) == snapshot["tags"])
        again = c.get(f"/api/media/{mid}")
        check("E2 重啟後：圖片仍可取回", again.status_code == 200 and again.content == png("red"))

        # 刪卡片：連鎖刪除，並讓圖片變孤兒（需手動清理才會真的刪）
        imp = c.get(f"/api/cards/{card['id']}/impact").json()
        check("E2 刪卡片前的影響預覽：1 塊白板、1 條連結", imp["board_count"] == 1 and imp["link_count"] == 1)
        c.delete(f"/api/cards/{card['id']}")
        check("E2 刪卡片後白板上的位置一併消失", c.get(f"/api/boards/{board['id']}").json()["cards"] == [])
        check("E2 刪卡片不會自動刪圖片檔（等手動清理）", c.get(f"/api/media/{mid}").status_code == 200)
        check("E2 錯誤回應格式一致", c.get("/api/cards/不存在").json()["error"]["code"] == "NOT_FOUND")
    finally:
        try:
            c.close()
        except Exception:
            pass
        stop(proc)

    failed = [n for ok, n in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} 通過")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
