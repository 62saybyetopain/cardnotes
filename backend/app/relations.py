# @depends-on .schemas (CardRelationPut, RelationPatternCreate, RelationPatternPatch；欄位與前端 types.ts 同名)
# @depends-on .tags (FLAT_AXES)
# @depends-on .db (RELATION_TABLES_DDL 建立的 relation_patterns／card_relations，與 schema.sql 同文)
# @depends-on .errors (ErrorCode.IN_USE)
# @depends-on .schemas (CardRelationPut, PatternFamily, RelationPatternCreate, RelationPatternPatch；欄位與前端 types.ts 同名，family 值與前端 PatternFamily 一致)
# @depends-on tags.py 的 merge_tag／delete_tag（對 relation_patterns.bridge_tag_id 的改指與守衛）
import re
import sqlite3
from typing import Any, Optional

from fastapi import APIRouter, Request

from .db import is_unique_violation, new_id, session, utc_now
from .errors import AppError, ErrorCode
from .schemas import Axis, CardRelationPut, RelationPatternCreate, RelationPatternPatch
from .tags import FLAT_AXES

router = APIRouter(prefix="/api")

LOCATION_AXES = (Axis.LOCATION.value, Axis.DOMAIN.value)
PLACEHOLDERS = {"A", "B", "結果"}
_PLACEHOLDER_RE = re.compile(r"\{([^{}]*)\}")

_PATTERN_SELECT = """
    SELECT rp.id, rp.label, rp.template, rp.bridge_tag_id, rp.note, rp.family, t.name AS bridge_name,
           (SELECT COUNT(*) FROM card_relations cr WHERE cr.pattern_id = rp.id) AS use_count
    FROM relation_patterns rp JOIN tags t ON t.id = rp.bridge_tag_id
"""


def _label_conflict(label: str) -> AppError:
    return AppError(ErrorCode.NAME_CONFLICT, f"已有名為「{label}」的關係句型", {"names": [label]})


def _check_template(template: str) -> str:
    text = template.strip()
    found = _PLACEHOLDER_RE.findall(text)
    unknown = sorted({p for p in found if p not in PLACEHOLDERS})
    if not found or unknown:
        raise AppError(
            ErrorCode.VALIDATION_ERROR,
            "句型模板至少要有一個佔位符，且只能使用 {A}、{B}、{結果}",
            {"unknown": unknown},
        )
    return text


def _pattern(conn: sqlite3.Connection, pattern_id: str) -> dict[str, Any]:
    row = conn.execute(_PATTERN_SELECT + " WHERE rp.id = ?", (pattern_id,)).fetchone()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "關係句型不存在", {"pattern_id": pattern_id})
    return dict(row)


def _require_card(conn: sqlite3.Connection, card_id: str) -> None:
    if conn.execute("SELECT 1 FROM cards WHERE id = ?", (card_id,)).fetchone() is None:
        raise AppError(ErrorCode.NOT_FOUND, "卡片不存在", {"card_id": card_id})


def _relation(conn: sqlite3.Connection, card_id: str) -> Optional[dict[str, Any]]:
    row = conn.execute(
        """SELECT card_id, pattern_id, role_a, role_b, result, free_sentence, updated_at
           FROM card_relations WHERE card_id = ?""",
        (card_id,),
    ).fetchone()
    return dict(row) if row is not None else None


@router.get("/relation-patterns")
def list_patterns(request: Request):
    with session(request, write=False) as conn:
        rows = conn.execute(_PATTERN_SELECT + " ORDER BY rp.label").fetchall()
        return {"patterns": [dict(r) for r in rows]}


@router.post("/relation-patterns", status_code=201)
def create_pattern(payload: RelationPatternCreate, request: Request):
    template = _check_template(payload.template)
    with session(request, write=True) as conn:
        tag = conn.execute("SELECT axis FROM tags WHERE id = ?", (payload.bridge_tag_id,)).fetchone()
        if tag is None:
            raise AppError(ErrorCode.NOT_FOUND, "橋樑詞標籤不存在", {"tag_id": payload.bridge_tag_id})
        if tag["axis"] not in FLAT_AXES:
            raise AppError(ErrorCode.AXIS_MISMATCH, "橋樑詞必須是概念標籤")
        pid = new_id()
        try:
            conn.execute(
                """INSERT INTO relation_patterns (id, label, template, bridge_tag_id, note, family, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    pid,
                    payload.label,
                    template,
                    payload.bridge_tag_id,
                    payload.note.strip(),
                    payload.family.value if payload.family is not None else None,
                    utc_now(),
                ),
            )
        except sqlite3.IntegrityError as e:
            if is_unique_violation(e):
                raise _label_conflict(payload.label) from e
            raise
        return _pattern(conn, pid)


@router.patch("/relation-patterns/{pattern_id}")
def patch_pattern(pattern_id: str, payload: RelationPatternPatch, request: Request):
    if (
        payload.label is None
        and payload.template is None
        and payload.note is None
        and payload.family is None
    ):
        raise AppError(ErrorCode.VALIDATION_ERROR, "至少要提供一個要修改的欄位")
    template = _check_template(payload.template) if payload.template is not None else None
    with session(request, write=True) as conn:
        cur = _pattern(conn, pattern_id)
        label = payload.label if payload.label is not None else cur["label"]
        note = payload.note.strip() if payload.note is not None else cur["note"]
        family = payload.family.value if payload.family is not None else cur["family"]
        try:
            conn.execute(
                "UPDATE relation_patterns SET label = ?, template = ?, note = ?, family = ? WHERE id = ?",
                (label, template if template is not None else cur["template"], note, family, pattern_id),
            )
        except sqlite3.IntegrityError as e:
            if is_unique_violation(e):
                raise _label_conflict(label) from e
            raise
        return _pattern(conn, pattern_id)


@router.delete("/relation-patterns/{pattern_id}")
def delete_pattern(pattern_id: str, request: Request):
    with session(request, write=True) as conn:
        cur = _pattern(conn, pattern_id)
        if cur["use_count"]:
            raise AppError(
                ErrorCode.IN_USE,
                f"仍有 {cur['use_count']} 張卡片的紀錄使用這個句型，不能刪除",
                {"use_count": cur["use_count"]},
            )
        conn.execute("DELETE FROM relation_patterns WHERE id = ?", (pattern_id,))
        return {"deleted": True}


@router.get("/cards/{card_id}/relation")
def get_card_relation(card_id: str, request: Request):
    with session(request, write=False) as conn:
        _require_card(conn, card_id)
        return {"relation": _relation(conn, card_id)}


@router.put("/cards/{card_id}/relation")
def put_card_relation(card_id: str, payload: CardRelationPut, request: Request):
    free = payload.free_sentence.strip()
    if payload.pattern_id is not None and free:
        raise AppError(ErrorCode.VALIDATION_ERROR, "已選句型時，自由關係句必須留空")
    if payload.pattern_id is None and not free:
        raise AppError(ErrorCode.VALIDATION_ERROR, "未選句型時，必須填寫自由關係句（進入候選池）")
    with session(request, write=True) as conn:
        _require_card(conn, card_id)
        if payload.pattern_id is not None:
            _pattern(conn, payload.pattern_id)  # 句型不存在時丟 NOT_FOUND
        conn.execute(
            """INSERT INTO card_relations (card_id, pattern_id, role_a, role_b, result, free_sentence, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(card_id) DO UPDATE SET
                   pattern_id = excluded.pattern_id, role_a = excluded.role_a, role_b = excluded.role_b,
                   result = excluded.result, free_sentence = excluded.free_sentence,
                   updated_at = excluded.updated_at""",
            (
                card_id,
                payload.pattern_id,
                payload.role_a.strip(),
                payload.role_b.strip(),
                payload.result.strip(),
                free,
                utc_now(),
            ),
        )
        return {"relation": _relation(conn, card_id)}


@router.delete("/cards/{card_id}/relation")
def delete_card_relation(card_id: str, request: Request):
    with session(request, write=True) as conn:
        _require_card(conn, card_id)
        cur = conn.execute("DELETE FROM card_relations WHERE card_id = ?", (card_id,))
        if cur.rowcount == 0:
            raise AppError(ErrorCode.NOT_FOUND, "這張卡片沒有關係句紀錄", {"card_id": card_id})
        return {"removed": True}


@router.get("/relations/report")
def relations_report(request: Request):
    """唯讀評估報告：橋樑詞分布、紀錄與標籤不一致、候選池。不寫入任何資料。
    cabinet_count 是涉及的最上層收納位置（櫃子）數，只是領域數的上界，是否真的跨領域由人判斷。"""
    with session(request, write=False) as conn:
        total_cards = conn.execute("SELECT COUNT(*) AS n FROM cards").fetchone()["n"]
        bridge_rows = conn.execute(
            """SELECT t.id, t.name, COUNT(DISTINCT ct.card_id) AS card_count
               FROM tags t LEFT JOIN card_tags ct ON ct.tag_id = t.id
               WHERE t.id IN (SELECT bridge_tag_id FROM relation_patterns)
               GROUP BY t.id ORDER BY card_count DESC, t.name"""
        ).fetchall()
        # 卡片只掛在最細的那一格，所以從最上層往下展開，把每個位置對應到它的櫃子
        cabinet_rows = conn.execute(
            """WITH RECURSIVE up(tag_id, root_id) AS (
                   SELECT id, id FROM tags WHERE axis IN (?, ?) AND parent_id IS NULL
                   UNION
                   SELECT t.id, up.root_id FROM tags t JOIN up ON t.parent_id = up.tag_id
               )
               SELECT bct.tag_id AS bridge_id, up.root_id AS cabinet_id, r.name AS cabinet_name,
                      COUNT(DISTINCT bct.card_id) AS card_count
               FROM card_tags bct
               JOIN card_tags lct ON lct.card_id = bct.card_id
               JOIN up ON up.tag_id = lct.tag_id
               JOIN tags r ON r.id = up.root_id
               WHERE bct.tag_id IN (SELECT bridge_tag_id FROM relation_patterns)
               GROUP BY bct.tag_id, up.root_id
               ORDER BY card_count DESC, cabinet_name""",
            LOCATION_AXES,
        ).fetchall()
        unfiled_rows = conn.execute(
            """SELECT bct.tag_id AS bridge_id, COUNT(DISTINCT bct.card_id) AS n
               FROM card_tags bct
               WHERE bct.tag_id IN (SELECT bridge_tag_id FROM relation_patterns)
                 AND NOT EXISTS (
                     SELECT 1 FROM card_tags lct JOIN tags lt ON lt.id = lct.tag_id
                     WHERE lct.card_id = bct.card_id AND lt.axis IN (?, ?))
               GROUP BY bct.tag_id""",
            LOCATION_AXES,
        ).fetchall()
        inconsistencies = conn.execute(
            """SELECT cr.card_id, c.title, rp.id AS pattern_id, rp.label AS pattern_label,
                      rp.bridge_tag_id, t.name AS bridge_name
               FROM card_relations cr
               JOIN cards c ON c.id = cr.card_id
               JOIN relation_patterns rp ON rp.id = cr.pattern_id
               JOIN tags t ON t.id = rp.bridge_tag_id
               WHERE NOT EXISTS (
                   SELECT 1 FROM card_tags ct WHERE ct.card_id = cr.card_id AND ct.tag_id = rp.bridge_tag_id)
               ORDER BY c.title"""
        ).fetchall()
        candidates = conn.execute(
            """SELECT cr.card_id, c.title, cr.free_sentence, cr.updated_at
               FROM card_relations cr JOIN cards c ON c.id = cr.card_id
               WHERE cr.pattern_id IS NULL ORDER BY cr.updated_at DESC"""
        ).fetchall()

        cabinets: dict[str, list[dict[str, Any]]] = {}
        for r in cabinet_rows:
            cabinets.setdefault(r["bridge_id"], []).append(
                {"id": r["cabinet_id"], "name": r["cabinet_name"], "card_count": r["card_count"]}
            )
        unfiled = {r["bridge_id"]: r["n"] for r in unfiled_rows}
        bridges = [
            {
                "id": b["id"],
                "name": b["name"],
                "card_count": b["card_count"],
                "card_ratio": round(b["card_count"] / total_cards, 4) if total_cards else 0.0,
                "unfiled_count": unfiled.get(b["id"], 0),
                "cabinet_count": len(cabinets.get(b["id"], [])),
                "cabinets": cabinets.get(b["id"], []),
            }
            for b in bridge_rows
        ]
        return {
            "total_cards": total_cards,
            "bridges": bridges,
            "inconsistencies": [dict(r) for r in inconsistencies],
            "candidates": [dict(r) for r in candidates],
        }