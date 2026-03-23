"""ToolExecutor — LLM ツールコールの実行と ProjectService への反映"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from app.backend.models import LLMSettings, Project

logger = logging.getLogger(__name__)


@dataclass
class ToolResult:
    """ツール実行結果"""
    tool_call_id: str
    tool_name: str
    content: str                    # LLM に返すメッセージ（tool ロール用）
    sse_events: list[dict] = field(default_factory=list)  # フロントエンドに送る SSE イベント群
    is_backend_only: bool = False   # True = fetch_sources 等バックエンド解決型


class ToolExecutor:
    """ツールコールの実行と ProjectService への反映を担う"""

    def __init__(
        self,
        project_service,
        project_id: str,
        project: Project,
        settings: LLMSettings,
    ):
        self._svc = project_service
        self._project_id = project_id
        self._project = project
        self._settings = settings
        self._handlers = {
            "fetch_sources": self._handle_fetch_sources,
            "fetch_sections": self._handle_fetch_sections,
            "update_section": self._handle_update_section,
            "update_multiple_sections": self._handle_update_multiple_sections,
            "create_section": self._handle_create_section,
            "delete_section": self._handle_delete_section,
            "set_document_structure": self._handle_set_document_structure,
            "create_document_structure": self._handle_create_document_structure,
            "create_sections_under_parent": self._handle_create_sections_under_parent,
            "update_section_summary": self._handle_update_section_summary,
            "update_section_title": self._handle_update_section_title,
            "move_section": self._handle_move_section,
        }

    async def execute(self, tool_call: dict) -> ToolResult:
        """tool_call を受け取り、実行結果を返す"""
        name = tool_call["tool"]
        args = tool_call["args"]
        tc_id = tool_call["id"]
        handler = self._handlers.get(name)
        if handler is None:
            return ToolResult(tc_id, name, f"未知のツール: {name}")
        return await handler(tc_id, args)

    async def get_latest_project(self) -> Project:
        """最新のプロジェクト状態を取得する（コンテキスト再注入用）"""
        self._project = await self._svc.get_project(self._project_id)
        return self._project

    # ------------------------------------------------------------------
    # バックエンド解決型ハンドラ（is_backend_only=True）
    # ------------------------------------------------------------------

    async def _handle_fetch_sources(self, tc_id: str, args: dict) -> ToolResult:
        ids = args.get("source_ids", [])[:self._settings.max_fetch_source_count]
        content = self._resolve_source_full_texts(ids)
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="fetch_sources",
            content=content,
            is_backend_only=True,
        )

    async def _handle_fetch_sections(self, tc_id: str, args: dict) -> ToolResult:
        ids = args.get("section_ids", [])
        content = self._resolve_section_bodies(ids)
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="fetch_sections",
            content=content,
            is_backend_only=True,
        )

    # ------------------------------------------------------------------
    # フロントエンド向けハンドラ（SSE イベントを伴う）
    # ------------------------------------------------------------------

    async def _handle_update_section(self, tc_id: str, args: dict) -> ToolResult:
        section_id = args.get("section_id", "")
        content = args.get("content", "")
        sec = next((s for s in self._project.sections if s.id == section_id), None)
        title = sec.title if sec else section_id
        char_count = len(content)
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="update_section",
            content=json.dumps(
                {"status": "ok", "section_id": section_id, "char_count": char_count, "title": title},
                ensure_ascii=False,
            ),
            sse_events=[{"type": "tool_call", "data": {"tool": "update_section", "args": args}}],
        )

    async def _handle_update_multiple_sections(self, tc_id: str, args: dict) -> ToolResult:
        updates = args.get("updates", [])
        sec_by_id = {s.id: s for s in self._project.sections}
        results = []
        for u in updates:
            sid = u.get("section_id", "")
            sec = sec_by_id.get(sid)
            results.append({
                "section_id": sid,
                "title": sec.title if sec else sid,
                "char_count": len(u.get("content", "")),
            })
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="update_multiple_sections",
            content=json.dumps(
                {"status": "ok", "updated_count": len(updates), "sections": results},
                ensure_ascii=False,
            ),
            sse_events=[{"type": "tool_call", "data": {"tool": "update_multiple_sections", "args": args}}],
        )

    async def _handle_create_section(self, tc_id: str, args: dict) -> ToolResult:
        title = args.get("title", "新しいセクション")
        parent_id = args.get("parent_id")
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="create_section",
            content=json.dumps(
                {"status": "ok", "title": title, "parent_id": parent_id},
                ensure_ascii=False,
            ),
            sse_events=[{"type": "tool_call", "data": {"tool": "create_section", "args": args}}],
        )

    async def _handle_delete_section(self, tc_id: str, args: dict) -> ToolResult:
        section_id = args.get("section_id", "")
        sec = next((s for s in self._project.sections if s.id == section_id), None)
        title = sec.title if sec else section_id
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="delete_section",
            content=json.dumps(
                {"status": "ok", "deleted_id": section_id, "deleted_title": title},
                ensure_ascii=False,
            ),
            sse_events=[{"type": "tool_call", "data": {"tool": "delete_section", "args": args}}],
        )

    async def _handle_set_document_structure(self, tc_id: str, args: dict) -> ToolResult:
        sections = args.get("sections", [])
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="set_document_structure",
            content=json.dumps(
                {
                    "status": "ok",
                    "created_count": len(sections),
                    "structure_summary": f"{len(sections)}セクション構成",
                },
                ensure_ascii=False,
            ),
            sse_events=[{"type": "tool_call", "data": {"tool": "set_document_structure", "args": args}}],
        )

    async def _handle_create_document_structure(self, tc_id: str, args: dict) -> ToolResult:
        sections = args.get("sections", [])
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="create_document_structure",
            content=json.dumps(
                {
                    "status": "ok",
                    "created_count": len(sections),
                    "structure_summary": f"{len(sections)}セクション追加",
                },
                ensure_ascii=False,
            ),
            sse_events=[{"type": "tool_call", "data": {"tool": "create_document_structure", "args": args}}],
        )

    async def _handle_create_sections_under_parent(self, tc_id: str, args: dict) -> ToolResult:
        sections = args.get("sections", [])
        parent_id = args.get("parent_section_id")
        parent_sec = next((s for s in self._project.sections if s.id == parent_id), None) if parent_id else None
        parent_title = parent_sec.title if parent_sec else "(ルート)"
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="create_sections_under_parent",
            content=json.dumps(
                {
                    "status": "ok",
                    "created_count": len(sections),
                    "parent_id": parent_id,
                    "parent_title": parent_title,
                },
                ensure_ascii=False,
            ),
            sse_events=[{"type": "tool_call", "data": {"tool": "create_sections_under_parent", "args": args}}],
        )

    async def _handle_update_section_summary(self, tc_id: str, args: dict) -> ToolResult:
        section_id = args.get("section_id", "")
        sec = next((s for s in self._project.sections if s.id == section_id), None)
        title = sec.title if sec else section_id
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="update_section_summary",
            content=json.dumps(
                {"status": "ok", "section_id": section_id, "title": title},
                ensure_ascii=False,
            ),
            sse_events=[{"type": "tool_call", "data": {"tool": "update_section_summary", "args": args}}],
        )

    async def _handle_update_section_title(self, tc_id: str, args: dict) -> ToolResult:
        section_id = args.get("section_id", "")
        new_title = args.get("title", "")
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="update_section_title",
            content=json.dumps(
                {"status": "ok", "section_id": section_id, "new_title": new_title},
                ensure_ascii=False,
            ),
            sse_events=[{"type": "tool_call", "data": {"tool": "update_section_title", "args": args}}],
        )

    async def _handle_move_section(self, tc_id: str, args: dict) -> ToolResult:
        section_id = args.get("section_id", "")
        sec = next((s for s in self._project.sections if s.id == section_id), None)
        title = sec.title if sec else section_id
        return ToolResult(
            tool_call_id=tc_id,
            tool_name="move_section",
            content=json.dumps(
                {
                    "status": "ok",
                    "section_id": section_id,
                    "title": title,
                    "new_parent_id": args.get("parent_id"),
                    "new_order": args.get("order"),
                },
                ensure_ascii=False,
            ),
            sse_events=[{"type": "tool_call", "data": {"tool": "move_section", "args": args}}],
        )

    # ------------------------------------------------------------------
    # 解決ヘルパー
    # ------------------------------------------------------------------

    def _resolve_source_full_texts(self, source_ids: list[str]) -> str:
        """ソースIDリストを詳細サマリー（なければ全文冒頭）に解決する。"""
        src_by_id = {s.id: s for s in self._project.sources}
        logger.info(
            "fetch_sources: 要求されたIDs=%s, 利用可能IDs=%s",
            source_ids, list(src_by_id.keys()),
        )
        texts = []
        for sid in source_ids:
            src = src_by_id.get(sid) or src_by_id.get(f"ref-{sid}")
            if not src:
                logger.warning("fetch_sources: ID=%s が見つかりません", sid)
                continue
            logger.info(
                "fetch_sources: ID=%s, extended_summary=%d文字, full_text=%d文字",
                sid, len(src.extended_summary), len(src.full_text),
            )
            if src.extended_summary:
                texts.append(f"### ID: {src.id} | {src.name}\n\n{src.extended_summary}")
            elif src.full_text:
                texts.append(f"### ID: {src.id} | {src.name}\n\n{src.full_text[:3000]}")
        if not texts:
            return "指定されたソースは見つかりませんでした。"
        return "\n\n---\n\n".join(texts)

    def _resolve_section_bodies(self, section_ids: list[str]) -> str:
        """セクションIDリストをタイトル・概要・本文テキストに解決する。"""
        from app.backend.services.project_service import ProjectService
        sec_by_id = {s.id: s for s in self._project.sections}
        logger.info("fetch_sections: 要求されたIDs=%s", section_ids)
        texts = []
        for sid in section_ids:
            sec = sec_by_id.get(sid)
            if not sec:
                logger.warning("fetch_sections: ID=%s が見つかりません", sid)
                continue
            body = ProjectService.extract_section_body(self._project.content, sid)
            texts.append(
                f"### セクション ID: {sec.id} | {sec.title}\n"
                f"概要: {sec.summary or '(なし)'}\n\n"
                f"{body or '(本文なし)'}"
            )
        if not texts:
            return "指定されたセクションは見つかりませんでした。"
        return "\n\n---\n\n".join(texts)
