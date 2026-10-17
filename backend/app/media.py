import hashlib
import logging
import os
import re
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Request, Response, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError

from .db import new_id, session, utc_now
from .errors import AppError, ErrorCode

logger = logging.getLogger("cardboard.media")
router = APIRouter(prefix="/api")

CHUNK = 1024 * 1024
MEDIA_REF = re.compile(r"!\[[^\]]*\]\(media:([0-9a-fA-F-]{36})\)")

# kind, mime, 副檔名（由後端決定，與使用者輸入無關）
PNG = ("image", "image/png", ".png")
JPEG = ("image", "image/jpeg", ".jpg")
GIF = ("image", "image/gif", ".gif")
WEBP = ("image", "image/webp", ".webp")
MP4 = ("video", "video/mp4", ".mp4")
WEBM = ("video", "video/webm", ".webm")


def sniff(head: bytes) -> Optional[tuple[str, str, str]]:
    """以檔案內容判斷格式，不信任副檔名與 Content-Type。"""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return PNG
    if head.startswith(b"\xff\xd8\xff"):
        return JPEG
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return GIF
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return WEBP
    if head[4:8] == b"ftyp":
        return MP4
    if head.startswith(b"\x1a\x45\xdf\xa3") and b"webm" in head[:64]:
        return WEBM
    return None


def _safe_path(media_dir: Path, rel_path: str) -> Path:
    p = (media_dir / rel_path).resolve()
    if media_dir.resolve() not in p.parents:
        raise AppError(ErrorCode.INTERNAL_ERROR, "媒體路徑不合法")
    return p


@router.post("/media")
def upload_media(request: Request, response: Response, file: UploadFile = File(...)):
    settings = request.app.state.settings
    media_dir: Path = settings.media_dir
    tmp_dir = media_dir / ".tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = tmp_dir / f"{new_id()}.part"
    hard_limit = max(settings.max_image_bytes, settings.max_video_bytes)
    created_file: Optional[Path] = None
    try:
        sha, size, head = hashlib.sha256(), 0, b""
        with open(tmp_path, "wb") as out:
            while True:
                chunk = file.file.read(CHUNK)
                if not chunk:
                    break
                if not head:
                    head = chunk[:64]
                size += len(chunk)
                if size > hard_limit:
                    raise AppError(ErrorCode.MEDIA_TOO_LARGE, "檔案超過大小上限", {"limit": hard_limit})
                sha.update(chunk)
                out.write(chunk)
        if size == 0:
            raise AppError(ErrorCode.UNSUPPORTED_MEDIA, "檔案是空的")
        detected = sniff(head)
        if detected is None:
            raise AppError(ErrorCode.UNSUPPORTED_MEDIA, "不支援的檔案格式（依檔案內容判斷）")
        kind, mime, ext = detected
        limit = settings.max_image_bytes if kind == "image" else settings.max_video_bytes
        if size > limit:
            raise AppError(ErrorCode.MEDIA_TOO_LARGE, "檔案超過大小上限", {"limit": limit})
        width = height = None
        if kind == "image":
            try:
                with Image.open(tmp_path) as img:
                    img.verify()
                with Image.open(tmp_path) as img:
                    width, height = img.size
            except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as e:
                raise AppError(ErrorCode.UNSUPPORTED_MEDIA, "圖片檔案毀損或無法解碼") from e

        digest = sha.hexdigest()
        rel_path = f"{digest[:2]}/{digest}{ext}"
        final = _safe_path(media_dir, rel_path)
        with session(request, write=True) as conn:
            existing = conn.execute("SELECT * FROM media WHERE sha256 = ?", (digest,)).fetchone()
            if existing is not None:
                existing_path = _safe_path(media_dir, existing["rel_path"])
                if not existing_path.exists():
                    logger.warning("媒體 %s 有紀錄但檔案不存在，重新寫入", existing["id"])
                    existing_path.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(tmp_path, existing_path)
                response.status_code = 200
                result = {**_media_public(existing), "existed": True}
            else:
                final.parent.mkdir(parents=True, exist_ok=True)
                if not final.exists():
                    created_file = final
                os.replace(tmp_path, final)
                mid = new_id()
                conn.execute(
                    """INSERT INTO media (id, sha256, kind, mime, rel_path, byte_size, width, height, duration_ms, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)""",
                    (mid, digest, kind, mime, rel_path, size, width, height, utc_now()),
                )
                row = conn.execute("SELECT * FROM media WHERE id = ?", (mid,)).fetchone()
                response.status_code = 201
                result = {**_media_public(row), "existed": False}
        created_file = None  # 交易已提交，新檔案成為正式資料
        return result
    except BaseException:
        # 資料庫寫入失敗：只刪「本次新放的檔案」，絕不刪原本就存在的
        if created_file is not None and created_file.exists():
            created_file.unlink()
        raise
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def _media_public(row) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "mime": row["mime"],
        "byte_size": row["byte_size"],
        "width": row["width"],
        "height": row["height"],
    }


@router.get("/media/{media_id}/info")
def media_info(media_id: str, request: Request):
    with session(request, write=False) as conn:
        row = conn.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "媒體不存在", {"media_id": media_id})
    return _media_public(row)


@router.get("/media/{media_id}")
def get_media(media_id: str, request: Request):
    settings = request.app.state.settings
    with session(request, write=False) as conn:
        row = conn.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "媒體不存在", {"media_id": media_id})
    path = _safe_path(settings.media_dir, row["rel_path"])
    if not path.is_file():
        logger.error("媒體 %s 有資料庫紀錄但檔案不存在：%s", media_id, row["rel_path"])
        raise AppError(ErrorCode.MEDIA_FILE_MISSING, "媒體檔案遺失", {"media_id": media_id})
    return FileResponse(
        path,
        media_type=row["mime"],
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.post("/media/cleanup")
def cleanup_media(request: Request, dry_run: bool = True):
    settings = request.app.state.settings
    media_dir: Path = settings.media_dir
    cutoff_ts = time.time() - settings.orphan_grace_seconds
    with session(request, write=not dry_run) as conn:
        referenced: set[str] = set()
        for r in conn.execute("SELECT body FROM cards"):
            referenced.update(m.lower() for m in MEDIA_REF.findall(r["body"]))
        rows = conn.execute("SELECT * FROM media").fetchall()
        known_paths = {r["rel_path"] for r in rows}
        orphans = []
        for r in rows:
            if r["id"] in referenced:
                continue
            created_ts = _iso_to_ts(r["created_at"])
            if created_ts > cutoff_ts:
                continue
            orphans.append(r)
        stray = []
        if media_dir.is_dir():
            for p in media_dir.rglob("*"):
                if not p.is_file() or ".tmp" in p.relative_to(media_dir).parts:
                    continue
                rel = p.relative_to(media_dir).as_posix()
                if rel not in known_paths and p.stat().st_mtime <= cutoff_ts:
                    stray.append(rel)
        to_unlink = []
        if not dry_run:
            for r in orphans:
                conn.execute("DELETE FROM media WHERE id = ?", (r["id"],))
                to_unlink.append(_safe_path(media_dir, r["rel_path"]))
        result = {
            "dry_run": dry_run,
            "orphans": [{"id": r["id"], "rel_path": r["rel_path"], "byte_size": r["byte_size"]} for r in orphans],
            "stray_files": stray,  # 只列出，不刪
        }
    for p in to_unlink:  # 資料庫提交成功後才刪檔案
        try:
            p.unlink()
        except FileNotFoundError:
            logger.warning("清理時檔案已不存在：%s", p)
    return result


def _iso_to_ts(iso: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(iso).timestamp()
