"""LLM チャット・レビュー・エクスポート・プレビュー API"""
from __future__ import annotations

from datetime import datetime
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse

from app.backend.models import ChatMessage, ChatRequest, ReviewRequest, SectionPreview
from app.backend.routers.projects import get_service
from app.backend.services.export_service import ExportService
from app.backend.services.llm_service import LLMService
from app.backend.services.vector_store_service import VectorStoreService

router = APIRouter(prefix="/api/projects/{project_id}", tags=["llm"])
_llm_service = LLMService()
_export_service = ExportService()
_vs_service = VectorStoreService()


def _not_found(project_id: str):
    raise HTTPException(status_code=404, detail=f"プロジェクトが見つかりません: {project_id}")


# ─── チャット生成 SSE ─────────────────────────────────────────


@router.post("/chat")
async def chat_stream(project_id: str, body: ChatRequest) -> StreamingResponse:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    # ユーザーメッセージを履歴に追加
    await svc.append_chat_message(
        project_id,
        body.context_scope,
        ChatMessage(
            role="user",
            content=body.user_message,
            timestamp=datetime.now(),
        ),
    )

    async def _stream_with_history() -> AsyncGenerator[str, None]:
        accumulated = []
        async for chunk in _llm_service.chat_stream(
            project,
            body.user_message,
            body.context_scope,
            body.use_full_sources,
            _vs_service,
        ):
            yield chunk
            # chunk イベントを蓄積してアシスタントメッセージを記録
            import json as _json
            if chunk.startswith("data:"):
                try:
                    data = _json.loads(chunk[5:].strip())
                    if data.get("type") == "chunk":
                        accumulated.append(data.get("text", ""))
                    elif data.get("type") == "done" and accumulated:
                        await svc.append_chat_message(
                            project_id,
                            body.context_scope,
                            ChatMessage(
                                role="assistant",
                                content="".join(accumulated),
                                timestamp=datetime.now(),
                            ),
                        )
                except Exception:
                    pass

    return StreamingResponse(
        _stream_with_history(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ─── チャット履歴 ─────────────────────────────────────────────


@router.get("/chat-history")
async def get_chat_history(
    project_id: str, scope: str = "all"
) -> list[dict]:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)
    history = project.chat_history.get(scope, [])
    return [m.model_dump() for m in history]


@router.delete("/chat-history")
async def clear_chat_history(
    project_id: str, scope: str = "all"
) -> dict:
    svc = get_service()
    try:
        await svc.clear_chat_history(project_id, scope)
        return {"status": "ok"}
    except KeyError:
        _not_found(project_id)


# ─── レビュー SSE ─────────────────────────────────────────────


@router.post("/review")
async def review_stream(project_id: str, body: ReviewRequest) -> StreamingResponse:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    # レビュー用システムプロンプトをプロジェクトに保存
    project.review_system_prompt = body.system_prompt
    svc._mark_dirty(project_id)

    return StreamingResponse(
        _llm_service.review_stream(
            project,
            body.system_prompt,
            body.context_scope,
            body.use_full_sources,
            _vs_service,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ─── プレビュー API ─────────────────────────────────────────


@router.get("/preview", response_model=list[SectionPreview])
async def get_preview(project_id: str) -> list[SectionPreview]:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)
    return _export_service.get_preview_content(project)


# ─── Markdown エクスポート ─────────────────────────────────


@router.get("/export")
async def export_markdown(project_id: str) -> Response:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    md_content = _export_service.export_to_markdown(project)
    from urllib.parse import quote
    filename_encoded = quote(f"{project.name}.md", safe="")
    return Response(
        content=md_content.encode("utf-8"),
        media_type="text/markdown",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{filename_encoded}"
        },
    )
