import os
import sqlite3
import time

from conftest import fake_mp4, png_bytes


def upload(client, data, name="x.png", ctype="image/png"):
    return client.post("/api/media", files={"file": (name, data, ctype)})


# B7a：同一檔案上傳兩次只有一列一檔（內容定址去重），否則磁碟會被重複圖片塞滿。
def test_b7_dedupe(client, settings, db):
    data = png_bytes()
    r1, r2 = upload(client, data), upload(client, data, name="other-name.png")
    assert r1.status_code == 201 and r2.status_code == 200
    assert r1.json()["id"] == r2.json()["id"] and r2.json()["existed"] is True
    assert db.execute("SELECT COUNT(*) FROM media").fetchone()[0] == 1
    files = [p for p in settings.media_dir.rglob("*") if p.is_file()]
    assert len(files) == 1
    assert r1.json()["width"] == 4 and r1.json()["kind"] == "image"


# B7b：格式以內容判斷。把文字檔偽裝成 .png 與 image/png 必須被拒絕，且不留下任何檔案。
def test_b7_content_sniffing_rejects_fake(client, settings, db):
    r = upload(client, b"this is not an image at all", name="evil.png", ctype="image/png")
    assert r.status_code == 415 and r.json()["error"]["code"] == "UNSUPPORTED_MEDIA"
    # 檔頭像 PNG 但內容毀損，Pillow 解碼必須擋下
    r = upload(client, b"\x89PNG\r\n\x1a\n" + b"garbage" * 10)
    assert r.status_code == 415
    assert upload(client, b"").status_code == 415
    assert db.execute("SELECT COUNT(*) FROM media").fetchone()[0] == 0
    assert [p for p in settings.media_dir.rglob("*") if p.is_file()] == []


# 實際格式與副檔名無關：.txt 檔名的真 PNG 會被接受並以 .png 儲存（檔名由後端決定）。
def test_extension_is_decided_by_backend(client, db):
    r = upload(client, png_bytes("blue"), name="../../etc/passwd.txt", ctype="text/plain")
    assert r.status_code == 201
    rel = db.execute("SELECT rel_path FROM media").fetchone()[0]
    assert rel.endswith(".png") and ".." not in rel


# B7c：超過上限中止，並且不留暫存檔。圖片與影片上限不同。
def test_b7_size_limits(client, settings):
    big = png_bytes(size=(4, 4)) + b"\x00" * 250_000  # 超過圖片上限 200_000
    r = upload(client, big)
    assert r.status_code == 413 and r.json()["error"]["code"] == "MEDIA_TOO_LARGE"
    assert list((settings.media_dir / ".tmp").glob("*")) == []
    ok = upload(client, fake_mp4(b"\x00" * 250_000), name="v.mp4", ctype="video/mp4")  # 影片上限較大
    assert ok.status_code == 201 and ok.json()["kind"] == "video"
    too_big = upload(client, fake_mp4(b"\x00" * 350_000), name="v.mp4", ctype="video/mp4")
    assert too_big.status_code == 413


# B7d：資料庫寫入失敗時，只刪本次新放的檔案，並且不誤刪原本存在的檔案。
def test_b7_db_failure_cleans_new_file_only(client, settings, db):
    db.execute("CREATE TRIGGER boom BEFORE INSERT ON media BEGIN SELECT RAISE(ABORT, 'boom'); END;")
    db.commit()
    r = upload(client, png_bytes("green"))
    assert r.status_code == 500
    assert [p for p in settings.media_dir.rglob("*") if p.is_file()] == []
    assert list((settings.media_dir / ".tmp").glob("*")) == []
    db.execute("DROP TRIGGER boom")
    db.commit()
    ok = upload(client, png_bytes("green"))
    assert ok.status_code == 201
    path = settings.media_dir / db.execute("SELECT rel_path FROM media").fetchone()[0]
    assert path.exists()


# 資料庫有紀錄但檔案不見：讀取要明確報錯（讓前端顯示「圖片遺失」），再次上傳要自我修復。
def test_missing_file_is_loud_and_self_heals(client, settings, db):
    data = png_bytes("yellow")
    mid = upload(client, data).json()["id"]
    path = settings.media_dir / db.execute("SELECT rel_path FROM media").fetchone()[0]
    path.unlink()
    r = client.get(f"/api/media/{mid}")
    assert r.status_code == 404 and r.json()["error"]["code"] == "MEDIA_FILE_MISSING"
    again = upload(client, data)
    assert again.status_code == 200 and again.json()["id"] == mid
    got = client.get(f"/api/media/{mid}")
    assert got.status_code == 200 and got.headers["content-type"] == "image/png" and got.content == data


def test_get_unknown_media(client):
    assert client.get("/api/media/nope").status_code == 404


# 影片要能拖曳進度：必須支援 Range 請求（規格第 9 節的待確認項目，在此實測）。
def test_video_range_request(client):
    data = fake_mp4(bytes(range(256)) * 20)
    mid = upload(client, data, name="v.mp4", ctype="video/mp4").json()["id"]
    r = client.get(f"/api/media/{mid}", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206
    assert r.content == data[:10]
    assert r.headers["content-range"] == f"bytes 0-9/{len(data)}"


# 內文引用不存在的媒體：儲存成功但必須帶 warnings（不能靜默）；補上後 warnings 消失。
def test_b12_missing_media_warning(client, api):
    ghost = "00000000-0000-4000-8000-000000000000"
    c = api.card("t", body=f"看 ![](media:{ghost}) 這張")
    assert c["warnings"] == [{"code": "MISSING_MEDIA", "ids": [ghost]}]
    real = upload(client, png_bytes()).json()["id"]
    r = client.patch(f"/api/cards/{c['id']}", json={"body": f"![](media:{real})", "expected_updated_at": c["updated_at"]})
    assert r.status_code == 200 and r.json()["warnings"] == []


def _age(settings, db, media_id, seconds):
    ts = time.time() - seconds
    from datetime import datetime, timezone

    db.execute(
        "UPDATE media SET created_at=? WHERE id=?",
        (datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="microseconds"), media_id),
    )
    db.commit()
    rel = db.execute("SELECT rel_path FROM media WHERE id=?", (media_id,)).fetchone()[0]
    os.utime(settings.media_dir / rel, (ts, ts))


# B8：孤兒清理的安全性。被內文引用的、建立不到 24 小時的，都不能出現在刪除清單；
# 預設 dry-run 不動任何東西；真正刪除只刪孤兒。
def test_b8_cleanup_safety(client, api, settings, db):
    used = upload(client, png_bytes("red")).json()["id"]
    old_orphan = upload(client, png_bytes("blue")).json()["id"]
    fresh_orphan = upload(client, png_bytes("black")).json()["id"]
    api.card("uses", body=f"![](media:{used})")
    for m in (used, old_orphan):
        _age(settings, db, m, 3 * 24 * 3600)
    dry = client.post("/api/media/cleanup").json()
    assert dry["dry_run"] is True
    assert [o["id"] for o in dry["orphans"]] == [old_orphan]
    assert db.execute("SELECT COUNT(*) FROM media").fetchone()[0] == 3  # dry-run 沒刪任何東西
    real = client.post("/api/media/cleanup", params={"dry_run": False}).json()
    assert [o["id"] for o in real["orphans"]] == [old_orphan]
    left = {r[0] for r in db.execute("SELECT id FROM media")}
    assert left == {used, fresh_orphan}
    assert client.get(f"/api/media/{used}").status_code == 200
    assert client.get(f"/api/media/{old_orphan}").status_code == 404


# 磁碟上有檔案但資料庫沒紀錄：只列出，不刪。
def test_cleanup_lists_stray_files_without_deleting(client, settings):
    stray = settings.media_dir / "zz" / "stray.bin"
    stray.parent.mkdir(parents=True)
    stray.write_bytes(b"x")
    old = time.time() - 3 * 24 * 3600
    os.utime(stray, (old, old))
    res = client.post("/api/media/cleanup", params={"dry_run": False}).json()
    assert res["stray_files"] == ["zz/stray.bin"]
    assert stray.exists()


# 前端靠 /info 判斷要渲染成圖片還是影片；不存在要明確 404（前端據此顯示「圖片遺失」）。
def test_media_info(client):
    img = upload(client, png_bytes("white")).json()
    vid = upload(client, fake_mp4(), name="v.mp4", ctype="video/mp4").json()
    assert client.get(f"/api/media/{img['id']}/info").json()["kind"] == "image"
    assert client.get(f"/api/media/{vid['id']}/info").json()["kind"] == "video"
    assert client.get("/api/media/nope/info").status_code == 404
