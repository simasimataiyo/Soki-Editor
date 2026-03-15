"""FastAPI アプリケーション設定"""
from __future__ import annotations

import logging
import secrets as _secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.backend.routers import llm, materials, projects, rules, sections, settings, sources
import app.backend.security as _app_security

logger = logging.getLogger(__name__)

_STATIC_DIR = Path(__file__).parent.parent / "static"
_TEMPLATE_DIR = Path(__file__).parent.parent / "templates"


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # シャットダウン時にダーティなプロジェクトをすべて保存する
    logger.info("シャットダウン処理: ダーティプロジェクトを保存します...")
    svc = projects.get_service()
    await svc.flush_all_dirty()
    logger.info("シャットダウン保存完了")


app = FastAPI(title="Soki Editor API", version="0.1.0", lifespan=lifespan)

# ─── CORS（pywebview は null オリジンで送信）─────────────────
# 本番モードでは null オリジン（pywebview）のみ許可し、ブラウザからのアクセスを遮断する。
# 開発モードでは localhost/127.0.0.1 も許可してブラウザ直アクセスを可能にする。
_dev = _app_security.DEV_MODE
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null", "http://127.0.0.1", "http://localhost"] if _dev else ["null"],
    allow_origin_regex=r"http://(127\.0\.0\.1|localhost):\d+" if _dev else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── トークン認証ミドルウェア ──────────────────────────────────
@app.middleware("http")
async def token_auth_middleware(request: Request, call_next):
    """WebView 以外からの /api/* アクセスを 403 で拒否する。

    開発モード（DEV_MODE=True）または OPTIONS リクエストはスキップする。
    """
    if _app_security.DEV_MODE or request.method == "OPTIONS":
        return await call_next(request)
    if request.url.path.startswith("/api/"):
        token = request.headers.get("X-App-Token", "")
        if not token:
            token = request.query_params.get("app_token", "")
        if not _secrets.compare_digest(token, _app_security.APP_TOKEN):
            return JSONResponse(status_code=403, content={"detail": "Forbidden"})
    return await call_next(request)

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
app.include_router(settings.router)
app.include_router(projects.router)
app.include_router(rules.router)
app.include_router(sources.router)
app.include_router(materials.router)
app.include_router(sections.router)
app.include_router(llm.router)


# ─── ローカルファイル配信 ─────────────────────────────────────
@app.get("/api/files")
async def serve_local_file(path: str, project_id: str) -> FileResponse:
    """プロジェクトディレクトリ配下のファイルを配信する（ディレクトリトラバーサル防止）。"""
    from app.backend.routers.projects import get_service
    from app.backend.services.project_service import ProjectService

    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")

    requested = Path(path).resolve()

    # v3: project_dir 配下（sources/, materials/, metadata/ を含む）を許可
    project_dir = ProjectService._project_dir(project).resolve()
    def _is_relative_to(path: Path, base: Path) -> bool:
        try:
            path.relative_to(base)
            return True
        except Exception:
            return False
    allowed = _is_relative_to(requested, project_dir)

    if not allowed:
        raise HTTPException(status_code=403, detail="アクセス禁止のパスです")

    if not requested.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    return FileResponse(str(requested))


# ─── 初期ページ配信 ───────────────────────────────────────────
_CSP = (
    "default-src 'self'; "
    "connect-src 'self'; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data:; "
    "object-src 'none'; "
    "base-uri 'self'"
)


@app.get("/")
async def index_root():
    """ルートへの直アクセスは 404 にして推測を困難にする。"""
    raise HTTPException(status_code=404, detail="Not Found")


@app.get("/launch/{launch_token}")
async def index(request: Request, launch_token: str):
    """起動トークン付きURLのみアプリを配信する。トークン不一致は 404。"""
    if not _secrets.compare_digest(launch_token, _app_security.APP_TOKEN):
        raise HTTPException(status_code=404, detail="Not Found")
    template_path = _TEMPLATE_DIR / "index.html"
    if template_path.exists():
        response = templates.TemplateResponse(
            "index.html", {"request": request, "app_token": _app_security.APP_TOKEN}
        )
        response.headers["Content-Security-Policy"] = _CSP
        return response
    return JSONResponse({"message": "Soki Editor API is running"})
