"""FastAPI アプリケーション設定"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.backend.routers import llm, materials, projects, rules, sections, sources

logger = logging.getLogger(__name__)

_STATIC_DIR = Path(__file__).parent.parent / "static"
_TEMPLATE_DIR = Path(__file__).parent.parent / "templates"

app = FastAPI(title="Soki Editor API", version="0.1.0")

# ─── CORS（pywebview は null オリジンで送信）─────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null", "http://127.0.0.1", "http://localhost"],
    allow_origin_regex=r"http://(127\.0\.0\.1|localhost):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── 静的ファイル ─────────────────────────────────────────────
if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")

# ─── テンプレート ─────────────────────────────────────────────
templates = Jinja2Templates(directory=str(_TEMPLATE_DIR))


# ─── グローバルエラーハンドラ（RFC 7807）────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.error("未処理エラー: %s %s — %s", request.method, request.url, exc)
    return JSONResponse(
        status_code=500,
        content={"detail": f"内部エラーが発生しました: {type(exc).__name__}"},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )


# ─── ルーター登録 ─────────────────────────────────────────────
app.include_router(projects.router)
app.include_router(rules.router)
app.include_router(sources.router)
app.include_router(materials.router)
app.include_router(sections.router)
app.include_router(llm.router)


# ─── ローカルファイル配信 ─────────────────────────────────────
@app.get("/api/files")
async def serve_local_file(path: str, project_id: str) -> FileResponse:
    """data_dir 配下のファイルのみを配信する（ディレクトリトラバーサル防止）。"""
    from app.backend.routers.projects import get_service

    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")

    data_dir = Path(project.data_dir).resolve()
    requested = Path(path).resolve()

    if not str(requested).startswith(str(data_dir)):
        raise HTTPException(status_code=403, detail="アクセス禁止のパスです")

    if not requested.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    return FileResponse(str(requested))


# ─── 初期ページ配信 ───────────────────────────────────────────
@app.get("/")
async def index(request: Request):
    template_path = _TEMPLATE_DIR / "index.html"
    if template_path.exists():
        return templates.TemplateResponse("index.html", {"request": request})
    return JSONResponse({"message": "Soki Editor API is running"})
