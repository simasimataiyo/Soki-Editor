"""LLM チャット・レビュー・エクスポート・プレビュー API"""
from __future__ import annotations

import json
from datetime import datetime
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse

from app.backend.models import ChatMessage, ChatRequest, ReviewRequest, SectionPreview
from app.backend.routers.projects import get_service
from app.backend.routers.settings import get_service as get_settings_service
from app.backend.services.export_service import ExportService
from app.backend.services.llm_service import LLMService

router = APIRouter(prefix="/api/projects/{project_id}", tags=["llm"])
_llm_service = LLMService()
_export_service = ExportService()


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

    global_settings = get_settings_service().get()

    async def _stream_with_history() -> AsyncGenerator[str, None]:
        # ユーザーメッセージ・コマンドをストリーム開始前に保存
        try:
            if body.command:
                # コマンド: user_message を command ロールで保存
                await svc.append_command_message(
                    project_id,
                    body.context_scope,
                    body.command,
                    body.command_args or [],
                    user_message=body.user_message,
                )
            else:
                # 通常チャット: ユーザーメッセージを先に保存
                await svc.append_chat_message(
                    project_id,
                    body.context_scope,
                    ChatMessage(
                        role="user",
                        content=body.user_message,
                        timestamp=datetime.now(),
                        explicit_refs=body.explicit_refs or [],
                    ),
                )
        except Exception:
            pass

        accumulated = []
        async for chunk in _llm_service.chat_stream(
            project,
            global_settings,
            body.user_message,
            body.context_scope,
            command=body.command,
            command_args=body.command_args if body.command_args else None,
            explicit_refs=body.explicit_refs if body.explicit_refs else None,
            selected_text=body.selected_text if body.selected_text else None,
        ):
            if chunk.startswith("data:"):
                try:
                    data = json.loads(chunk[5:].strip())
                    if data.get("type") == "chunk":
                        if not body.command or body.command.startswith("review"):
                            accumulated.append(data.get("text", ""))
                    elif data.get("type") == "done":
                        if (not body.command or body.command.startswith("review")) and accumulated:
                            # アシスタント応答を done yield 前に保存
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
            yield chunk

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
    history = project.chat_history
    return [m.model_dump() for m in history]


@router.delete("/chat-history/{scope}")
async def clear_chat_history(
    project_id: str, scope: str
) -> dict:
    """指定したスコープの履歴を削除"""
    svc = get_service()
    try:
        await svc.clear_chat_history(project_id, scope)
        return {"status": "ok"}
    except KeyError:
        _not_found(project_id)


@router.get("/chat-history/all-scopes")
async def get_all_scopes_history(project_id: str) -> dict:
    """全スコープの履歴を返す（履歴モーダル用）"""
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)
    return {
        "all": [m.model_dump() for m in project.chat_history]
    }


@router.post("/chat-history/add-message")
async def add_chat_message(project_id: str, body: dict) -> dict:
    """チャット履歴にメッセージを追加する（コマンド実行後の要約追加用）"""
    svc = get_service()
    try:
        scope = body.get("scope", "all")
        role = body.get("role", "assistant")
        content = body.get("content", "")
        await svc.append_chat_message(
            project_id,
            scope,
            ChatMessage(role=role, content=content, timestamp=datetime.now()),
        )
        return {"status": "ok"}
    except KeyError:
        _not_found(project_id)


@router.post("/chat-history/new-scope")
async def create_new_scope(project_id: str) -> dict:
    """新しいスコープを作成して返す（/clearコマンド用。互換性維持のため履歴をクリアしてallを返す）"""
    svc = get_service()
    try:
        await svc.clear_chat_history(project_id, "all")
        return {"status": "ok", "new_scope": "all"}
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
            get_settings_service().get(),
            body.system_prompt,
            body.context_scope,
            review_focus=body.command,
            explicit_refs=body.explicit_refs if body.explicit_refs else None,
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


# ─── 保存済みレビュープロンプト ─────────────────────────────────


@router.get("/saved-prompts")
async def list_saved_prompts(project_id: str) -> dict:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)
    return project.saved_review_prompts


@router.post("/saved-prompts/{name}")
async def save_prompt(project_id: str, name: str, body: dict) -> dict:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)
    project.saved_review_prompts[name] = body.get("prompt", "")
    svc._mark_dirty(project_id)
    return {"status": "ok"}


@router.delete("/saved-prompts/{name}")
async def delete_prompt(project_id: str, name: str) -> dict:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)
    project.saved_review_prompts.pop(name, None)
    svc._mark_dirty(project_id)
    return {"status": "ok"}
