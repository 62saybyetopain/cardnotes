import re
import sqlite3
from typing import Any, Optional

from fastapi import APIRouter, Query, Request

from .db import descendant_ids, new_id, session, utc_now
from .errors import AppError, ErrorCode
from .schemas import (
    CardCreate,
    CardPatch,
    CardType,
    CurationStatus,
    SyncApplyRequest,
    SyncPackage,
)

router = APIRouter(prefix="/api")
DEFAULT_CARD_WIDTH = 280.0

MEDIA_REF = re.compile(r"!\[[^\]]*\]\(media:([0-9a-fA-F-]{36})\)")
CARD_REF = re.compile(r"(?<!!)\[(?:\\.|[^\[\]\\])*\]\(card:([0-9a-fA-F-]{36})\)")


def media_refs(body: str) -> list[str]:
    return list(dict.fromkeys(m.lower() for m in MEDIA_REF.findall(body)))


def missing_media(conn: sqlite3.Connection, body: str) -> list[str]:
    ids = media_refs(body)
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    found = {r["id"] for r in conn.execute(f"SELECT id FROM media WHERE id IN ({marks})", ids)}
    return [i for i in ids if i not in found]


def card_refs(body: str) -> list[str]:
    return list(dict.fromkeys(m.lower() for m in CARD_REF.findall(body)))


def missing_cards(conn: sqlite3.Connection, body: str) -> list[str]:
    ids = card_refs(body)
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    found = {r["id"] for r in conn.execute(f"SELECT id FROM cards WHERE id IN ({marks})", ids)}
    return [i for i in ids if i not in found]


def card_detail(conn: sqlite3.Connection, card_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "卡片不存在", {"card_id": card_id})
    tag_rows = conn.execute(
        """SELECT t.id, t.name, t.axis, t.facet, t.definition, t.parent_id FROM tags t
           JOIN card_tags ct ON ct.tag_id = t.id WHERE ct.card_id = ? ORDER BY t.axis, t.name""",
        (card_id,),
    ).fetchall()
    tag_ids = [t["id"] for t in tag_rows]
    by_tag: dict[str, list[str]] = {}
    if tag_ids:
        marks = ",".join("?" * len(tag_ids))
        for ar in conn.execute(
            f"SELECT tag_id, alias FROM tag_aliases WHERE tag_id IN ({marks}) ORDER BY alias", tag_ids
        ):
            by_tag.setdefault(ar["tag_id"], []).append(ar["alias"])
    tags = [
        {
            "id": t["id"],
            "name": t["name"],
            "axis": t["axis"],
            "facet": t["facet"],
            "definition": t["definition"] or "",
            "parent_id": t["parent_id"],
            "aliases": by_tag.get(t["id"], []),
        }
        for t in tag_rows
    ]
    link_rows = conn.execute(
        """SELECT c.id, c.title, l.source_id, l.target_id, l.relation_type, l.status, l.reason
           FROM links l
           JOIN cards c ON (l.source_id = ? AND c.id = l.target_id)
                        OR (l.target_id = ? AND c.id = l.source_id)
           ORDER BY c.title, l.relation_type""",
        (card_id, card_id),
    ).fetchall()
    links = [
        {
            "id": r["id"],
            "title": r["title"],
            "source_id": r["source_id"],
            "target_id": r["target_id"],
            "direction": "outgoing" if r["source_id"] == card_id else "incoming",
            "relation_type": r["relation_type"],
            "status": r["status"],
            "reason": r["reason"] or "",
        }
        for r in link_rows
    ]
    boards = conn.execute(
        """SELECT b.id, b.name FROM boards b JOIN board_cards bc ON bc.board_id = b.id
           WHERE bc.card_id = ? ORDER BY b.name""",
        (card_id,),
    ).fetchall()
    missing_m = missing_media(conn, row["body"])
    missing_c = missing_cards(conn, row["body"])
    warnings = []
    if missing_m:
        warnings.append({"code": "MISSING_MEDIA", "ids": missing_m})
    if missing_c:
        warnings.append({"code": "MISSING_CARD", "ids": missing_c})
    return {
        **dict(row),
        "tags": tags,
        "links": links,
        "boards": [dict(r) for r in boards],
        "warnings": warnings,
    }


def _impact(conn: sqlite3.Connection, card_id: str) -> dict[str, Any]:
    if conn.execute("SELECT 1 FROM cards WHERE id = ?", (card_id,)).fetchone() is None:
        raise AppError(ErrorCode.NOT_FOUND, "卡片不存在", {"card_id": card_id})
    boards = conn.execute(
        """SELECT b.name FROM boards b JOIN board_cards bc ON bc.board_id = b.id
           WHERE bc.card_id = ? ORDER BY b.name""",
        (card_id,),
    ).fetchall()
    links = conn.execute(
        "SELECT COUNT(*) AS n FROM links WHERE source_id = ? OR target_id = ?", (card_id, card_id)
    ).fetchone()["n"]
    return {"board_count": len(boards), "board_names": [b["name"] for b in boards], "link_count": links}


def like_pattern(q: str) -> str:
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{esc}%"


def _snippet(body: str, q: Optional[str]) -> str:
    if q:
        idx = body.lower().find(q.lower())
        if idx >= 0:
            start = max(0, idx - 40)
            return ("…" if start else "") + body[start : idx + 120]
    return body[:160]


@router.post("/cards", status_code=201)
def create_card(payload: CardCreate, request: Request):
    with session(request, write=True) as conn:
        for tid in payload.tag_ids:
            if conn.execute("SELECT 1 FROM tags WHERE id = ?", (tid,)).fetchone() is None:
                raise AppError(ErrorCode.NOT_FOUND, "標籤不存在", {"tag_id": tid})
        cid, now = new_id(), utc_now()
        conn.execute(
            """INSERT INTO cards (id, title, body, card_type, curation_status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (cid, payload.title, payload.body, payload.card_type.value, payload.curation_status.value, now, now),
        )
        conn.executemany(
            "INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)",
            [(cid, tid) for tid in payload.tag_ids],
        )
        return card_detail(conn, cid)


@router.get("/cards/titles")
def get_card_titles(request: Request, ids: str = Query("")):
    raw_ids = [i.strip() for i in ids.split(",") if i.strip()]
    unique_ids = list(dict.fromkeys(raw_ids))[:200]
    if not unique_ids:
        return {"titles": {}}
    marks = ",".join("?" * len(unique_ids))
    with session(request, write=False) as conn:
        rows = conn.execute(f"SELECT id, title FROM cards WHERE id IN ({marks})", unique_ids).fetchall()
        return {"titles": {r["id"]: r["title"] for r in rows}}


@router.get("/cards/{card_id}/title")
def get_card_title(card_id: str, request: Request):
    with session(request, write=False) as conn:
        row = conn.execute("SELECT id, title FROM cards WHERE id = ?", (card_id,)).fetchone()
        if row is None:
            raise AppError(ErrorCode.NOT_FOUND, "卡片不存在", {"card_id": card_id})
        return {"id": row["id"], "title": row["title"]}


@router.get("/cards/{card_id}")
def get_card(card_id: str, request: Request):
    with session(request, write=False) as conn:
        return card_detail(conn, card_id)


@router.patch("/cards/{card_id}")
def patch_card(card_id: str, payload: CardPatch, request: Request):
    if (
        payload.title is None
        and payload.body is None
        and payload.card_type is None
        and payload.curation_status is None
    ):
        raise AppError(ErrorCode.VALIDATION_ERROR, "至少要提供一個更新欄位")
    with session(request, write=True) as conn:
        row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
        if row is None:
            raise AppError(ErrorCode.NOT_FOUND, "卡片不存在", {"card_id": card_id})
        if row["updated_at"] != payload.expected_updated_at:
            raise AppError(
                ErrorCode.STALE_VERSION,
                "這張卡片已在別處被修改，請重新載入後再儲存",
                {"current": card_detail(conn, card_id)},
            )
        title = payload.title if payload.title is not None else row["title"]
        body = payload.body if payload.body is not None else row["body"]
        card_type = payload.card_type.value if payload.card_type is not None else row["card_type"]
        curation_status = (
            payload.curation_status.value if payload.curation_status is not None else row["curation_status"]
        )
        conn.execute(
            """UPDATE cards SET title = ?, body = ?, card_type = ?, curation_status = ?, updated_at = ?
               WHERE id = ?""",
            (title, body, card_type, curation_status, utc_now(), card_id),
        )
        return card_detail(conn, card_id)


@router.get("/cards/{card_id}/impact")
def card_impact(card_id: str, request: Request):
    with session(request, write=False) as conn:
        return _impact(conn, card_id)


@router.delete("/cards/{card_id}")
def delete_card(card_id: str, request: Request):
    with session(request, write=True) as conn:
        impact = _impact(conn, card_id)
        conn.execute("DELETE FROM cards WHERE id = ?", (card_id,))  # 外鍵連鎖刪除白板位置、連結、標籤歸屬
        return {"deleted": True, **impact}


@router.get("/cards")
def list_cards(
    request: Request,
    q: Optional[str] = None,
    tag_id: Optional[str] = None,
    unclassified: bool = False,
    curation_status: Optional[CurationStatus] = None,
    card_type: Optional[CardType] = None,
    limit: int = Query(50, ge=1, le=200),
):
    if tag_id and unclassified:
        raise AppError(ErrorCode.VALIDATION_ERROR, "tag_id 與 unclassified 不能同時使用")
    q = q.strip() if q else None
    where, params = [], []
    with session(request, write=False) as conn:
        if q:
            pat = like_pattern(q)
            where.append(
                """(c.title LIKE ? ESCAPE '\\' OR c.body LIKE ? ESCAPE '\\'
                    OR EXISTS (
                        SELECT 1 FROM card_tags ct
                        JOIN tags t ON t.id = ct.tag_id
                        LEFT JOIN tag_aliases a ON a.tag_id = t.id
                        WHERE ct.card_id = c.id
                          AND (t.name LIKE ? ESCAPE '\\' OR a.alias LIKE ? ESCAPE '\\')
                    ))"""
            )
            params += [pat, pat, pat, pat]
        if tag_id:
            if conn.execute("SELECT 1 FROM tags WHERE id = ?", (tag_id,)).fetchone() is None:
                raise AppError(ErrorCode.NOT_FOUND, "標籤不存在", {"tag_id": tag_id})
            ids = descendant_ids(conn, tag_id)
            marks = ",".join("?" * len(ids))
            where.append(f"c.id IN (SELECT card_id FROM card_tags WHERE tag_id IN ({marks}))")
            params += ids
        if unclassified:
            where.append(
                """NOT EXISTS (SELECT 1 FROM card_tags ct JOIN tags t ON t.id = ct.tag_id
                               WHERE ct.card_id = c.id AND t.axis IN ('location', 'domain'))"""
            )
        if curation_status is not None:
            where.append("c.curation_status = ?")
            params.append(curation_status.value)
        if card_type is not None:
            where.append("c.card_type = ?")
            params.append(card_type.value)
        sql = "SELECT c.id, c.title, c.body, c.card_type, c.curation_status, c.updated_at FROM cards c"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY c.updated_at DESC LIMIT ?"
        rows = conn.execute(sql, params + [limit]).fetchall()
        card_ids = [r["id"] for r in rows]
        tags_by_card: dict[str, list[dict[str, Any]]] = {}
        if card_ids:
            c_marks = ",".join("?" * len(card_ids))
            for tr in conn.execute(
                f"""SELECT ct.card_id, t.id, t.name, t.axis, t.facet
                    FROM card_tags ct JOIN tags t ON t.id = ct.tag_id
                    WHERE ct.card_id IN ({c_marks})
                    ORDER BY t.axis, t.name""",
                card_ids,
            ):
                tags_by_card.setdefault(tr["card_id"], []).append(
                    {"id": tr["id"], "name": tr["name"], "axis": tr["axis"], "facet": tr["facet"]}
                )
        return {
            "items": [
                {
                    "id": r["id"],
                    "title": r["title"],
                    "snippet": _snippet(r["body"], q),
                    "card_type": r["card_type"],
                    "curation_status": r["curation_status"],
                    "tags": tags_by_card.get(r["id"], []),
                    "updated_at": r["updated_at"],
                }
                for r in rows
            ]
        }


@router.get("/sync/export")
def sync_export(request: Request):
    with session(request, write=False) as conn:
        cards = conn.execute("SELECT * FROM cards ORDER BY updated_at DESC").fetchall()
        tags = conn.execute("SELECT * FROM tags ORDER BY axis, name").fetchall()
        alias_rows = conn.execute("SELECT tag_id, alias FROM tag_aliases ORDER BY alias").fetchall()
        by_tag: dict[str, list[str]] = {}
        for ar in alias_rows:
            by_tag.setdefault(ar["tag_id"], []).append(ar["alias"])

        card_tags = conn.execute("SELECT card_id, tag_id FROM card_tags").fetchall()
        links = conn.execute("SELECT source_id, target_id, relation_type, status, reason FROM links").fetchall()
        boards = conn.execute("SELECT id, name FROM boards ORDER BY name").fetchall()
        board_cards = conn.execute("SELECT board_id, card_id, x, y, w, h FROM board_cards").fetchall()

        return {
            "version": 1,
            "exported_at": utc_now(),
            "source_device": "pc",
            "cards": [dict(c) for c in cards],
            "tags": [{**dict(t), "aliases": by_tag.get(t["id"], [])} for t in tags],
            "card_tags": [dict(ct) for ct in card_tags],
            "links": [dict(l) for l in links],
            "boards": [dict(b) for b in boards],
            "board_cards": [dict(bc) for bc in board_cards],
        }


@router.post("/sync/diff")
def sync_diff(pkg: SyncPackage, request: Request):
    with session(request, write=False) as conn:
        db_cards = {r["id"]: dict(r) for r in conn.execute("SELECT id, title, body, updated_at FROM cards").fetchall()}
        cards_new = []
        cards_updated = []
        cards_unchanged_count = 0

        for c in pkg.cards:
            if c.id not in db_cards:
                cards_new.append({
                    "id": c.id,
                    "title": c.title,
                    "body": c.body,
                    "updated_at": c.updated_at,
                })
            else:
                db_c = db_cards[c.id]
                if c.updated_at > db_c["updated_at"]:
                    cards_updated.append({
                        "id": c.id,
                        "title": c.title,
                        "old_title": db_c["title"],
                        "new_title": c.title,
                        "old_body": db_c["body"],
                        "new_body": c.body,
                        "old_updated_at": db_c["updated_at"],
                        "new_updated_at": c.updated_at,
                    })
                else:
                    cards_unchanged_count += 1

        db_tags = {r["id"]: dict(r) for r in conn.execute("SELECT id, name, axis, facet, definition, parent_id FROM tags").fetchall()}
        tags_new = []
        tags_updated = []
        for t in pkg.tags:
            if t.id not in db_tags:
                tags_new.append(t.model_dump())
            else:
                db_t = db_tags[t.id]
                if (
                    t.name != db_t["name"]
                    or t.facet != db_t["facet"]
                    or t.definition != db_t["definition"]
                    or t.parent_id != db_t["parent_id"]
                ):
                    tags_updated.append(t.model_dump())

        db_ct = {(r["card_id"], r["tag_id"]) for r in conn.execute("SELECT card_id, tag_id FROM card_tags").fetchall()}
        card_tags_new = [
            ct.model_dump() for ct in pkg.card_tags if (ct.card_id, ct.tag_id) not in db_ct
        ]

        db_links = {
            (r["source_id"], r["target_id"], r["relation_type"])
            for r in conn.execute("SELECT source_id, target_id, relation_type FROM links").fetchall()
        }
        links_new = [
            l.model_dump() for l in pkg.links if (l.source_id, l.target_id, l.relation_type.value) not in db_links
        ]

        db_bc = {(r["board_id"], r["card_id"]) for r in conn.execute("SELECT board_id, card_id FROM board_cards").fetchall()}
        board_cards_new = [
            bc.model_dump() for bc in pkg.board_cards if (bc.board_id, bc.card_id) not in db_bc
        ]

        return {
            "source_device": pkg.source_device,
            "exported_at": pkg.exported_at,
            "cards_new": cards_new,
            "cards_updated": cards_updated,
            "cards_unchanged_count": cards_unchanged_count,
            "tags_new": tags_new,
            "tags_updated": tags_updated,
            "card_tags_new": card_tags_new,
            "links_new": links_new,
            "board_cards_new": board_cards_new,
        }


@router.post("/sync/apply")
def sync_apply(payload: SyncApplyRequest, request: Request):
    pkg = payload.package
    card_map = {c.id: c for c in pkg.cards}
    tag_map = {t.id: t for t in pkg.tags}

    applied = {
        "cards_added": 0,
        "cards_updated": 0,
        "tags_added": 0,
        "tags_updated": 0,
        "card_tags_added": 0,
        "links_added": 0,
        "board_cards_added": 0,
    }

    with session(request, write=True) as conn:
        for tid in payload.tag_ids_to_add:
            t = tag_map.get(tid)
            if not t:
                continue
            axis_val = t.axis.normalized()
            conn.execute(
                """INSERT OR IGNORE INTO tags (id, name, axis, facet, definition, parent_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (t.id, t.name, axis_val, t.facet, t.definition, t.parent_id, utc_now()),
            )
            for a in t.aliases:
                conn.execute(
                    "INSERT OR IGNORE INTO tag_aliases (alias, tag_id, created_at) VALUES (?, ?, ?)",
                    (a, t.id, utc_now()),
                )
            applied["tags_added"] += 1

        for tid in payload.tag_ids_to_update:
            t = tag_map.get(tid)
            if not t:
                continue
            conn.execute(
                "UPDATE tags SET name = ?, facet = ?, definition = ?, parent_id = ? WHERE id = ?",
                (t.name, t.facet, t.definition, t.parent_id, t.id),
            )
            for a in t.aliases:
                conn.execute(
                    "INSERT OR IGNORE INTO tag_aliases (alias, tag_id, created_at) VALUES (?, ?, ?)",
                    (a, t.id, utc_now()),
                )
            applied["tags_updated"] += 1

        for cid in payload.card_ids_to_add:
            c = card_map.get(cid)
            if not c:
                continue
            conn.execute(
                """INSERT OR IGNORE INTO cards (id, title, body, card_type, curation_status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (c.id, c.title, c.body, c.card_type.value, c.curation_status.value, c.created_at, c.updated_at),
            )
            applied["cards_added"] += 1

        for cid in payload.card_ids_to_update:
            c = card_map.get(cid)
            if not c:
                continue
            conn.execute(
                """UPDATE cards SET title = ?, body = ?, card_type = ?, curation_status = ?, updated_at = ?
                   WHERE id = ?""",
                (c.title, c.body, c.card_type.value, c.curation_status.value, c.updated_at, c.id),
            )
            applied["cards_updated"] += 1

        for ct in payload.card_tags_to_add:
            if conn.execute("SELECT 1 FROM cards WHERE id = ?", (ct.card_id,)).fetchone() and conn.execute(
                "SELECT 1 FROM tags WHERE id = ?", (ct.tag_id,)
            ).fetchone():
                conn.execute(
                    "INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)",
                    (ct.card_id, ct.tag_id),
                )
                applied["card_tags_added"] += 1

        for l in payload.links_to_add:
            if conn.execute("SELECT 1 FROM cards WHERE id = ?", (l.source_id,)).fetchone() and conn.execute(
                "SELECT 1 FROM cards WHERE id = ?", (l.target_id,)
            ).fetchone():
                conn.execute(
                    """INSERT OR REPLACE INTO links (source_id, target_id, relation_type, status, reason)
                       VALUES (?, ?, ?, ?, ?)""",
                    (l.source_id, l.target_id, l.relation_type.value, l.status.value, l.reason),
                )
                applied["links_added"] += 1

        for bc in payload.board_cards_to_add:
            if conn.execute("SELECT 1 FROM boards WHERE id = ?", (bc.board_id,)).fetchone() and conn.execute(
                "SELECT 1 FROM cards WHERE id = ?", (bc.card_id,)
            ).fetchone():
                if bc.x is None or bc.y is None:
                    count = conn.execute(
                        "SELECT COUNT(*) AS n FROM board_cards WHERE board_id = ?", (bc.board_id,)
                    ).fetchone()["n"]
                    x = (count % 6) * 28.0 + 100.0
                    y = (count % 6) * 28.0 + 100.0
                else:
                    x, y = bc.x, bc.y
                conn.execute(
                    """INSERT OR IGNORE INTO board_cards (board_id, card_id, x, y, w, h, z)
                       VALUES (?, ?, ?, ?, ?, ?, 0)""",
                    (bc.board_id, bc.card_id, x, y, bc.w or DEFAULT_CARD_WIDTH, bc.h),
                )
                applied["board_cards_added"] += 1

    return {"applied": applied}
