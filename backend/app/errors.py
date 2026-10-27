from enum import Enum
from typing import Any, Optional


class ErrorCode(str, Enum):
    NOT_FOUND = "NOT_FOUND"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    NAME_CONFLICT = "NAME_CONFLICT"
    AXIS_MISMATCH = "AXIS_MISMATCH"
    CYCLE_DETECTED = "CYCLE_DETECTED"
    CARD_ALREADY_ON_BOARD = "CARD_ALREADY_ON_BOARD"
    STALE_VERSION = "STALE_VERSION"
    IN_USE = "IN_USE"
    MEDIA_TOO_LARGE = "MEDIA_TOO_LARGE"
    UNSUPPORTED_MEDIA = "UNSUPPORTED_MEDIA"
    MEDIA_FILE_MISSING = "MEDIA_FILE_MISSING"
    INTERNAL_ERROR = "INTERNAL_ERROR"


HTTP_STATUS = {
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.VALIDATION_ERROR: 422,
    ErrorCode.NAME_CONFLICT: 409,
    ErrorCode.AXIS_MISMATCH: 409,
    ErrorCode.CYCLE_DETECTED: 409,
    ErrorCode.CARD_ALREADY_ON_BOARD: 409,
    ErrorCode.STALE_VERSION: 409,
    ErrorCode.IN_USE: 409,
    ErrorCode.MEDIA_TOO_LARGE: 413,
    ErrorCode.UNSUPPORTED_MEDIA: 415,
    ErrorCode.MEDIA_FILE_MISSING: 404,
    ErrorCode.INTERNAL_ERROR: 500,
}


class AppError(Exception):
    def __init__(self, code: ErrorCode, message: str, details: Optional[dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    @property
    def status(self) -> int:
        return HTTP_STATUS[self.code]

    def to_body(self) -> dict[str, Any]:
        return {"error": {"code": self.code.value, "message": self.message, "details": self.details}}