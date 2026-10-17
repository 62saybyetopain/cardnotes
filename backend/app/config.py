import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    max_image_bytes: int = 25 * 1024 * 1024
    max_video_bytes: int = 500 * 1024 * 1024
    orphan_grace_seconds: int = 24 * 3600
    frontend_dist: Optional[Path] = None

    @property
    def db_path(self) -> Path:
        return self.data_dir / "cardboard.db"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"

    @staticmethod
    def from_env() -> "Settings":
        root = Path(__file__).resolve().parents[2]
        data_dir = Path(os.environ.get("CARDBOARD_DATA", root / "data")).resolve()
        dist = root / "frontend" / "dist"
        return Settings(data_dir=data_dir, frontend_dist=dist if dist.is_dir() else None)
