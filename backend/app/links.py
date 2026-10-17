from typing import Optional

from fastapi import APIRouter, Request

from .db import session, utc_now
from .errors import AppError, ErrorCode
from .schemas import LinkPatch, LinkPut, RelationType

router = APIRouter(prefix="/api")


def _link_dict(row) -> dict:
    return {
        "source_id": row["source_id"],
        "target_id": row["target_id"],
        "card_a": row["source_id"],
        "card_b": row["target_id"],
        "relation_type": row["relation_type"],
        "status": row["status"],
        "reason": row["reason"] or "",
        "created_at": row["created_at"],
    }


@router.put("/links")
def put_link(payload: LinkPut, request: Request):
    src = payload.source_id or payload.card_id
    dst = payload.target_id or payload.other_id
    if not src or not dst:
        raise AppError(ErrorCode.VALIDATION_ERROR, "必須提供 source_id 與 target_id")
    if src == dst:
        raise AppError(ErrorCode.VALIDATION_ERROR, "不能把卡片連結到自己")
    rel = payload.relation_type.value
    status = payload.status.value
    reason = payload.reason.strip()
    with session(request, write=True) as conn:
        for cid in (src, dst):
            if conn.execute("SELECT 1 FROM cards WHERE id = ?", (cid,)).fetchone() is None:
                raise AppError(ErrorCode.NOT_FOUND, "卡片不存在", {"card_id": cid})
        existing = conn.execute(
            "SELECT * FROM links WHERE source_id = ? AND target_id = ? AND relation_type = ?",
            (src, dst, rel),
        ).fetchone()
        if existing is not None:
            new_status = status if "status" in payload.model_fields_set else existing["status"]
            new_reason = reason if "reason" in payload.model_fields_set else existing["reason"]
            conn.execute(
                "UPDATE links SET status = ?, reason = ? WHERE source_id = ? AND target_id = ? AND relation_type = ?",
                (new_status, new_reason, src, dst, rel),
            )
            row = conn.execute(
                "SELECT * FROM links WHERE source_id = ? AND target_id = ? AND relation_type = ?",
                (src, dst, rel),
            ).fetchone()
            return {**_link_dict(row), "existed": True}
        conn.execute(
            """INSERT INTO links (source_id, target_id, relation_type, status, reason, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (src, dst, rel, status, reason, utc_now()),
        )
        row = conn.execute(
            "SELECT * FROM links WHERE source_id = ? AND target_id = ? AND relation_type = ?",
            (src, dst, rel),
        ).fetchone()
        return {**_link_dict(row), "existed": False}


@router.patch("/links/{source_id}/{target_id}")
def patch_link(source_id: str, target_id: str, payload: LinkPatch, request: Request):
    if payload.relation_type is None and payload.status is None and payload.reason is None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "至少要提供一個要更新的欄位")
    with session(request, write=True) as conn:
        if payload.old_relation_type is not None:
            row = conn.execute(
                "SELECT * FROM links WHERE source_id = ? AND target_id = ? AND relation_type = ?",
                (source_id, target_id, payload.old_relation_type.value),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM links WHERE source_id = ? AND target_id = ? ORDER BY created_at LIMIT 1",
                (source_id, target_id),
            ).fetchone()
        if row is None:
            raise AppError(ErrorCode.NOT_FOUND, "連結不存在", {"source_id": source_id, "target_id": target_id})
        old_rel = row["relation_type"]
        new_rel = payload.relation_type.value if payload.relation_type is not None else old_rel
        new_status = payload.status.value if payload.status is not None else row["status"]
        new_reason = payload.reason.strip() if payload.reason is not None else row["reason"]
        if new_rel != old_rel:
            dup = conn.execute(
                "SELECT 1 FROM links WHERE source_id = ? AND target_id = ? AND relation_type = ?",
                (source_id, target_id, new_rel),
            ).fetchone()
            if dup is not None:
                raise AppError(ErrorCode.NAME_CONFLICT, "該關係類型的連結已存在", {"relation_type": new_rel})
        conn.execute(
            """UPDATE links SET relation_type = ?, status = ?, reason = ?
               WHERE source_id = ? AND target_id = ? AND relation_type = ?""",
            (new_rel, new_status, new_reason, source_id, target_id, old_rel),
        )
        updated = conn.execute(
            "SELECT * FROM links WHERE source_id = ? AND target_id = ? AND relation_type = ?",
            (source_id, target_id, new_rel),
        ).fetchone()
        return _link_dict(updated)


@router.delete("/links/{source_id}/{target_id}")
def delete_link(
    source_id: str,
    target_id: str,
    request: Request,
    relation_type: Optional[RelationType] = None,
):
    with session(request, write=True) as conn:
        if relation_type is not None:
            cur = conn.execute(
                "DELETE FROM links WHERE source_id = ? AND target_id = ? AND relation_type = ?",
                (source_id, target_id, relation_type.value),
            )
        else:
            cur = conn.execute(
                "DELETE FROM links WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)",
                (source_id, target_id, target_id, source_id),
            )
        if cur.rowcount == 0:
            raise AppError(ErrorCode.NOT_FOUND, "連結不存在", {"source_id": source_id, "target_id": target_id})
        return {"deleted": True}
