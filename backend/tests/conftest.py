import io
import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402


@pytest.fixture
def settings(tmp_path):
    return Settings(
        data_dir=tmp_path,
        max_image_bytes=200_000,
        max_video_bytes=300_000,
        orphan_grace_seconds=24 * 3600,
    )


@pytest.fixture
def client(settings):
    app = create_app(settings)
    # raise_server_exceptions=False：讓 500 以真實 HTTP 回應出現，才能驗證回滾後的狀態
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def db(settings, client):  # 依賴 client，確保資料庫已由應用程式初始化
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    yield conn
    conn.close()


class Api:
    def __init__(self, client):
        self.c = client

    def tag(self, name, axis="domain", parent_id=None):
        r = self.c.post("/api/tags", json={"name": name, "axis": axis, "parent_id": parent_id})
        assert r.status_code == 201, r.text
        return r.json()

    def card(self, title="t", body="", tag_ids=()):
        r = self.c.post("/api/cards", json={"title": title, "body": body, "tag_ids": list(tag_ids)})
        assert r.status_code == 201, r.text
        return r.json()

    def board(self, name="b"):
        r = self.c.post("/api/boards", json={"name": name})
        assert r.status_code == 201, r.text
        return r.json()

    def to_board(self, board_id, card_id, x=0, y=0):
        r = self.c.post(f"/api/boards/{board_id}/cards", json={"card_id": card_id, "x": x, "y": y})
        assert r.status_code == 201, r.text
        return r.json()


@pytest.fixture
def api(client):
    return Api(client)


def png_bytes(color="red", size=(4, 4)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def fake_mp4(extra=b""):
    return b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + extra
