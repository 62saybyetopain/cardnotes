import logging
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import boards, cards, links, media, relations, tags
from .config import Settings
from .db import init_db
from .errors import AppError, ErrorCode

logger = logging.getLogger("cardboard")


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    init_db(settings.db_path)

    app = FastAPI(title="Cardboard")
    app.state.settings = settings

    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError):
        return JSONResponse(exc.to_body(), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        err = AppError(
            ErrorCode.VALIDATION_ERROR,
            "請求格式錯誤",
            {"errors": [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]},
        )
        return JSONResponse(err.to_body(), status_code=err.status)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        logger.error("未預期錯誤 %s %s", request.method, request.url.path, exc_info=exc)
        err = AppError(ErrorCode.INTERNAL_ERROR, "伺服器內部錯誤")
        return JSONResponse(err.to_body(), status_code=err.status)

    for module in (cards, tags, links, boards, media, relations):
        app.include_router(module.router)

    if settings.frontend_dist is not None:
        app.mount("/", StaticFiles(directory=settings.frontend_dist, html=True), name="frontend")
    return app
