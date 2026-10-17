from fastapi import APIRouter, Request

from .db import new_id, session, utc_now
from .errors import AppError, ErrorCode
from .schemas import (
    BoardCardAdd,
    BoardCardsPatch,
    BoardCreate,
    BoardGroupCreate,
    BoardGroupPatch,
    BoardPatch,
)

router = APIRouter(prefix="/api")

DEFAULT_CARD_WIDTH = 280.0


def _board(conn, board_id):
    row = conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "白板不存在", {"board_id": board_id})
    return row


@router.get("/boards")
def list_boards(request: Request):
    with session(request, write=False) as conn:
        rows = conn.execute(
            """SELECT b.id, b.name, COUNT(bc.card_id) AS card_count FROM boards b
               LEFT JOIN board_cards bc ON bc.board_id = b.id GROUP BY b.id ORDER BY b.name"""
        ).fetchall()
        return {"boards": [dict(r) for r in rows]}


@router.post("/boards", status_code=201)
def create_board(payload: BoardCreate, request: Request):
    with session(request, write=True) as conn:
        bid, now = new_id(), utc_now()
        conn.execute(
            "INSERT INTO boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (bid, payload.name, now, now),
        )
        return {"id": bid, "name": payload.name, "card_count": 0}


@router.patch("/boards/{board_id}")
def rename_board(board_id: str, payload: BoardPatch, request: Request):
    with session(request, write=True) as conn:
        _board(conn, board_id)
        conn.execute("UPDATE boards SET name = ?, updated_at = ? WHERE id = ?", (payload.name, utc_now(), board_id))
        return {"id": board_id, "name": payload.name}


@router.delete("/boards/{board_id}")
def delete_board(board_id: str, request: Request):
    with session(request, write=True) as conn:
        _board(conn, board_id)
        conn.execute("DELETE FROM boards WHERE id = ?", (board_id,))  # 只連鎖刪 board_cards，不動卡片
        return {"deleted": True}


@router.get("/boards/{board_id}")
def get_board(board_id: str, request: Request):
    with session(request, write=False) as conn:
        board = _board(conn, board_id)
        cards = conn.execute(
            """SELECT bc.card_id, bc.x, bc.y, bc.w, bc.h, bc.z, c.title, c.body, c.card_type, c.curation_status, c.updated_at
               FROM board_cards bc JOIN cards c ON c.id = bc.card_id
               WHERE bc.board_id = ? ORDER BY bc.rowid""",
            (board_id,),
        ).fetchall()
        link_rows = conn.execute(
            """SELECT l.source_id, l.target_id, l.relation_type, l.status, l.reason
               FROM links l
               JOIN board_cards a ON a.card_id = l.source_id AND a.board_id = ?
               JOIN board_cards b ON b.card_id = l.target_id AND b.board_id = ?""",
            (board_id, board_id),
        ).fetchall()
        links = [
            {
                "source_id": r["source_id"],
                "target_id": r["target_id"],
                "card_a": r["source_id"],
                "card_b": r["target_id"],
                "relation_type": r["relation_type"],
                "status": r["status"],
                "reason": r["reason"] or "",
            }
            for r in link_rows
        ]
        groups = conn.execute(
            """SELECT id, board_id, label, x, y, w, h, color, created_at
               FROM board_groups WHERE board_id = ? ORDER BY created_at""",
            (board_id,),
        ).fetchall()
        return {
            "id": board["id"],
            "name": board["name"],
            "cards": [dict(r) for r in cards],
            "links": links,
            "groups": [dict(g) for g in groups],
        }


@router.post("/boards/{board_id}/cards", status_code=201)
def add_card_to_board(board_id: str, payload: BoardCardAdd, request: Request):
    with session(request, write=True) as conn:
        _board(conn, board_id)
        if conn.execute("SELECT 1 FROM cards WHERE id = ?", (payload.card_id,)).fetchone() is None:
            raise AppError(ErrorCode.NOT_FOUND, "卡片不存在", {"card_id": payload.card_id})
        if conn.execute(
            "SELECT 1 FROM board_cards WHERE board_id = ? AND card_id = ?", (board_id, payload.card_id)
        ).fetchone():
            raise AppError(ErrorCode.CARD_ALREADY_ON_BOARD, "這張卡片已經在這塊白板上", {"card_id": payload.card_id})
        w = payload.w if payload.w is not None else DEFAULT_CARD_WIDTH
        conn.execute(
            "INSERT INTO board_cards (board_id, card_id, x, y, w, h, z) VALUES (?, ?, ?, ?, ?, ?, 0)",
            (board_id, payload.card_id, payload.x, payload.y, w, payload.h),
        )
        conn.execute("UPDATE boards SET updated_at = ? WHERE id = ?", (utc_now(), board_id))
        return {"card_id": payload.card_id, "x": payload.x, "y": payload.y, "w": w, "h": payload.h, "z": 0}


@router.patch("/boards/{board_id}/cards")
def patch_board_cards(board_id: str, payload: BoardCardsPatch, request: Request):
    with session(request, write=True) as conn:
        _board(conn, board_id)
        for item in payload.items:
            cur = conn.execute(
                "UPDATE board_cards SET x = ?, y = ?, w = COALESCE(?, w), h = COALESCE(?, h) "
                "WHERE board_id = ? AND card_id = ?",
                (item.x, item.y, item.w, item.h, board_id, item.card_id),
            )
            if cur.rowcount == 0:  # 任何一張不在白板上，整批回滾，不做部分更新
                raise AppError(ErrorCode.NOT_FOUND, "卡片不在這塊白板上", {"card_id": item.card_id})
        conn.execute("UPDATE boards SET updated_at = ? WHERE id = ?", (utc_now(), board_id))
        return {"updated": len(payload.items)}


@router.delete("/boards/{board_id}/cards/{card_id}")
def remove_card_from_board(board_id: str, card_id: str, request: Request):
    with session(request, write=True) as conn:
        _board(conn, board_id)
        cur = conn.execute("DELETE FROM board_cards WHERE board_id = ? AND card_id = ?", (board_id, card_id))
        if cur.rowcount == 0:
            raise AppError(ErrorCode.NOT_FOUND, "卡片不在這塊白板上", {"card_id": card_id})
        return {"removed": True}


@router.post("/boards/{board_id}/groups", status_code=201)
def create_board_group(board_id: str, payload: BoardGroupCreate, request: Request):
    with session(request, write=True) as conn:
        _board(conn, board_id)
        gid, now = new_id(), utc_now()
        conn.execute(
            """INSERT INTO board_groups (id, board_id, label, x, y, w, h, color, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (gid, board_id, payload.label.strip(), payload.x, payload.y, payload.w, payload.h, payload.color, now),
        )
        conn.execute("UPDATE boards SET updated_at = ? WHERE id = ?", (now, board_id))
        row = conn.execute("SELECT * FROM board_groups WHERE id = ?", (gid,)).fetchone()
        return dict(row)


@router.patch("/boards/{board_id}/groups/{group_id}")
def patch_board_group(board_id: str, group_id: str, payload: BoardGroupPatch, request: Request):
    with session(request, write=True) as conn:
        _board(conn, board_id)
        row = conn.execute(
            "SELECT * FROM board_groups WHERE id = ? AND board_id = ?", (group_id, board_id)
        ).fetchone()
        if row is None:
            raise AppError(ErrorCode.NOT_FOUND, "分組框不存在", {"group_id": group_id})
        label = payload.label.strip() if payload.label is not None else row["label"]
        x = payload.x if payload.x is not None else row["x"]
        y = payload.y if payload.y is not None else row["y"]
        w = payload.w if payload.w is not None else row["w"]
        h = payload.h if payload.h is not None else row["h"]
        color = payload.color if payload.color is not None else row["color"]
        conn.execute(
            "UPDATE board_groups SET label = ?, x = ?, y = ?, w = ?, h = ?, color = ? WHERE id = ?",
            (label, x, y, w, h, color, group_id),
        )
        conn.execute("UPDATE boards SET updated_at = ? WHERE id = ?", (utc_now(), board_id))
        updated = conn.execute("SELECT * FROM board_groups WHERE id = ?", (group_id,)).fetchone()
        return dict(updated)


@router.delete("/boards/{board_id}/groups/{group_id}")
def delete_board_group(board_id: str, group_id: str, request: Request):
    with session(request, write=True) as conn:
        _board(conn, board_id)
        cur = conn.execute("DELETE FROM board_groups WHERE id = ? AND board_id = ?", (group_id, board_id))
        if cur.rowcount == 0:
            raise AppError(ErrorCode.NOT_FOUND, "分組框不存在", {"group_id": group_id})
        conn.execute("UPDATE boards SET updated_at = ? WHERE id = ?", (utc_now(), board_id))
        return {"deleted": True}
