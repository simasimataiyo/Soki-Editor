"""LLMService — OpenAI 互換 API への接続・コンテキスト構築・SSE ストリーミング"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import TYPE_CHECKING, AsyncGenerator

if TYPE_CHECKING:
    from app.backend.services.vector_store_service import VectorStoreService

from app.backend.models import LLMSettings, Project

logger = logging.getLogger(__name__)

# ─── Tool 定義 ────────────────────────────────────────────────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "update_section",
            "description": "指定セクションの本文 content を更新する",
            "parameters": {
                "type": "object",
                "properties": {
                    "section_id": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["section_id", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_section",
            "description": "新しいセクションを作成する",
            "parameters": {
                "type": "object",
                "properties": {
                    "parent_id": {"type": "string", "nullable": True},
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_section_summary",
            "description": "指定セクションの概要 summary を更新する",
            "parameters": {
                "type": "object",
                "properties": {
                    "section_id": {"type": "string"},
                    "summary": {"type": "string"},
                },
                "required": ["section_id", "summary"],
            },
        },
    },
]

# Tool Calling 非対応モデルの識別キーワード
_NO_TOOL_CALLING_MODELS = {"ollama", "llama", "mistral", "gemma", "phi"}


class LLMService:
    """OpenAI 互換 API クライアント・コンテキスト構築・SSE ストリーミング。"""

    def _make_client(self, settings: LLMSettings):
        from openai import AsyncOpenAI

        kwargs = {"api_key": settings.api_key or "dummy"}
        if settings.endpoint_url:
            kwargs["base_url"] = settings.endpoint_url
        return AsyncOpenAI(**kwargs)

    def _supports_tool_calling(self, model: str) -> bool:
        model_lower = model.lower()
        return not any(kw in model_lower for kw in _NO_TOOL_CALLING_MODELS)

    async def chat_stream(
        self,
        project: Project,
        user_message: str,
        context_scope: str,
        use_full_sources: bool,
        vector_store_service: "VectorStoreService",
    ) -> AsyncGenerator[str, None]:
        """SSE ペイロード文字列を yield する。形式: data: {json}\\n\\n"""
        settings = project.settings
        client = self._make_client(settings)
        messages = self._build_chat_messages(project, user_message, context_scope)

        # ソース全文参照
        if use_full_sources:
            messages = await self._inject_full_sources(
                project, user_message, messages, vector_store_service
            )

        start = time.time()
        try:
            call_kwargs: dict = {
                "model": settings.model,
                "messages": messages,
                "stream": True,
            }
            if self._supports_tool_calling(settings.model):
                call_kwargs["tools"] = TOOLS
                call_kwargs["tool_choice"] = "auto"

            stream = await self._chat_with_retry(client, call_kwargs)
            async for event in self._process_chat_stream(stream):
                yield event

        except Exception as e:
            logger.error("LLM チャットエラー: %s", e)
            yield self._sse("error", {"message": str(e)})
        finally:
            elapsed = time.time() - start
            logger.info(
                "LLM 呼び出し完了: model=%s, elapsed=%.2fs", settings.model, elapsed
            )

    async def review_stream(
        self,
        project: Project,
        system_prompt: str,
        context_scope: str,
        use_full_sources: bool,
        vector_store_service: "VectorStoreService",
    ) -> AsyncGenerator[str, None]:
        """セクションごとに review_comment SSE イベントを yield する。"""
        settings = project.settings
        client = self._make_client(settings)
        sorted_sections = sorted(project.sections, key=lambda s: s.order)

        for sec in sorted_sections:
            section_context = f"# {sec.title}\n{sec.summary}\n\n{sec.content}"
            messages = [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": f"以下のセクションをレビューしてください:\n\n{section_context}",
                },
            ]
            try:
                response = await client.chat.completions.create(
                    model=settings.model,
                    messages=messages,
                )
                comment = response.choices[0].message.content or ""
                yield self._sse(
                    "review_comment",
                    {"section_id": sec.id, "comment": comment},
                )
            except Exception as e:
                logger.error("レビュー生成エラー (section=%s): %s", sec.id, e)
                yield self._sse("error", {"message": str(e)})

        yield self._sse("done", {})

    async def generate_summary(
        self, full_text: str, settings: LLMSettings
    ) -> str:
        """全文テキストから要約を生成する。"""
        client = self._make_client(settings)
        start = time.time()
        try:
            response = await client.chat.completions.create(
                model=settings.model,
                messages=[
                    {
                        "role": "system",
                        "content": "以下のテキストを300字以内で要約してください。",
                    },
                    {"role": "user", "content": full_text[:8000]},
                ],
            )
            summary = response.choices[0].message.content or ""
            return summary
        finally:
            elapsed = time.time() - start
            logger.info(
                "要約生成完了: model=%s, elapsed=%.2fs", settings.model, elapsed
            )

    async def analyze_image(
        self, file_path: str, settings: LLMSettings
    ) -> str:
        """Vision API で画像解析テキストを返す。FileService に委譲。"""
        from app.backend.services.file_service import FileService

        svc = FileService()
        return await svc.analyze_image_with_vision(file_path, settings)

    # ------------------------------------------------------------------
    # 内部ヘルパー
    # ------------------------------------------------------------------

    def _build_chat_messages(
        self, project: Project, user_message: str, context_scope: str
    ) -> list[dict]:
        # システムプロンプト構築
        system_parts: list[str] = ["あなたは学術論文執筆を支援する AI アシスタントです。"]

        # 有効ルール
        enabled_rules = [r for r in project.rules if r.enabled]
        if enabled_rules:
            rules_text = "\n".join(f"- {r.content}" for r in enabled_rules)
            system_parts.append(f"## 執筆ルール\n{rules_text}")

        # セクション骨子
        sorted_sections = sorted(project.sections, key=lambda s: s.order)
        if context_scope == "all":
            outline = "\n".join(
                f"- {s.title}: {s.summary}" for s in sorted_sections
            )
            system_parts.append(f"## 文書アウトライン\n{outline}")
        else:
            target = next((s for s in sorted_sections if s.id == context_scope), None)
            if target:
                system_parts.append(
                    f"## 対象セクション\n{target.title}: {target.summary}"
                )

        # ソース要約
        if project.sources:
            summaries = "\n".join(
                f"- {s.name}: {s.summary}" for s in project.sources if s.summary
            )
            if summaries:
                system_parts.append(f"## ソース要約\n{summaries}")

        system_content = "\n\n".join(system_parts)

        # チャット履歴
        history = project.chat_history.get(context_scope, [])
        messages: list[dict] = [{"role": "system", "content": system_content}]
        for msg in history:
            messages.append({"role": msg.role, "content": msg.content})
        messages.append({"role": "user", "content": user_message})
        return messages

    async def _inject_full_sources(
        self,
        project: Project,
        query: str,
        messages: list[dict],
        vector_store_service: "VectorStoreService",
    ) -> list[dict]:
        """ソース全文をコンテキストに追加する。"""
        source_ids = await vector_store_service.search_relevant_sources(
            project, query, k=5
        )
        src_by_id = {s.id: s for s in project.sources}

        # インデックスが空の場合は先頭 5 件をフォールバック
        if not source_ids:
            source_ids = [s.id for s in project.sources[:5]]

        full_texts = []
        for sid in source_ids:
            src = src_by_id.get(sid)
            if src and src.full_text:
                full_texts.append(f"### {src.name}\n{src.full_text[:3000]}")

        if full_texts:
            injected = "\n\n".join(full_texts)
            # システムメッセージにソース全文を追記
            messages[0]["content"] += f"\n\n## 関連ソース全文\n{injected}"
        return messages

    async def _chat_with_retry(self, client, call_kwargs: dict, max_retries: int = 3):
        """レートリミット(429)時に指数バックオフでリトライする。"""
        from openai import RateLimitError

        wait = 1.0
        for attempt in range(max_retries):
            try:
                return await client.chat.completions.create(**call_kwargs)
            except RateLimitError:
                if attempt == max_retries - 1:
                    raise
                logger.warning(
                    "レートリミット到達。%s秒後にリトライ (%d/%d)",
                    wait, attempt + 1, max_retries,
                )
                await asyncio.sleep(wait)
                wait *= 2

    async def _process_chat_stream(self, stream) -> AsyncGenerator[str, None]:
        """ストリームを処理して SSE イベントを yield する。"""
        tool_calls_acc: dict[int, dict] = {}

        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta is None:
                continue

            # テキストチャンク
            if delta.content:
                yield self._sse("chunk", {"text": delta.content})

            # ツールコール
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in tool_calls_acc:
                        tool_calls_acc[idx] = {
                            "name": tc.function.name or "",
                            "args_str": "",
                        }
                    if tc.function.name:
                        tool_calls_acc[idx]["name"] = tc.function.name
                    if tc.function.arguments:
                        tool_calls_acc[idx]["args_str"] += tc.function.arguments

            # 終了理由がツールコールの場合
            finish_reason = chunk.choices[0].finish_reason if chunk.choices else None
            if finish_reason == "tool_calls":
                for tc_data in tool_calls_acc.values():
                    try:
                        args = json.loads(tc_data["args_str"])
                    except json.JSONDecodeError:
                        args = {}
                    yield self._sse(
                        "tool_call",
                        {"tool": tc_data["name"], "args": args},
                    )
                tool_calls_acc.clear()

        yield self._sse("done", {})

    def _sse(self, event_type: str, payload: dict) -> str:
        data = {"type": event_type, **payload}
        return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
