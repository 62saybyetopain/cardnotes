import sqlite3
from typing import Any, Optional

from fastapi import APIRouter, Query, Request

from .db import descendant_ids, is_unique_violation, new_id, session, utc_now
from .errors import AppError, ErrorCode
from .schemas import Axis, TagAliasCreate, TagCreate, TagMergeRequest, TagPatch, TagResolveRequest

router = APIRouter(prefix="/api")

FLAT_AXES = {Axis.FREE.value, Axis.CONCEPT.value}


def _tag_dict(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    aliases = [
        r["alias"]
        for r in conn.execute(
            "SELECT alias FROM tag_aliases WHERE tag_id = ? ORDER BY alias", (row["id"],)
        ).fetchall()
    ]
    return {
        "id": row["id"],
        "name": row["name"],
        "axis": row["axis"],
        "facet": row["facet"],
        "definition": row["definition"] or "",
        "parent_id": row["parent_id"],
        "aliases": aliases,
    }


def _tag(conn: sqlite3.Connection, tag_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM tags WHERE id = ?", (tag_id,)).fetchone()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "標籤不存在", {"tag_id": tag_id})
    return row


def _sibling_conflict(
    conn: sqlite3.Connection,
    parent_id: Optional[str],
    axis: str,
    name: str,
    exclude_id: Optional[str],
    facet: Optional[str] = None,
) -> bool:
    if parent_id is None:
        row = conn.execute(
            "SELECT 1 FROM tags WHERE parent_id IS NULL AND axis = ? AND COALESCE(facet, '') = ? AND name = ? AND id IS NOT ?",
            (axis, facet or "", name, exclude_id),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT 1 FROM tags WHERE parent_id = ? AND name = ? AND id IS NOT ?",
            (parent_id, name, exclude_id),
        ).fetchone()
    return row is not None


def _name_conflict(name: str) -> AppError:
    return AppError(ErrorCode.NAME_CONFLICT, f"同一層已有名為「{name}」的標籤", {"names": [name]})


def _delete_plan(conn: sqlite3.Connection, tag: sqlite3.Row) -> dict[str, Any]:
    parent_id = tag["parent_id"]
    children = conn.execute("SELECT id, name FROM tags WHERE parent_id = ?", (tag["id"],)).fetchall()
    card_count = conn.execute(
        "SELECT COUNT(*) AS n FROM card_tags WHERE tag_id = ?", (tag["id"],)
    ).fetchone()["n"]
    new_parent = None
    if parent_id is not None:
        p = _tag(conn, parent_id)
        new_parent = {"id": p["id"], "name": p["name"]}
    conflicts = [
        c["name"]
        for c in children
        if _sibling_conflict(conn, parent_id, tag["axis"], c["name"], exclude_id=tag["id"])
    ]
    return {
        "child_count": len(children),
        "card_count": card_count,
        "new_parent": new_parent,
        "conflicts": conflicts,
    }


@router.get("/tags")
def list_tags(request: Request):
    with session(request, write=False) as conn:
        rows = conn.execute(
            "SELECT id, name, axis, facet, definition, parent_id FROM tags ORDER BY axis, name"
        ).fetchall()
        alias_rows = conn.execute("SELECT tag_id, alias FROM tag_aliases ORDER BY alias").fetchall()
        by_tag: dict[str, list[str]] = {}
        for r in alias_rows:
            by_tag.setdefault(r["tag_id"], []).append(r["alias"])
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
            for t in rows
        ]
        unclassified = conn.execute(
            """SELECT COUNT(*) AS n FROM cards c WHERE NOT EXISTS (
                   SELECT 1 FROM card_tags ct JOIN tags t ON t.id = ct.tag_id
                   WHERE ct.card_id = c.id AND t.axis IN ('location', 'domain'))"""
        ).fetchone()["n"]
        inbox_count = conn.execute(
            "SELECT COUNT(*) AS n FROM cards WHERE curation_status = 'inbox'"
        ).fetchone()["n"]
        return {"tags": tags, "unclassified_count": unclassified, "inbox_count": inbox_count}


@router.post("/tags", status_code=201)
def create_tag(payload: TagCreate, request: Request):
    axis_val = payload.axis.normalized()
    with session(request, write=True) as conn:
        if axis_val in FLAT_AXES and payload.parent_id is not None:
            raise AppError(ErrorCode.AXIS_MISMATCH, "概念或自由標籤不能有父節點")
        if payload.parent_id is not None:
            parent = _tag(conn, payload.parent_id)
            if parent["axis"] != axis_val:
                raise AppError(ErrorCode.AXIS_MISMATCH, "子節點的軸必須與父節點相同")
        if _sibling_conflict(conn, payload.parent_id, axis_val, payload.name, None, payload.facet):
            raise _name_conflict(payload.name)
        tid = new_id()
        try:
            conn.execute(
                "INSERT INTO tags (id, name, axis, facet, definition, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (tid, payload.name, axis_val, payload.facet, payload.definition.strip(), payload.parent_id, utc_now()),
            )
        except sqlite3.IntegrityError as e:
            if is_unique_violation(e):
                raise _name_conflict(payload.name) from e
            raise
        return _tag_dict(conn, _tag(conn, tid))


@router.patch("/tags/{tag_id}")
def patch_tag(tag_id: str, payload: TagPatch, request: Request):
    moving = "parent_id" in payload.model_fields_set
    updating_facet = "facet" in payload.model_fields_set
    updating_def = payload.definition is not None
    if payload.name is None and not moving and not updating_facet and not updating_def:
        raise AppError(ErrorCode.VALIDATION_ERROR, "至少要提供一個要修改的欄位")
    with session(request, write=True) as conn:
        tag = _tag(conn, tag_id)
        new_name = payload.name if payload.name is not None else tag["name"]
        new_parent = payload.parent_id if moving else tag["parent_id"]
        new_facet = payload.facet if updating_facet else tag["facet"]
        new_def = payload.definition.strip() if payload.definition is not None else (tag["definition"] or "")
        if moving and new_parent != tag["parent_id"] and new_parent is not None:
            parent = _tag(conn, new_parent)
            if tag["axis"] in FLAT_AXES or parent["axis"] != tag["axis"]:
                raise AppError(ErrorCode.AXIS_MISMATCH, "標籤不能移到不同軸或成為扁平標籤的子節點")
            if new_parent in descendant_ids(conn, tag_id):
                raise AppError(ErrorCode.CYCLE_DETECTED, "不能把標籤移到它自己或它的後代底下")
        if _sibling_conflict(conn, new_parent, tag["axis"], new_name, exclude_id=tag_id, facet=new_facet):
            raise _name_conflict(new_name)
        try:
            conn.execute(
                "UPDATE tags SET name = ?, facet = ?, definition = ?, parent_id = ? WHERE id = ?",
                (new_name, new_facet, new_def, new_parent, tag_id),
            )
        except sqlite3.IntegrityError as e:
            if is_unique_violation(e):
                raise _name_conflict(new_name) from e
            raise
        return _tag_dict(conn, _tag(conn, tag_id))


@router.post("/tags/{tag_id}/aliases", status_code=201)
def add_tag_alias(tag_id: str, payload: TagAliasCreate, request: Request):
    alias = payload.alias.strip()
    with session(request, write=True) as conn:
        tag = _tag(conn, tag_id)
        if tag["name"].lower() == alias.lower():
            raise AppError(ErrorCode.NAME_CONFLICT, "別名不能與標籤本身的正式名稱相同", {"names": [alias]})
        existing_alias = conn.execute(
            "SELECT tag_id FROM tag_aliases WHERE alias = ? COLLATE NOCASE", (alias,)
        ).fetchone()
        if existing_alias is not None:
            raise AppError(ErrorCode.NAME_CONFLICT, f"別名「{alias}」已被使用", {"names": [alias]})
        same_axis_tag = conn.execute(
            "SELECT id FROM tags WHERE axis = ? AND LOWER(name) = LOWER(?)", (tag["axis"], alias)
        ).fetchone()
        if same_axis_tag is not None:
            raise AppError(ErrorCode.NAME_CONFLICT, f"同軸已存在正式標籤「{alias}」，請使用合併功能", {"names": [alias]})
        conn.execute(
            "INSERT INTO tag_aliases (alias, tag_id, created_at) VALUES (?, ?, ?)",
            (alias, tag_id, utc_now()),
        )
        return _tag_dict(conn, tag)


@router.delete("/tags/{tag_id}/aliases/{alias}")
def remove_tag_alias(tag_id: str, alias: str, request: Request):
    with session(request, write=True) as conn:
        _tag(conn, tag_id)
        cur = conn.execute(
            "DELETE FROM tag_aliases WHERE tag_id = ? AND alias = ? COLLATE NOCASE", (tag_id, alias.strip())
        )
        if cur.rowcount == 0:
            raise AppError(ErrorCode.NOT_FOUND, "找不到此別名", {"alias": alias})
        return _tag_dict(conn, _tag(conn, tag_id))


@router.post("/tags/resolve")
def resolve_tag(payload: TagResolveRequest, request: Request):
    """四階段標籤輸入解析：1.正式名稱 -> 2.已登記別名 -> 3.相似或跨維度同名候選 -> 4.未找到。"""
    q = payload.query.strip()
    axis_filter = payload.axis.normalized() if payload.axis else None
    with session(request, write=False) as conn:
        sql = "SELECT * FROM tags WHERE LOWER(name) = LOWER(?)"
        params: list[Any] = [q]
        if axis_filter:
            sql += " AND axis = ?"
            params.append(axis_filter)
        exact_rows = conn.execute(sql, params).fetchall()
        if len(exact_rows) == 1:
            return {"status": "exact_tag", "tag": _tag_dict(conn, exact_rows[0]), "candidates": []}
        if len(exact_rows) > 1:
            return {
                "status": "ambiguous",
                "tag": None,
                "candidates": [_tag_dict(conn, r) for r in exact_rows],
            }

        alias_row = conn.execute(
            """SELECT t.* FROM tag_aliases a JOIN tags t ON t.id = a.tag_id
               WHERE a.alias = ? COLLATE NOCASE"""
            + (" AND t.axis = ?" if axis_filter else ""),
            ([q, axis_filter] if axis_filter else [q]),
        ).fetchall()
        if len(alias_row) == 1:
            return {
                "status": "exact_alias",
                "matched_alias": q,
                "tag": _tag_dict(conn, alias_row[0]),
                "candidates": [],
            }
        if len(alias_row) > 1:
            return {
                "status": "ambiguous",
                "tag": None,
                "candidates": [_tag_dict(conn, r) for r in alias_row],
            }

        esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pat = f"%{esc}%"
        sim_sql = """
            SELECT DISTINCT t.* FROM tags t
            LEFT JOIN tag_aliases a ON a.tag_id = t.id
            WHERE (t.name LIKE ? ESCAPE '\\' OR a.alias LIKE ? ESCAPE '\\')
        """
        sim_params: list[Any] = [pat, pat]
        if axis_filter:
            sim_sql += " AND t.axis = ?"
            sim_params.append(axis_filter)
        sim_sql += " ORDER BY t.name LIMIT 10"
        sim_rows = conn.execute(sim_sql, sim_params).fetchall()
        if sim_rows:
            return {
                "status": "similar",
                "tag": None,
                "candidates": [_tag_dict(conn, r) for r in sim_rows],
            }
        return {"status": "not_found", "tag": None, "candidates": []}


@router.post("/tags/{source_id}/merge")
def merge_tag(source_id: str, payload: TagMergeRequest, request: Request):
    """演進維護：將 source 標籤合併入 target，卡片歸屬轉移，舊名稱與別名保留為 target 的別名。"""
    target_id = payload.target_id
    if source_id == target_id:
        raise AppError(ErrorCode.VALIDATION_ERROR, "不能將標籤合併到自己")
    with session(request, write=True) as conn:
        source = _tag(conn, source_id)
        target = _tag(conn, target_id)
        if source["axis"] != target["axis"]:
            raise AppError(ErrorCode.AXIS_MISMATCH, "只能合併相同軸的標籤")
        if target_id in descendant_ids(conn, source_id):
            raise AppError(ErrorCode.CYCLE_DETECTED, "不能將父標籤合併到自己的後代底下")
        children = conn.execute("SELECT name FROM tags WHERE parent_id = ?", (source_id,)).fetchall()
        conflicts = [
            c["name"]
            for c in children
            if _sibling_conflict(conn, target_id, target["axis"], c["name"], exclude_id=source_id)
        ]
        if conflicts:
            raise AppError(
                ErrorCode.NAME_CONFLICT,
                "合併後子標籤會與目標底下的子標籤同名",
                {"names": conflicts},
            )
        conn.execute("UPDATE tags SET parent_id = ? WHERE parent_id = ?", (target_id, source_id))
        conn.execute(
            "INSERT OR IGNORE INTO card_tags (card_id, tag_id) SELECT card_id, ? FROM card_tags WHERE tag_id = ?",
            (target_id, source_id),
        )
        conn.execute("DELETE FROM card_tags WHERE tag_id = ?", (source_id,))
        conn.execute("UPDATE tag_aliases SET tag_id = ? WHERE tag_id = ?", (target_id, source_id))
        # @depends-on relations.py (relation_patterns.bridge_tag_id)：句型改指向合併後的標籤，否則刪除來源標籤會被外鍵擋下
        conn.execute("UPDATE relation_patterns SET bridge_tag_id = ? WHERE bridge_tag_id = ?", (target_id, source_id))
        if source["name"].lower() != target["name"].lower():
            conn.execute(
                "INSERT OR IGNORE INTO tag_aliases (alias, tag_id, created_at) VALUES (?, ?, ?)",
                (source["name"], target_id, utc_now()),
            )
        conn.execute("DELETE FROM tags WHERE id = ?", (source_id,))
        return _tag_dict(conn, _tag(conn, target_id))


@router.get("/tags/{tag_id}/delete-preview")
def delete_preview(tag_id: str, request: Request):
    with session(request, write=False) as conn:
        return _delete_plan(conn, _tag(conn, tag_id))


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: str, request: Request):
    with session(request, write=True) as conn:
        tag = _tag(conn, tag_id)
        # @depends-on relations.py (relation_patterns.bridge_tag_id)：被關係句型引用的橋樑詞不能直接刪除
        in_use = conn.execute(
            "SELECT COUNT(*) AS n FROM relation_patterns WHERE bridge_tag_id = ?", (tag_id,)
        ).fetchone()["n"]
        if in_use:
            raise AppError(
                ErrorCode.IN_USE,
                f"標籤「{tag['name']}」被 {in_use} 個關係句型引用，請先刪除這些句型，或改用合併功能",
                {"pattern_count": in_use},
            )
        plan = _delete_plan(conn, tag)
        if plan["conflicts"]:
            raise AppError(
                ErrorCode.NAME_CONFLICT,
                "子標籤上移後會與同層標籤同名，請先改名再刪除",
                {"names": plan["conflicts"]},
            )
        parent_id = tag["parent_id"]
        # 2. 子節點上移
        conn.execute("UPDATE tags SET parent_id = ? WHERE parent_id = ?", (parent_id, tag_id))
        # 3. 有父節點時，卡片改歸屬到父節點；最上層（或自由標籤）不補
        if parent_id is not None:
            conn.execute(
                "INSERT OR IGNORE INTO card_tags (card_id, tag_id) SELECT card_id, ? FROM card_tags WHERE tag_id = ?",
                (parent_id, tag_id),
            )
        # 4-5. 移除歸屬與標籤本身（任何一步失敗，整個交易回滾）
        conn.execute("DELETE FROM card_tags WHERE tag_id = ?", (tag_id,))
        conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
        return {"deleted": True, "reparented_children": plan["child_count"], "moved_cards": plan["card_count"] if parent_id else 0}


@router.put("/cards/{card_id}/tags/{tag_id}")
def assign_tag(card_id: str, tag_id: str, request: Request):
    with session(request, write=True) as conn:
        if conn.execute("SELECT 1 FROM cards WHERE id = ?", (card_id,)).fetchone() is None:
            raise AppError(ErrorCode.NOT_FOUND, "卡片不存在", {"card_id": card_id})
        _tag(conn, tag_id)
        cur = conn.execute("INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)", (card_id, tag_id))
        return {"existed": cur.rowcount == 0}


@router.delete("/cards/{card_id}/tags/{tag_id}")
def unassign_tag(card_id: str, tag_id: str, request: Request):
    with session(request, write=True) as conn:
        cur = conn.execute("DELETE FROM card_tags WHERE card_id = ? AND tag_id = ?", (card_id, tag_id))
        if cur.rowcount == 0:
            raise AppError(ErrorCode.NOT_FOUND, "這張卡片沒有這個標籤", {"card_id": card_id, "tag_id": tag_id})
        return {"removed": True}


@router.get("/graph/concepts")
def get_concept_graph(
    request: Request,
    min_cooccurrence: int = Query(1, ge=1, le=100),
    min_jaccard: float = Query(0.0, ge=0.0, le=1.0),
    max_neighbors: int = Query(8, ge=1, le=50),
    include_locations: bool = Query(False),
):
    """全域概念地圖：以標籤為節點，由卡片共現（Co-occurrence）自動計算探索網路，不寫入正式 links 表。"""
    axes = ("concept", "free", "location", "domain", "type") if include_locations else ("concept", "free")
    marks = ",".join("?" * len(axes))
    with session(request, write=False) as conn:
        tag_rows = conn.execute(
            f"""
            SELECT t.id, t.name, t.axis, t.facet, t.definition, t.parent_id,
                   COUNT(DISTINCT ct.card_id) AS card_count,
                   EXISTS (SELECT 1 FROM relation_patterns rp WHERE rp.bridge_tag_id = t.id) AS is_bridge
            FROM tags t
            LEFT JOIN card_tags ct ON ct.tag_id = t.id
            WHERE t.axis IN ({marks})
            GROUP BY t.id
            ORDER BY card_count DESC, t.name ASC
            """,
            axes,
        ).fetchall()

        alias_rows = conn.execute("SELECT tag_id, alias FROM tag_aliases ORDER BY alias").fetchall()
        by_tag: dict[str, list[str]] = {}
        for r in alias_rows:
            by_tag.setdefault(r["tag_id"], []).append(r["alias"])

        nodes = [
            {
                "id": r["id"],
                "name": r["name"],
                "axis": r["axis"],
                "facet": r["facet"],
                "definition": r["definition"] or "",
                "parent_id": r["parent_id"],
                "aliases": by_tag.get(r["id"], []),
                "card_count": r["card_count"],
                "is_bridge": bool(r["is_bridge"]),
            }
            for r in tag_rows
        ]
        count_map = {n["id"]: n["card_count"] for n in nodes}
        valid_ids = set(count_map.keys())

        pair_rows = conn.execute(
            """
            SELECT a.tag_id AS source_id, b.tag_id AS target_id, COUNT(DISTINCT a.card_id) AS co_count
            FROM card_tags a
            JOIN card_tags b ON a.card_id = b.card_id AND a.tag_id < b.tag_id
            GROUP BY a.tag_id, b.tag_id
            HAVING co_count >= ?
            ORDER BY co_count DESC
            """,
            (min_cooccurrence,),
        ).fetchall()

        candidates = []
        for r in pair_rows:
            src, dst, co = r["source_id"], r["target_id"], r["co_count"]
            if src not in valid_ids or dst not in valid_ids:
                continue
            union = count_map[src] + count_map[dst] - co
            jaccard = round(co / union, 4) if union > 0 else 0.0
            if jaccard < min_jaccard:
                continue
            candidates.append(
                {
                    "source_id": src,
                    "target_id": dst,
                    "co_count": co,
                    "jaccard": jaccard,
                }
            )

        # 依共現次數與關聯強度排序，限制每個節點最多保留 max_neighbors 條共現連線，避免樞紐標籤過度連線
        candidates.sort(key=lambda e: (e["co_count"], e["jaccard"]), reverse=True)
        degree: dict[str, int] = {}
        edges = []
        # 被上限擋下的連線不丟棄：前端在滑過／選取節點時才補畫，避免樞紐看起來只有 max_neighbors 個鄰居
        hidden_edges = []
        for e in candidates:
            u, v = e["source_id"], e["target_id"]
            if degree.get(u, 0) >= max_neighbors or degree.get(v, 0) >= max_neighbors:
                hidden_edges.append(e)
                continue
            degree[u] = degree.get(u, 0) + 1
            degree[v] = degree.get(v, 0) + 1
            edges.append(e)

        return {"nodes": nodes, "edges": edges, "hidden_edges": hidden_edges}
