"""ファイル監視 SSE ストリームと同期 API ルーター"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.backend.routers.projects import get_service as get_project_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["watch"])


def _get_watcher(request: Request):
    """app.state から FileWatcherService を取得する。"""
    watcher = getattr(request.app.state, "watcher", None)
    if watcher is None:
        raise HTTPException(status_code=503, detail="FileWatcherService が初期化されていません")
    return watcher


# ── SSE ストリーム ────────────────────────────────────────────────

@router.get("/projects/{project_id}/watch-events")
async def watch_events(project_id: str, request: Request):
    """ファイル変更イベントを SSE ストリームで配信する。"""
    svc = get_project_service()
    try:
        await svc.get_project(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")

    watcher = _get_watcher(request)

    async def event_generator():
        # このクライアント専用のキューを subscribe
        client_queue = watcher.subscribe()
        try:
            # 接続確立通知
            yield "data: {\"type\": \"connected\"}\n\n"

            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(client_queue.get(), timeout=30.0)
                    payload = json.dumps(event.model_dump(), ensure_ascii=False)
                    yield f"data: {payload}\n\n"
                    client_queue.task_done()
                except asyncio.TimeoutError:
                    # keepalive コメント
                    yield ": keepalive\n\n"
        finally:
            watcher.unsubscribe(client_queue)
            logger.debug("SSE クライアント切断: project_id=%s", project_id)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── ファイル同期 API ─────────────────────────────────────────────

@router.post("/projects/{project_id}/sync-files")
async def sync_files(project_id: str, request: Request) -> dict:
    """ディレクトリと登録済みエントリを照合して差分を同期する。"""
    svc = get_project_service()
    try:
        await svc.get_project(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")

    watcher = _get_watcher(request)
    result = await watcher.sync_files(project_id)

    # sync_complete イベントをブロードキャスト
    from app.backend.models import WatchEvent
    event = WatchEvent(
        type="sync_complete",
        project_id=project_id,
        added=result["added"],
        removed=result["removed"],
    )
    await watcher.broadcast_event(event)

    return result


# ── 監視開始 API ─────────────────────────────────────────────────

@router.post("/projects/{project_id}/start-watching")
async def start_watching(project_id: str, request: Request) -> dict:
    """指定プロジェクトのファイル監視を開始する。"""
    svc = get_project_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")

    watcher = _get_watcher(request)
    from app.backend.services.project_service import ProjectService
    project_dir = ProjectService._project_dir(project)
    await watcher.start_watching(project_id, project_dir)
    return {"status": "watching", "project_id": project_id}


@router.post("/projects/{project_id}/stop-watching")
async def stop_watching(project_id: str, request: Request) -> dict:
    """指定プロジェクトのファイル監視を停止する。"""
    svc = get_project_service()
    try:
        await svc.get_project(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")

    watcher = _get_watcher(request)
    await watcher.stop_watching(project_id)
    return {"status": "stopped", "project_id": project_id}
