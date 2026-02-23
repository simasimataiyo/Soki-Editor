"""LLMService — OpenAI 互換 API への接続・コンテキスト構築・SSE ストリーミング"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import time
from pathlib import Path
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
    {
        "type": "function",
        "function": {
            "name": "delete_section",
            "description": "指定セクションを削除する",
            "parameters": {
                "type": "object",
                "properties": {
                    "section_id": {"type": "string", "description": "削除するセクションのID"},
                },
                "required": ["section_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_section_title",
            "description": "指定セクションのタイトルを変更する",
            "parameters": {
                "type": "object",
                "properties": {
                    "section_id": {"type": "string"},
                    "title": {"type": "string"},
                },
                "required": ["section_id", "title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "move_section",
            "description": "指定セクションを別の親・位置に移動する（階層変更・並び順変更）",
            "parameters": {
                "type": "object",
                "properties": {
                    "section_id": {"type": "string"},
                    "parent_id": {"type": "string", "nullable": True, "description": "新しい親セクションのID。ルートに移動する場合は null"},
                    "order": {"type": "integer", "description": "同じ親内での表示順（0始まり）"},
                },
                "required": ["section_id", "order"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_document_structure",
            "description": "既存のセクションをすべて削除し、新しい骨子構造を一括作成する（/structure replace モード向け）",
            "parameters": {
                "type": "object",
                "properties": {
                    "sections": {
                        "type": "array",
                        "description": "作成するセクションのリスト。key/parent_key で階層を表現する",
                        "items": {
                            "type": "object",
                            "properties": {
                                "key": {"type": "string", "description": "このセクションを参照するための一時キー"},
                                "title": {"type": "string"},
                                "summary": {"type": "string"},
                                "parent_key": {"type": "string", "nullable": True, "description": "親セクションの key。ルートの場合は null"},
                                "order": {"type": "integer"},
                            },
                            "required": ["key", "title"],
                        },
                    },
                },
                "required": ["sections"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_document_structure",
            "description": "既存のセクションを残したまま、新しい骨子構造を追加で一括作成する（/structure 追加モード向け）",
            "parameters": {
                "type": "object",
                "properties": {
                    "sections": {
                        "type": "array",
                        "description": "追加するセクションのリスト。key/parent_key で階層を表現する",
                        "items": {
                            "type": "object",
                            "properties": {
                                "key": {"type": "string", "description": "このセクションを参照するための一時キー"},
                                "title": {"type": "string"},
                                "summary": {"type": "string"},
                                "parent_key": {"type": "string", "nullable": True, "description": "親セクションの key。ルートの場合は null"},
                                "order": {"type": "integer"},
                            },
                            "required": ["key", "title"],
                        },
                    },
                },
                "required": ["sections"],
            },
        },
    },
]

# Tool Calling 非対応モデルの識別キーワード
_NO_TOOL_CALLING_MODELS = {"ollama", "llama", "mistral", "gemma", "phi"}


class LLMService:
    """OpenAI 互換 API クライアント・コンテキスト構築・SSE ストリーミング。"""

    def __init__(self):
        # Jinja2環境の初期化
        templates_dir = Path(__file__).parent / "prompts"
        from jinja2 import Environment, FileSystemLoader, select_autoescape
        self._jinja_env = Environment(
            loader=FileSystemLoader(str(templates_dir)),
            autoescape=select_autoescape(['jinja2']),
            trim_blocks=True,
            lstrip_blocks=True
        )

    def _load_template(self, template_name: str):
        """Jinja2テンプレートをロードする。"""
        return self._jinja_env.get_template(template_name)

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
        command: str | None = None,
        command_args: list[str] | None = None,
        explicit_refs: list[str] | None = None,
    ) -> AsyncGenerator[str, None]:
        """SSE ペイロード文字列を yield する。形式: data: {json}\\n\\n"""
        settings = project.settings
        client = self._make_client(settings)

        if command:
            messages = self._build_command_messages(
                project, user_message, context_scope,
                command, command_args or [], explicit_refs or [],
            )
        else:
            messages = self._build_chat_messages(project, user_message, context_scope)

        # ソース全文参照（コマンドモードでは explicit_refs で既に注入済み）
        if use_full_sources and not command:
            messages = await self._inject_full_sources(
                project, user_message, messages, vector_store_service
            )

        start = time.time()
        try:
            # プロンプト出力（デバッグ用）
            print("=" * 60)
            print("=== LLM API呼び出しプロンプト ===")
            print(f"Model: {settings.model}")
            print(f"Messages ({len(messages)} 件):")
            for i, msg in enumerate(messages):
                print(f"  [{i}] {msg.get('role', 'unknown')}:")
                print(f"    {msg.get('content', '')}")
            print("=" * 60)

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
        review_focus: str | None = None,
        explicit_refs: list[str] | None = None,
    ) -> AsyncGenerator[str, None]:
        """セクションごとに review_comment SSE イベントを yield する。"""
        settings = project.settings
        client = self._make_client(settings)
        sorted_sections = sorted(project.sections, key=lambda s: s.order)

        # レビュー用システムプロンプトをテンプレート化
        template = self._load_template("review_system.jinja2")
        rendered_system_prompt = template.render(
            additional_prompt=system_prompt if system_prompt else "",
            review_focus=review_focus,
        )

        # 明示参照ソースの全文をコンテキストに追加
        explicit_source_context = ""
        if explicit_refs:
            src_by_id = {s.id: s for s in project.sources}
            source_texts = []
            for rid in explicit_refs:
                src = src_by_id.get(rid)
                if src and src.full_text:
                    source_texts.append(f"### {src.name}\n{src.full_text[:3000]}")
            if source_texts:
                explicit_source_context = (
                    "\n\n## 指定されたソース（参照用）\n"
                    + "\n\n".join(source_texts)
                )

        for sec in sorted_sections:
            section_context = f"# {sec.title}\n{sec.summary}\n\n{sec.content}"
            review_system = rendered_system_prompt + explicit_source_context
            messages = [
                {"role": "system", "content": review_system},
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

    async def extract_bibliography(
        self, full_text: str, bib_type: str, settings: LLMSettings
    ) -> Bibliography:
        """全文テキストから文献情報を抽出する"""
        from app.backend.models import Bibliography

        client = self._make_client(settings)
        template = self._load_template("bibliography_extraction.jinja2")

        system_prompt = template.render(
            source_id="",
            source_name="",
            bib_type=bib_type,
            full_text=full_text[:10000],  # Limit to avoid token overflow
        )

        start = time.time()
        try:
            response = await client.chat.completions.create(
                model=settings.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                ],
                response_format={"type": "json_object"},
            )
            content = response.choices[0].message.content or "{}"
            bib_data = json.loads(content)

            # Build Bibliography object, keeping existing type
            return Bibliography(type=bib_type, **bib_data)
        finally:
            elapsed = time.time() - start
            logger.info(
                "文献情報抽出完了: type=%s, elapsed=%.2fs", bib_type, elapsed
            )

    async def analyze_image_with_vision(
        self, file_path: str, settings: LLMSettings
    ) -> str:
        """Vision APIで画像/PDFを解析してテキストを返す。"""
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"ファイルが見つかりません: {file_path}")

        # PDFの場合は1ページ目を画像として抽出
        suffix = path.suffix.lower()
        if suffix == ".pdf":
            image_bytes = await asyncio.to_thread(self._extract_pdf_first_page, str(path))
            media_type = "image/png"
        else:
            image_bytes = path.read_bytes()
            media_type = self._get_media_type(suffix)

        return await self._call_vision_api(image_bytes, media_type, settings,
                                       "この画像の内容を詳しく説明してください。")

    async def analyze_image_bytes_with_vision(
        self,
        image_bytes: bytes,
        media_type: str,
        settings: LLMSettings,
        prompt_text: str = "この画像の内容を詳しく説明してください。",
    ) -> str:
        """バイト列の画像をVision APIで解析してテキストを返す。"""
        return await self._call_vision_api(image_bytes, media_type, settings, prompt_text)

    async def analyze_image_bytes_with_vision_stream(
        self,
        image_bytes: bytes,
        media_type: str,
        settings: LLMSettings,
        prompt_text: str = "この画像の内容を詳しく説明してください。",
    ):
        """バイト列の画像をVision APIで解析してテキストをストリーミングで返す非同期ジェネレータ。"""
        image_b64 = base64.b64encode(image_bytes).decode()
        client = self._make_client(settings)

        # プロンプトがデフォルトの場合はテンプレートを使用
        if prompt_text == "この画像の内容を詳しく説明してください。":
            template = self._load_template("vision_prompts.jinja2")
            prompt_text = template.module.default_image_prompt()

        stream = await client.chat.completions.create(
            model=settings.model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{media_type};base64,{image_b64}"},
                        },
                        {"type": "text", "text": prompt_text},
                    ],
                }
            ],
            stream=True,
        )
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content

    async def analyze_image(
        self, file_path: str, settings: LLMSettings
    ) -> str:
        """Vision API で画像解析テキストを返す（非推奨: analyze_image_with_visionを使用）。"""
        return await self.analyze_image_with_vision(file_path, settings)

    # ------------------------------------------------------------------
    # 内部ヘルパー
    # ------------------------------------------------------------------

    def _get_media_type(self, suffix: str) -> str:
        """ファイル拡張子からメディアタイプを返す。"""
        mapping = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        }
        return mapping.get(suffix, "image/png")

    def _extract_pdf_first_page(self, file_path: str) -> bytes:
        """PDFの1ページ目を画像として抽出する（同期処理）。"""
        import fitz  # PyMuPDF
        from PIL import Image

        doc = fitz.open(file_path)
        page = doc.load_page(0)
        pix = page.get_pixmap(dpi=150)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        doc.close()

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    async def _call_vision_api(
        self, image_bytes: bytes, media_type: str, settings: LLMSettings, prompt_text: str
    ) -> str:
        """Vision APIを呼び出してテキストを返す共通メソッド。"""
        image_b64 = base64.b64encode(image_bytes).decode()
        client = self._make_client(settings)

        response = await client.chat.completions.create(
            model=settings.model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{media_type};base64,{image_b64}"},
                        },
                        {"type": "text", "text": prompt_text},
                    ],
                }
            ],
        )
        return response.choices[0].message.content or ""

    def _build_command_messages(
        self,
        project: Project,
        user_message: str,
        context_scope: str,
        command: str,
        command_args: list[str],
        explicit_refs: list[str],
    ) -> list[dict]:
        """コマンド専用のシステムプロンプトを構築する。"""
        template = self._load_template("command_system.jinja2")

        enabled_rules = [r for r in project.rules if r.enabled]
        sorted_sections = sorted(project.sections, key=lambda s: s.order)

        if context_scope == "all":
            target_section = None
            context_scope_value = "all"
        else:
            target_section = next(
                (s for s in sorted_sections if s.id == context_scope), None
            )
            context_scope_value = "section"

        source_summaries = [
            {"id": s.id, "name": s.name, "summary": s.summary}
            for s in project.sources
            if s.summary
        ]

        # 明示参照されたソース・マテリアルを解決
        src_by_id = {s.id: s for s in project.sources}
        mat_by_id = {m.id: m for m in project.materials}
        explicit_sources = [
            src_by_id[rid] for rid in explicit_refs if rid in src_by_id
        ]
        explicit_materials = [
            mat_by_id[rid] for rid in explicit_refs if rid in mat_by_id
        ]

        # 同一スコープの履歴を取得
        history = project.chat_history.get(context_scope, [])

        # 履歴中で明示参照されたソース/マテリアルの現在の状態を収集
        history_ref_ids: set[str] = set()
        for msg in history:
            history_ref_ids.update(getattr(msg, "explicit_refs", []))
        # 今回のコマンドで明示参照されたものは explicit_sources/materials に含まれるので除外
        history_ref_ids -= set(explicit_refs)
        history_sources = [src_by_id[rid] for rid in history_ref_ids if rid in src_by_id]
        history_materials = [mat_by_id[rid] for rid in history_ref_ids if rid in mat_by_id]

        system_content = template.render(
            command=command,
            command_args=command_args,
            enabled_rules=enabled_rules,
            sections=sorted_sections,
            context_scope=context_scope_value,
            target_section=target_section,
            source_summaries=source_summaries,
            explicit_sources=explicit_sources,
            explicit_materials=explicit_materials,
            history_sources=history_sources,
            history_materials=history_materials,
            user_message=user_message,
        )

        # 同一スコープの履歴（チャット履歴をコンテキストに追加）
        history_messages = []
        for msg in history:
            if msg.role == "user":
                history_messages.append({"role": "user", "content": msg.content})
            elif msg.role == "assistant":
                history_messages.append({"role": "assistant", "content": msg.content})
            elif msg.role == "command":
                # コマンド履歴も含める
                history_messages.append({"role": "user", "content": msg.content})

        # コマンドの場合もチャット履歴を含める（文脈を保持）
        messages: list[dict] = [{"role": "system", "content": system_content}]
        messages.extend(history_messages)
        if user_message:
            messages.append({"role": "user", "content": user_message})
        return messages

    def _build_chat_messages(
        self, project: Project, user_message: str, context_scope: str
    ) -> list[dict]:
        """Jinja2テンプレートを使用してシステムプロンプトを構築する。"""
        template = self._load_template("chat_system.jinja2")

        # テンプレート変数の準備
        enabled_rules = [r for r in project.rules if r.enabled]
        sorted_sections = sorted(project.sections, key=lambda s: s.order)

        if context_scope == "all":
            target_section = None
            context_scope_value = "all"
        else:
            target_section = next((s for s in sorted_sections if s.id == context_scope), None)
            context_scope_value = "section"

        source_summaries = [
            {"id": s.id, "name": s.name, "summary": s.summary}
            for s in project.sources if s.summary
        ]

        # チャット履歴の取得
        history = project.chat_history.get(context_scope, [])

        # 履歴中で明示参照されたソース/マテリアルの現在の状態を収集
        src_by_id = {s.id: s for s in project.sources}
        mat_by_id = {m.id: m for m in project.materials}
        history_ref_ids: set[str] = set()
        for msg in history:
            history_ref_ids.update(getattr(msg, "explicit_refs", []))
        history_sources = [src_by_id[rid] for rid in history_ref_ids if rid in src_by_id]
        history_materials = [mat_by_id[rid] for rid in history_ref_ids if rid in mat_by_id]

        # システムプロンプトの生成
        system_content = template.render(
            enabled_rules=enabled_rules,
            sections=sorted_sections,
            context_scope=context_scope_value,
            target_section=target_section,
            source_summaries=source_summaries,
            history_sources=history_sources,
            history_materials=history_materials,
        )

        # チャット履歴の構築（role="command" は "user" にマッピング）
        messages: list[dict] = [{"role": "system", "content": system_content}]
        for msg in history:
            if msg.role == "command":
                messages.append({"role": "user", "content": msg.content})
            else:
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
