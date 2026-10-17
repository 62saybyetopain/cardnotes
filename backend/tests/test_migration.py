import sqlite3
from contextlib import closing

import pytest

from app.db import init_db

# 假設：依 schema.sql 與 _migrate_v1_to_v2 反推的 v1 結構（無 card_type/curation_status/
# facet/definition/tag_aliases，axis 為 domain/type/free）。真實 v1 不同時，下列測試會大聲失敗。
V1_DDL = """
CREATE TABLE cards (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    source_system TEXT,
    source_id     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    CHECK ((source_system IS NULL) = (source_id IS NULL))
);
CREATE UNIQUE INDEX uq_cards_source
    ON cards (source_system, source_id) WHERE source_system IS NOT NULL;
CREATE TABLE tags (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    axis       TEXT NOT NULL CHECK (axis IN ('domain', 'type', 'free')),
    parent_id  TEXT REFERENCES tags (id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    CHECK (axis != 'free' OR parent_id IS NULL)
);
CREATE TABLE card_tags (
    card_id TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    tag_id  TEXT NOT NULL REFERENCES tags (id) ON DELETE RESTRICT,
    PRIMARY KEY (card_id, tag_id)
);
"""

NOW = "2026-01-01T00:00:00+00:00"


def make_v1(path, orphan_card_tag=False):
    with closing(sqlite3.connect(path)) as c:
        c.executescript(V1_DDL)
        c.executemany(
            "INSERT INTO cards (id, title, body, created_at, updated_at) VALUES (?,?,?,?,?)",
            [("c1", "卡一", "內文一", NOW, NOW), ("c2", "卡二", "內文二", NOW, NOW)],
        )
        c.executemany(
            "INSERT INTO tags (id, name, axis, parent_id, created_at) VALUES (?,?,?,?,?)",
            [
                ("t_root", "櫃子", "domain", None, NOW),
                ("t_child", "抽屜", "domain", "t_root", NOW),
                ("t_free", "呼吸", "free", None, NOW),
            ],
        )
        c.executemany(
            "INSERT INTO card_tags (card_id, tag_id) VALUES (?,?)",
            [("c1", "t_child"), ("c2", "t_free")],
        )
        if orphan_card_tag:
            # 連線預設不啟用外鍵，才能塞進指向不存在標籤的孤兒列
            c.execute("INSERT INTO card_tags (card_id, tag_id) VALUES ('c1', 'ghost')")
        c.execute("PRAGMA user_version = 1")
        c.commit()


def query(path, sql):
    with closing(sqlite3.connect(path)) as c:
        return c.execute(sql).fetchall()


def schema_shape(path, table):
    # 欄位以名稱比對（ALTER ADD COLUMN 的欄位順序本來就會與全新建立不同）
    cols = {(r[1], r[2], r[3], r[4]) for r in query(path, f"PRAGMA table_info({table})")}
    idx = {
        r[0]
        for r in query(
            path,
            f"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='{table}' "
            "AND name NOT LIKE 'sqlite_autoindex%'",
        )
    }
    return cols, idx


def test_migrated_db_matches_fresh_v2_schema(tmp_path):
    # 原因：遷移與 schema.sql 是兩份各自維護的結構定義，不比對就會悄悄分岔。
    fresh, old = tmp_path / "fresh.db", tmp_path / "old.db"
    init_db(fresh)
    make_v1(old)
    init_db(old)
    for table in ("cards", "tags", "tag_aliases"):
        assert schema_shape(old, table) == schema_shape(fresh, table), table


def test_v1_migration_preserves_data_semantics(tmp_path):
    # 原因：遷移「沒報錯」不代表資料沒變錯；要證明身分、層級、歸屬都保住。
    db = tmp_path / "v1.db"
    make_v1(db)
    init_db(db)

    assert query(db, "PRAGMA user_version")[0][0] == 2
    assert query(db, "SELECT id, title, body, card_type, curation_status FROM cards ORDER BY id") == [
        ("c1", "卡一", "內文一", "untyped", "inbox"),
        ("c2", "卡二", "內文二", "untyped", "inbox"),
    ]
    assert query(db, "SELECT id, name, axis, parent_id FROM tags ORDER BY id") == [
        ("t_child", "抽屜", "location", "t_root"),
        ("t_free", "呼吸", "free", None),
        ("t_root", "櫃子", "location", None),
    ]
    assert query(db, "SELECT card_id, tag_id FROM card_tags ORDER BY card_id") == [
        ("c1", "t_child"),
        ("c2", "t_free"),
    ]
    # DROP + RENAME 之後，外鍵必須指向新的 tags，而不是殘留舊名稱
    assert {r[2] for r in query(db, "PRAGMA foreign_key_list(tags)")} == {"tags"}
    assert {r[2] for r in query(db, "PRAGMA foreign_key_list(card_tags)")} == {"cards", "tags"}
    assert query(db, "PRAGMA foreign_key_check") == []


def test_half_upgraded_db_is_repaired_by_column_check(tmp_path):
    # 原因：只信 user_version 會放過「版本號是 2 但欄位缺失」的庫；init_db 必須檢查欄位。
    db = tmp_path / "half.db"
    make_v1(db)
    with closing(sqlite3.connect(db)) as c:
        c.execute("PRAGMA user_version = 2")
        c.commit()
    init_db(db)

    assert "card_type" in {r[1] for r in query(db, "PRAGMA table_info(cards)")}
    assert "facet" in {r[1] for r in query(db, "PRAGMA table_info(tags)")}
    assert query(db, "SELECT COUNT(*) FROM cards")[0][0] == 2


def test_init_db_twice_does_not_change_data(tmp_path):
    # 原因：每次啟動都會呼叫 init_db，第二次必須是無副作用。
    db = tmp_path / "twice.db"
    make_v1(db)
    init_db(db)
    first = [query(db, f"SELECT * FROM {t} ORDER BY 1, 2") for t in ("cards", "tags", "card_tags")]
    init_db(db)
    second = [query(db, f"SELECT * FROM {t} ORDER BY 1, 2") for t in ("cards", "tags", "card_tags")]
    assert first == second


def test_failed_migration_rolls_back_and_raises(tmp_path):
    # 原因：外鍵檢查失敗必須大聲報錯，且庫要停在可重試的 v1，不能留下半升級狀態。
    db = tmp_path / "bad.db"
    make_v1(db, orphan_card_tag=True)
    with pytest.raises(RuntimeError):
        init_db(db)

    assert query(db, "PRAGMA user_version")[0][0] == 1
    assert "domain" in {r[0] for r in query(db, "SELECT axis FROM tags")}
    assert "card_type" not in {r[1] for r in query(db, "PRAGMA table_info(cards)")}
    assert query(db, "SELECT name FROM sqlite_master WHERE name='tags_v2'") == []