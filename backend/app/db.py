import logging
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Request

logger = logging.getLogger("cardboard.db")

SCHEMA_PATH = Path(__file__).with_name("schema.sql")
SCHEMA_VERSION = 2


def new_id() -> str:
    return str(uuid.uuid4())


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def open_conn(db_path: Path) -> sqlite3.Connection:
    # isolation_level=None: 交易由 session() 明確控制，避免 sqlite3 模組隱式開關交易
    conn = sqlite3.connect(db_path, isolation_level=None, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")  # 每個連線都必須開
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def _migrate_v1_to_v2(conn: sqlite3.Connection) -> None:
    """將 v1 資料庫無損遷移至 v2：domain -> location，新增 card_type/curation_status/facet/definition/tag_aliases。"""
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            card_cols = {r["name"] for r in conn.execute("PRAGMA table_info(cards)")}
            if "card_type" not in card_cols:
                conn.execute(
                    "ALTER TABLE cards ADD COLUMN card_type TEXT NOT NULL DEFAULT 'untyped' "
                    "CHECK (card_type IN ('untyped', 'concept', 'mechanism', 'hypothesis', 'method', 'case', 'source', 'question'))"
                )
            if "curation_status" not in card_cols:
                conn.execute(
                    "ALTER TABLE cards ADD COLUMN curation_status TEXT NOT NULL DEFAULT 'inbox' "
                    "CHECK (curation_status IN ('inbox', 'curated'))"
                )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_cards_curation ON cards (curation_status)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_cards_type ON cards (card_type)")

            conn.execute(
                """
                CREATE TABLE tags_v2 (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    axis       TEXT NOT NULL CHECK (axis IN ('location', 'domain', 'type', 'concept', 'free')),
                    facet      TEXT,
                    definition TEXT NOT NULL DEFAULT '',
                    parent_id  TEXT REFERENCES tags_v2 (id) ON DELETE RESTRICT,
                    created_at TEXT NOT NULL,
                    CHECK (axis NOT IN ('free', 'concept') OR parent_id IS NULL)
                )
                """
            )
            tag_cols = {r["name"] for r in conn.execute("PRAGMA table_info(tags)")}
            facet_expr = "facet" if "facet" in tag_cols else "NULL"
            def_expr = "definition" if "definition" in tag_cols else "''"
            conn.execute(
                f"""
                INSERT INTO tags_v2 (id, name, axis, facet, definition, parent_id, created_at)
                SELECT id, name,
                       CASE WHEN axis = 'domain' THEN 'location' ELSE axis END,
                       {facet_expr}, {def_expr}, parent_id, created_at
                FROM tags
                """
            )
            conn.execute("DROP TABLE tags")
            conn.execute("ALTER TABLE tags_v2 RENAME TO tags")
            conn.execute(
                "CREATE UNIQUE INDEX uq_tags_sibling ON tags (parent_id, name) WHERE parent_id IS NOT NULL"
            )
            conn.execute(
                "CREATE UNIQUE INDEX uq_tags_root ON tags (axis, COALESCE(facet, ''), name) WHERE parent_id IS NULL"
            )
            conn.execute("CREATE INDEX idx_tags_parent ON tags (parent_id)")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tag_aliases (
                    alias      TEXT PRIMARY KEY COLLATE NOCASE,
                    tag_id     TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tag_aliases_tag ON tag_aliases (tag_id)")

            link_cols = {r["name"] for r in conn.execute("PRAGMA table_info(links)")}
            if not link_cols:
                conn.execute(
                    """
                    CREATE TABLE links (
                        source_id     TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
                        target_id     TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
                        relation_type TEXT NOT NULL DEFAULT 'extend'
                                      CHECK (relation_type IN ('support', 'refute', 'influence', 'instance_of', 'applied_to', 'extend')),
                        status        TEXT NOT NULL DEFAULT 'confirmed'
                                      CHECK (status IN ('confirmed', 'hypothesis')),
                        reason        TEXT NOT NULL DEFAULT '',
                        created_at    TEXT NOT NULL,
                        PRIMARY KEY (source_id, target_id, relation_type),
                        CHECK (source_id <> target_id)
                    )
                    """
                )
                conn.execute("CREATE INDEX IF NOT EXISTS idx_links_target ON links (target_id)")
            elif "source_id" not in link_cols:
                conn.execute(
                    """
                    CREATE TABLE links_v2 (
                        source_id     TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
                        target_id     TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
                        relation_type TEXT NOT NULL DEFAULT 'extend'
                                      CHECK (relation_type IN ('support', 'refute', 'influence', 'instance_of', 'applied_to', 'extend')),
                        status        TEXT NOT NULL DEFAULT 'confirmed'
                                      CHECK (status IN ('confirmed', 'hypothesis')),
                        reason        TEXT NOT NULL DEFAULT '',
                        created_at    TEXT NOT NULL,
                        PRIMARY KEY (source_id, target_id, relation_type),
                        CHECK (source_id <> target_id)
                    )
                    """
                )
                conn.execute(
                    """
                    INSERT INTO links_v2 (source_id, target_id, relation_type, status, reason, created_at)
                    SELECT card_a, card_b, 'extend', 'confirmed', '', created_at FROM links
                    """
                )
                conn.execute("DROP TABLE links")
                conn.execute("ALTER TABLE links_v2 RENAME TO links")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_links_target ON links (target_id)")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS board_groups (
                    id         TEXT PRIMARY KEY,
                    board_id   TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
                    label      TEXT NOT NULL DEFAULT '',
                    x          REAL NOT NULL,
                    y          REAL NOT NULL,
                    w          REAL NOT NULL CHECK (w > 0),
                    h          REAL NOT NULL CHECK (h > 0),
                    color      TEXT NOT NULL DEFAULT 'slate',
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_board_groups_board ON board_groups (board_id)")

            fk_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
            if fk_errors:
                raise RuntimeError(f"v1 -> v2 遷移外鍵檢查失敗：{fk_errors}")
            conn.execute("PRAGMA user_version = 2")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = open_conn(db_path)
    try:
        has_cards = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cards'"
        ).fetchone()
        if not has_cards:
            conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        card_cols = {r["name"] for r in conn.execute("PRAGMA table_info(cards)")}
        tag_cols = {r["name"] for r in conn.execute("PRAGMA table_info(tags)")}
        link_cols = {r["name"] for r in conn.execute("PRAGMA table_info(links)")}
        has_groups = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='board_groups'"
        ).fetchone()
        if (
            version in (1, 3)
            or "card_type" not in card_cols
            or "facet" not in tag_cols
            or "source_id" not in link_cols
            or not has_groups
        ):
            _migrate_v1_to_v2(conn)
            version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version != SCHEMA_VERSION:
            raise RuntimeError(
                f"資料庫 schema 版本為 {version}，程式預期 {SCHEMA_VERSION}；請先處理遷移，不要直接使用"
            )
    finally:
        conn.close()


@contextmanager
def session(request: Request, write: bool):
    """一個請求一個連線、一個交易。例外一律回滾後再往上拋。"""
    conn = open_conn(request.app.state.settings.db_path)
    try:
        conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        try:
            yield conn
        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                logger.error("ROLLBACK 失敗", exc_info=True)
            raise
        else:
            conn.execute("COMMIT")
    finally:
        conn.close()


def descendant_ids(conn: sqlite3.Connection, tag_id: str) -> list[str]:
    """含自己的所有後代。用 UNION（不是 UNION ALL）去重，即使資料異常也不會無窮迴圈。"""
    rows = conn.execute(
        """
        WITH RECURSIVE sub(id) AS (
            SELECT ?
            UNION
            SELECT t.id FROM tags t JOIN sub s ON t.parent_id = s.id
        )
        SELECT id FROM sub
        """,
        (tag_id,),
    ).fetchall()
    return [r["id"] for r in rows]


def is_unique_violation(exc: sqlite3.IntegrityError) -> bool:
    return "UNIQUE constraint failed" in str(exc)
