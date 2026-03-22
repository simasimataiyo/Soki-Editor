"""LLMService — OpenAI 互換 API への接続・コンテキスト構築・SSE ストリーミング"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import time
from pathlib import Path
from typing import AsyncGenerator
from urllib.parse import urlparse

import httpx

from app.backend.models import LLMSettings, Project

logger = logging.getLogger(__name__)


class _AllowlistTransport(httpx.AsyncBaseTransport):
    """設定済みLLMエンドポイント以外への外部通信をブロックするhttpxトランスポート。"""

    def __init__(self, inner: httpx.AsyncBaseTransport, get_allowed_url):
        self._inner = inner
        self._get_allowed_url = get_allowed_url

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        allowed = self._get_allowed_url() or "https://api.openai.com"
        allowed_netloc = urlparse(allowed).netloc
        req_netloc = urlparse(str(request.url)).netloc
        if req_netloc != allowed_netloc:
            raise ValueError(f"外部通信がブロックされました: {req_netloc}")
        return await self._inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self._inner.aclose()


def _sort_sections_hierarchically(sections: list) -> list:
    """セクションリストを階層順（深さ優先・兄弟はorder昇順）に並べ替える。互換ラッパー。"""
    from app.backend.services.utils import sort_sections_hierarchically
    return sort_sections_hierarchically(sections)


# ─── Tool 定義 ────────────────────────────────────────────────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "update_multiple_sections",
            "description": "複数のセクションの本文(content)を一括で更新する（/draft-all 向け）",
            "parameters": {
                "type": "object",
                "properties": {
                    "updates": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "section_id": {"type": "string"},
                                "content": {"type": "string"},
                            },
                            "required": ["section_id", "content"],
                        },
                    },
                },
                "required": ["updates"],
            },
        },
    },
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
    {
        "type": "function",
        "function": {
            "name": "create_sections_under_parent",
            "description": "指定したセクションの配下に複数のサブセクションを一括追加する（/structure-section 向け。既存の子セクションは保持したまま追加する）",
            "parameters": {
                "type": "object",
                "properties": {
                    "parent_section_id": {
                        "type": "string",
                        "description": "子セクションを追加する親セクションのID。親を直接指定する場合に使用。ルート直下に追加する場合は null",
                        "nullable": True,
                    },
                    "sections": {
                        "type": "array",
                        "description": "追加するセクションのリスト",
                        "items": {
                            "type": "object",
                            "properties": {
                                "key": {"type": "string", "description": "このセクションを参照するための一時キー（他セクションの parent_key に使用）"},
                                "title": {"type": "string"},
                                "summary": {"type": "string"},
                                "parent_key": {"type": "string", "nullable": True, "description": "親となるセクションの key（このリスト内の key）。parent_section_id の直下に追加する場合は null"},
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
            "name": "fetch_sources",
            "description": "参考文献の全文を取得する。参考文献の概要一覧を確認し、タスクの実行に必要なソースのIDを最大4つまで指定してください。",
            "parameters": {
                "type": "object",
                "properties": {
                    "source_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "maxItems": 4,
                        "description": "取得するソースのIDリスト（最大4つ）",
                    },
                },
                "required": ["source_ids"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_sections",
            "description": "指定したセクションのタイトル・概要・本文を取得する。他のセクションの内容を参照しながら執筆する際に使用してください。",
            "parameters": {
                "type": "object",
                "properties": {
                    "section_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "取得するセクションのIDリスト",
                    },
                },
                "required": ["section_ids"],
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

        inner = httpx.AsyncHTTPTransport()
        transport = _AllowlistTransport(inner, lambda: settings.endpoint_url or "")
        http_client = httpx.AsyncClient(transport=transport)

        kwargs = {"api_key": settings.api_key or "dummy", "http_client": http_client}
        if settings.endpoint_url:
            kwargs["base_url"] = settings.endpoint_url
        return AsyncOpenAI(**kwargs)

    def _supports_tool_calling(self, model: str) -> bool:
        model_lower = model.lower()
        return not any(kw in model_lower for kw in _NO_TOOL_CALLING_MODELS)

    # レビュー結果の JSON スキーマ（Structured Output 用）
    _REVIEW_RESPONSE_SCHEMA = {
        "type": "json_schema",
        "json_schema": {
            "name": "review_result",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "comments": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "section":    {"type": "string"},
                                "problem":    {"type": "string"},
                                "suggestion": {"type": "string"},
                            },
                            "required": ["section", "problem", "suggestion"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["comments"],
                "additionalProperties": False,
            },
        },
    }

    async def chat_stream(
        self,
        project: Project,
        settings: LLMSettings,
        user_message: str,
        context_scope: str,
        command: str | None = None,
        command_args: list[str] | None = None,
        explicit_refs: list[str] | None = None,
        selected_text: str | None = None,
        project_service=None,
        project_id: str | None = None,
    ) -> AsyncGenerator[str, None]:
        """SSE ペイロード文字列を yield する。形式: data: {json}\\n\\n

        fetch_sources ツールコールを検出した場合、バックエンドでソース全文を解決し
        再度 LLM API を呼び出す多段フローを実行する（フロントエンドには透過的）。
        reviewコマンドの場合は Structured Output（非ストリーミング）で呼び出す。
        """
        from app.backend.services.agent_loop import AgentLoop
        from app.backend.services.tool_executor import ToolExecutor

        client = self._make_client(settings)

        messages = self._build_messages(
            project, settings, user_message, context_scope,
            command=command,
            command_args=command_args or [],
            explicit_refs=explicit_refs or [],
            selected_text=selected_text,
        )

        start = time.time()
        is_review_command = command and self._normalize_command(command, command_args or [])["base_command"] == "review"
        try:
            # プロンプト出力（デバッグ用）
            self._debug_print_messages(settings.model, messages)

            # reviewコマンドは Structured Output（非ストリーミング）で呼び出す
            if is_review_command:
                max_comments = settings.review_max_comments if settings.review_max_comments > 0 else None
                async for event in self._review_structured_output(client, settings.model, messages, max_comments=max_comments):
                    yield event
                return

            call_kwargs: dict = {
                "model": settings.model,
                "messages": messages,
                "stream": True,
            }
            use_tools = self._supports_tool_calling(settings.model)
            if use_tools:
                # デフォルトではすべてのツールを渡す
                import copy
                tools_copy = copy.deepcopy(TOOLS)
                for t in tools_copy:
                    if t["function"]["name"] == "fetch_sources":
                        desc = f"参考文献の全文を取得する。参考文献の概要一覧を確認し、タスクの実行に必要なソースのIDを最大{settings.max_fetch_source_count}つまで指定してください。"
                        t["function"]["description"] = desc  # type: ignore
                        t["function"]["parameters"]["properties"]["source_ids"]["maxItems"] = settings.max_fetch_source_count  # type: ignore
                        t["function"]["parameters"]["properties"]["source_ids"]["description"] = f"取得するソースのIDリスト（最大{settings.max_fetch_source_count}つ）"  # type: ignore

                call_kwargs["tools"] = tools_copy
                call_kwargs["tool_choice"] = "auto"

                # 特定の /structure 系コマンドの場合は、ツールを制限する
                if command and isinstance(command, str) and command.startswith("structure"):
                    command_mode = self._normalize_command(command, command_args or [])
                    mode = command_mode["mode"]
                    if mode == "replace":
                        target_tool_name = "set_document_structure"
                        call_kwargs["tools"] = [t for t in tools_copy if t["function"]["name"] == target_tool_name]
                        call_kwargs["tool_choice"] = {
                            "type": "function",
                            "function": {"name": target_tool_name}
                        }
                    elif mode == "section":
                        # structure-section: タイトル・概要・子構造の変更（本文不変）
                        structure_section_tools = [
                            "update_section_title", "update_section_summary",
                            "create_section", "delete_section", "move_section"
                        ]
                        call_kwargs["tools"] = [t for t in tools_copy if t["function"]["name"] in structure_section_tools]
                        call_kwargs["tool_choice"] = "auto"
                    elif mode == "summary":
                        # structure-summary: 概要のみ更新
                        call_kwargs["tools"] = [t for t in tools_copy if t["function"]["name"] == "update_section_summary"]
                        call_kwargs["tool_choice"] = "auto"
                    else:  # add
                        target_tool_name = "create_sections_under_parent"
                        call_kwargs["tools"] = [t for t in tools_copy if t["function"]["name"] == target_tool_name]
                        call_kwargs["tool_choice"] = {
                            "type": "function",
                            "function": {"name": target_tool_name}
                        }

            # ToolExecutor と AgentLoop を構築してエージェントループを実行
            tool_executor = ToolExecutor(
                project_service=project_service,
                project_id=project_id or "",
                project=project,
                settings=settings,
            )

            # コンテキストビルダー（Phase 4: project_service がある場合のみ有効化）
            context_builder = None
            if project_service and project_id:
                context_builder = _SystemContextBuilder(self, project, settings, context_scope)

            # リフレクションプロンプト（Phase 6: draft / rewrite / expand コマンド時のみ有効化）
            reflection_prompt = None
            normalized_cmd = self._normalize_command(command, command_args or []) if command else None
            if normalized_cmd and normalized_cmd["base_command"] in ("draft", "rewrite", "expand"):
                refl_template = self._load_template("reflection.jinja2")
                reflection_prompt = refl_template.render(command=normalized_cmd["base_command"])

            # 計画→実行ループ（Phase 5: コマンド未指定かつ複合タスク検出時）
            if not command and self._needs_planning(user_message):
                async for event in self._plan_and_execute(
                    client, project, settings, user_message, context_scope,
                    explicit_refs or [], selected_text,
                    project_service, project_id or "",
                    tool_executor, context_builder,
                ):
                    yield event
                return

            agent = AgentLoop(
                client=client,
                tool_executor=tool_executor,
                model=settings.model,
                max_rounds=5,
                context_builder=context_builder,
                reflection_prompt=reflection_prompt,
            )

            async for event in agent.run(messages, call_kwargs):
                yield event

        except Exception as e:
            logger.error("LLM チャットエラー: %s", e)
            yield self._sse("error", {"message": str(e)})
        finally:
            elapsed = time.time() - start
            logger.info(
                "LLM 呼び出し完了: model=%s, elapsed=%.2fs", settings.model, elapsed
            )

    async def _review_structured_output(
        self,
        client,
        model: str,
        messages: list[dict],
        max_comments: int | None = None,
    ) -> AsyncGenerator[str, None]:
        """レビューコマンド用: Structured Output で review_result を生成して yield する。

        - ストリーミングなし・JSON スキーマ強制で呼び出す
        - 成功時: review_result SSE イベントと done イベントを yield
        - 失敗時: error SSE イベントを yield
        - max_comments: コメント数の上限（None=無制限）
        """
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=messages,
                response_format=self._REVIEW_RESPONSE_SCHEMA,
            )
            content = response.choices[0].message.content or "{}"
            review_data = json.loads(content)
            comments = review_data.get("comments", [])
            if max_comments is not None:
                comments = comments[:max_comments]
        except json.JSONDecodeError as e:
            logger.error("レビュー Structured Output JSON パースエラー: %s", e)
            comments = []
        except Exception as e:
            logger.error("レビュー Structured Output 呼び出しエラー: %s", e)
            yield self._sse("error", {"message": str(e)})
            return

        yield self._sse("review_result", {"comments": comments})
        yield self._sse("done", {})

    async def review_stream(
        self,
        project: Project,
        settings: LLMSettings,
        system_prompt: str,
        context_scope: str,
        review_focus: str | None = None,
        explicit_refs: list[str] | None = None,
    ) -> AsyncGenerator[str, None]:
        """セクションごとに review_comment SSE イベントを yield する。"""
        client = self._make_client(settings)
        sorted_sections = _sort_sections_hierarchically(project.sections)

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
            sec_body = self._extract_section_body(project.content, sec.id)
            section_context = f"# {sec.title}\n{sec.summary}\n\n{sec_body}"
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
                        "content": f"Summarize the user\'s text in about {settings.short_summary_chars} characters. Do not use headings or numbering. First state in one short sentence what the text is about, then provide a concise summary.",
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

    async def generate_extended_summary(
        self, full_text: str, settings: LLMSettings
    ) -> str:
        """全文テキストから構造化詳細サマリーを生成する。
        LLMが fetch_sources を呼んだ際に返す内容として使用する。
        主張・重要数値・固有名詞・引用候補フレーズを含む2000字程度のサマリー。
        """
        client = self._make_client(settings)
        start = time.time()
        system_prompt = f"Write a detailed summary in about {settings.long_summary_chars} characters. Include: 1) main claims/purpose/background; 2) key numbers/data/conditions; 3) important proper nouns (people, organizations, technologies, studies); 4) quote-worthy concrete phrases; 5) conclusions/implications/future work."
        try:
            response = await client.chat.completions.create(
                model=settings.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": full_text[:12000]},
                ],
            )
            extended_summary = response.choices[0].message.content or ""
            return extended_summary
        finally:
            elapsed = time.time() - start
            logger.info(
                "詳細サマリー生成完了: model=%s, elapsed=%.2fs", settings.model, elapsed
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

            # LLMが "type" や "include_in_references" を返した場合に TypeError になるため除去
            bib_data.pop("type", None)
            bib_data.pop("include_in_references", None)

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

    @staticmethod
    def _trim_history_by_size(
        messages: list[dict], max_chars: int = 30000
    ) -> list[dict]:
        """メッセージリストの合計文字数が上限を超える場合、古い履歴を削除する。

        system メッセージ（先頭）と最新の user メッセージ（末尾）は常に保持し、
        その間の履歴メッセージを古い方から削除してサイズを制限する。
        """
        if len(messages) <= 2:
            return messages

        total = sum(len(m.get("content", "") or "") for m in messages)
        if total <= max_chars:
            return messages

        # system (先頭) + 最新 user (末尾) は固定
        system_msg = messages[0]
        last_msg = messages[-1]
        history = messages[1:-1]

        fixed_size = len(system_msg.get("content", "") or "") + len(
            last_msg.get("content", "") or ""
        )
        budget = max_chars - fixed_size

        # 新しい方から残す
        kept: list[dict] = []
        used = 0
        for msg in reversed(history):
            msg_size = len(msg.get("content", "") or "")
            if used + msg_size > budget:
                break
            kept.append(msg)
            used += msg_size
        kept.reverse()

        return [system_msg, *kept, last_msg]

    @staticmethod
    def _extract_section_body(project_content: str, section_id: str) -> str:
        """project.content から特定セクションのボディテキスト（見出し行除く）を抽出する。

        新形式: <!-- soki-section:{"id": "uuid", ...} -->
        旧形式: <!-- soki-section:uuid -->
        """
        import re
        # 新形式（JSON内の"id"フィールドでマッチ）と旧形式（UUID直接）の両方に対応
        escaped_id = re.escape(section_id)
        pattern = re.compile(
            r'<!-- soki-section:(?:'
            + r'\{[^}]*"id"\s*:\s*"' + escaped_id + r'"[^}]*\}'
            + r'|'
            + escaped_id
            + r') -->\n'
            r'#{1,6} [^\n]+\n'
            r'(.*?)(?=<!-- soki-section:|$)',
            re.DOTALL
        )
        m = pattern.search(project_content)
        return m.group(1).strip() if m else ''

    def _build_messages(
        self,
        project: Project,
        settings: LLMSettings,
        user_message: str,
        context_scope: str,
        command: str | None = None,
        command_args: list[str] | None = None,
        explicit_refs: list[str] | None = None,
        selected_text: str | None = None,
    ) -> list[dict]:
        """チャット・コマンド共通のメッセージリストを構築する。

        - system: chat_system.jinja2 （全モード共通・固定）
        - history: 通常チャット(user/assistant)ペアのみ。コマンド実行ペアは除外し
                   要約テキスト(assistant)のみ残す
        - user: ユーザー入力。コマンド時はタスク指示を末尾に注入する
        """
        refs = explicit_refs or []
        args = command_args or []

        enabled_rules = [r for r in project.rules if r.enabled]
        sorted_sections = _sort_sections_hierarchically(project.sections)

        if context_scope == "all":
            target_section = None
        else:
            target_section = next(
                (s for s in sorted_sections if s.id == context_scope), None
            )

        source_summaries = [
            {
                "id": s.id,
                "name": s.name,
                "summary": s.summary,
                "include_in_references": s.bibliography.include_in_references,
            }
            for s in project.sources
            if s.summary
        ]

        src_by_id = {s.id: s for s in project.sources}
        mat_by_id = {m.id: m for m in project.materials}
        explicit_sources = [src_by_id[rid] for rid in refs if rid in src_by_id]
        explicit_materials = [mat_by_id[rid] for rid in refs if rid in mat_by_id]

        history = project.chat_history
        history_ref_ids: set[str] = set()
        for msg in history:
            history_ref_ids.update(getattr(msg, "explicit_refs", []))
        history_ref_ids -= set(refs)
        history_sources = [src_by_id[rid] for rid in history_ref_ids if rid in src_by_id]
        history_materials = [mat_by_id[rid] for rid in history_ref_ids if rid in mat_by_id]

        # セクション本文の取得
        target_section_body = None
        if target_section:
            target_section_body = self._extract_section_body(
                project.content, target_section.id
            )

        # system プロンプト（全モード共通・安定化）
        system_template = self._load_template("chat_system.jinja2")
        system_content = system_template.render(
            enabled_rules=enabled_rules,
            sections=sorted_sections,
            source_summaries=source_summaries,
            max_fetch_source_count=settings.max_fetch_source_count,
        )

        # 履歴の構築:
        #   - 通常チャット (user/assistant) → そのまま含める
        #   - コマンド実行 (role="command") → 除外（次のassistantが要約テキスト）
        #   - コマンド後の要約 (role="assistant" で直前がcommand) → 保持
        history_messages: list[dict] = []
        for msg in history:
            if msg.role == "command":
                # コマンド実行メッセージ自体は除外。次のassistant要約は保持するためフラグを立てない
                # （要約はLLMに渡すべき事実として保持）
                continue
            elif msg.role == "assistant":
                history_messages.append({"role": "assistant", "content": msg.content})
            elif msg.role == "user":
                history_messages.append({"role": "user", "content": msg.content})

        # 動的コンテキスト（対象セクション・指定ソース等）をuserメッセージに注入（常時）
        context_template = self._load_template("user_context.jinja2")
        context_injection = context_template.render(
            target_section=target_section,
            target_section_body=target_section_body,
            selected_text=selected_text,
            explicit_sources=explicit_sources,
            explicit_materials=explicit_materials,
            history_sources=history_sources,
            history_materials=history_materials,
        ).strip()

        # userメッセージの構築
        if command:
            command_mode = self._normalize_command(command, args)
            # コマンド時: 全セクション本文が必要なケース
            section_bodies_by_id: dict[str, str] = {}
            _needs_bodies = command_mode["base_command"] in ("rewrite", "review") or \
                (command_mode["base_command"] == "structure" and command_mode["mode"] in ("summary", "section"))
            if _needs_bodies:
                for sec in sorted_sections:
                    section_bodies_by_id[sec.id] = self._extract_section_body(
                        project.content, sec.id
                    )

            # タスク指示をユーザーメッセージに注入（コンテキスト → タスク指示の順）
            task_template = self._load_template("command_system.jinja2")
            task_injection = task_template.render(
                command=command_mode["base_command"],
                command_mode=command_mode["mode"],
                sections=sorted_sections,
                target_section=target_section,
                target_section_body=target_section_body,
                section_bodies_by_id=section_bodies_by_id,
                source_summaries=source_summaries,
                max_fetch_source_count=settings.max_fetch_source_count,
            ).strip()
            parts = [p for p in [user_message, context_injection, task_injection] if p]
            final_user_message = "\n".join(parts)
        else:
            parts = [p for p in [user_message, context_injection] if p]
            final_user_message = "\n".join(parts)

        messages: list[dict] = [{"role": "system", "content": system_content}]
        messages.extend(history_messages)
        messages.append({"role": "user", "content": final_user_message})
        return self._trim_history_by_size(messages)

    @staticmethod
    def _normalize_command(command: str, command_args: list[str]) -> dict:
        """フロントエンドからのコマンド名を内部形式に変換する。

        新しいコマンド名（ハイフン区切り）を従来の内部形式に変換：
        - structure-replace → structure, mode=replace
        - structure-section → structure, mode=section
        - structure-add → structure, mode=add
        - その他 → コマンド名をそのまま使用、modeは空文字列
        """
        # ハイフン区切りコマンドのパース
        if "-" in command:
            parts = command.split("-")
            base = parts[0]
            mode = "-".join(parts[1:]) if len(parts) > 1 else ""
            return {"base_command": base, "mode": mode}

        # 従来形式（command_argsで指定）は後方互換性のために維持
        # 将来的には削除予定
        if command == "structure" and command_args:
            mode = command_args[0] if command_args else "add"
            return {"base_command": "structure", "mode": mode}

        return {"base_command": command, "mode": ""}

    async def _chat_with_retry(self, client, call_kwargs: dict, max_retries: int = 3):
        """レートリミット(429)時に指数バックオフでリトライする。"""
        from openai import RateLimitError

        wait = 5.0
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

    async def _iter_stream_events(self, stream) -> AsyncGenerator[tuple[str, dict], None]:
        """OpenAI ストリームを処理して構造化イベントタプルを yield する。

        Yields:
            ("chunk", {"text": str}) — テキストチャンク
            ("tool_call", {"id": str, "tool": str, "args": dict}) — ツールコール
        """
        tool_calls_acc: dict[int, dict] = {}

        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta is None:
                continue

            # テキストチャンク
            if delta.content:
                yield ("chunk", {"text": delta.content})

            # ツールコール（増分的に蓄積）
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in tool_calls_acc:
                        tool_calls_acc[idx] = {"id": "", "name": "", "args_str": ""}
                    if tc.id:
                        tool_calls_acc[idx]["id"] = tc.id
                    if tc.function:
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
                    yield (
                        "tool_call",
                        {"id": tc_data["id"], "tool": tc_data["name"], "args": args},
                    )
                tool_calls_acc.clear()

    def _resolve_section_bodies(self, project: Project, section_ids: list[str]) -> str:
        """セクションIDリストをタイトル・概要・本文テキストに解決する。"""
        sec_by_id = {s.id: s for s in project.sections}
        logger.info("fetch_sections: 要求されたIDs=%s", section_ids)
        texts = []
        for sid in section_ids:
            sec = sec_by_id.get(sid)
            if not sec:
                logger.warning("fetch_sections: ID=%s が見つかりません", sid)
                continue
            body = self._extract_section_body(project.content, sid)
            texts.append(
                f"### セクション ID: {sec.id} | {sec.title}\n"
                f"概要: {sec.summary or '(なし)'}\n\n"
                f"{body or '(本文なし)'}"
            )
        if not texts:
            return "指定されたセクションは見つかりませんでした。"
        return "\n\n---\n\n".join(texts)

    def _resolve_source_full_texts(self, project: Project, source_ids: list[str]) -> str:
        """ソースIDリストを詳細サマリー（なければ全文冒頭）に解決する。"""
        src_by_id = {s.id: s for s in project.sources}
        logger.info("fetch_sources: 要求されたIDs=%s, 利用可能IDs=%s", source_ids, list(src_by_id.keys()))
        texts = []
        for sid in source_ids[:4]:
            src = src_by_id.get(sid) or src_by_id.get(f"ref-{sid}")
            if not src:
                logger.warning("fetch_sources: ID=%s が見つかりません", sid)
                continue
            logger.info("fetch_sources: ID=%s, extended_summary=%d文字, full_text=%d文字", sid, len(src.extended_summary), len(src.full_text))
            if src.extended_summary:
                texts.append(f"### ID: {src.id} | {src.name}\n\n{src.extended_summary}")
            elif src.full_text:
                texts.append(f"### ID: {src.id} | {src.name}\n\n{src.full_text[:3000]}")
        if not texts:
            return "指定されたソースは見つかりませんでした。"
        return "\n\n---\n\n".join(texts)

    def _debug_print_messages(self, model: str, messages: list[dict]) -> None:
        """デバッグ用: LLM API 呼び出しのプロンプトを出力する。"""
        print("=" * 60)
        print("=== LLM API呼び出しプロンプト ===")
        print(f"Model: {model}")
        print(f"Messages ({len(messages)} 件):")
        for i, msg in enumerate(messages):
            print(f"  [{i}] {msg.get('role', 'unknown')}:")
            content = msg.get("content", "")
            if content:
                print(f"    {content[:5000]}{'...' if len(str(content)) > 5000 else ''}")
            if msg.get("tool_calls"):
                print(f"    [tool_calls: {len(msg['tool_calls'])} 件]")
        print("=" * 60)

    def _sse(self, event_type: str, payload: dict) -> str:
        data = {"type": event_type, **payload}
        return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

    # ------------------------------------------------------------------
    # Phase 5: 計画→実行の2段階エージェントループ
    # ------------------------------------------------------------------

    # 複合タスクを示すキーワードパターン（日本語・英語）
    _PLANNING_PATTERNS = [
        # 日本語: 順序を示す接続表現
        "してから", "した後", "した上で", "してそれから",
        "まず", "次に", "最後に", "はじめに", "そして",
        # 日本語: 並列タスクを示す表現
        "〜して〜して", "〜し、", "〜して、",
        # 英語
        "first", "then", "after that", "finally", "next",
        "and then", "followed by",
    ]

    def _needs_planning(self, user_message: str) -> bool:
        """複合タスクかどうかをヒューリスティクスで判定する。"""
        msg_lower = user_message.lower()
        matched = sum(1 for p in self._PLANNING_PATTERNS if p in msg_lower)
        # 2つ以上の順序表現が含まれる場合は複合タスクと判定
        return matched >= 2

    async def _generate_plan(
        self,
        client,
        messages: list[dict],
        settings,
    ) -> dict:
        """LLM に実行計画を JSON 形式で生成させる（非ストリーミング）。"""
        plan_template = self._load_template("plan_system.jinja2")
        plan_system = plan_template.render()

        plan_messages = [
            {"role": "system", "content": plan_system},
            # ユーザーメッセージのみ渡す（システムコンテキストは除く）
            messages[-1],
        ]
        try:
            response = await client.chat.completions.create(
                model=settings.model,
                messages=plan_messages,
                response_format={"type": "json_object"},
            )
            content = response.choices[0].message.content or "{}"
            plan = json.loads(content)
            if "steps" not in plan:
                plan = {"steps": [{"type": "chat", "description": "通常チャット"}], "reasoning": ""}
        except (json.JSONDecodeError, Exception) as e:
            logger.warning("計画生成失敗、通常チャットにフォールバック: %s", e)
            plan = {"steps": [{"type": "chat", "description": "通常チャット"}], "reasoning": ""}
        return plan

    async def _plan_and_execute(
        self,
        client,
        project,
        settings,
        user_message: str,
        context_scope: str,
        explicit_refs: list,
        selected_text,
        project_service,
        project_id: str,
        tool_executor,
        context_builder,
    ):
        """計画生成 → ステップ順次実行を行う非同期ジェネレータ。"""
        from app.backend.services.agent_loop import AgentLoop

        messages = self._build_messages(
            project, settings, user_message, context_scope,
            explicit_refs=explicit_refs,
            selected_text=selected_text,
        )

        # Step 1: 計画生成
        plan = await self._generate_plan(client, messages, settings)
        steps = plan.get("steps", [])
        reasoning = plan.get("reasoning", "")

        # 単一ステップかつチャット型なら通常フローにフォールバック
        if len(steps) <= 1 and (not steps or steps[0].get("type") == "chat"):
            call_kwargs: dict = {
                "model": settings.model,
                "messages": messages,
                "stream": True,
            }
            if self._supports_tool_calling(settings.model):
                import copy
                call_kwargs["tools"] = copy.deepcopy(TOOLS)
                call_kwargs["tool_choice"] = "auto"
            agent = AgentLoop(
                client=client,
                tool_executor=tool_executor,
                model=settings.model,
                max_rounds=5,
                context_builder=context_builder,
            )
            async for event in agent.run(messages, call_kwargs):
                yield event
            return

        # 複数ステップの計画を SSE で通知
        yield self._sse("plan", {"steps": steps, "reasoning": reasoning})

        # Step 2: 各ステップを順次実行
        for i, step in enumerate(steps):
            step_type = step.get("type", "chat")
            step_desc = step.get("description", "")
            yield self._sse("plan_step_start", {"step": i, "description": step_desc})

            # ステップごとに最新プロジェクト状態でメッセージを再構築
            if project_service and project_id:
                try:
                    project = await project_service.get_project(project_id)
                    tool_executor._project = project
                except Exception:
                    pass  # 失敗しても既存の project で続行

            # ステップ種別に応じてコマンドを設定
            step_command = None
            step_command_args: list[str] = []
            if step_type == "structure":
                step_command = f"structure-{step.get('mode', 'replace')}"
            elif step_type in ("draft", "rewrite", "expand"):
                step_command = step_type
            elif step_type == "fetch_sources":
                step_command = None  # チャットモードで fetch_sources ツールを使わせる
            # review や chat は step_command = None のまま

            step_messages = self._build_messages(
                project, settings, user_message, context_scope,
                command=step_command,
                command_args=step_command_args,
                explicit_refs=explicit_refs,
                selected_text=selected_text,
            )

            import copy
            step_call_kwargs: dict = {
                "model": settings.model,
                "messages": step_messages,
                "stream": True,
            }

            if self._supports_tool_calling(settings.model):
                tools_copy = copy.deepcopy(TOOLS)
                step_call_kwargs["tools"] = tools_copy
                step_call_kwargs["tool_choice"] = "auto"

                if step_command and step_command.startswith("structure"):
                    command_mode = self._normalize_command(step_command, step_command_args)
                    mode = command_mode["mode"]
                    if mode == "replace":
                        target = "set_document_structure"
                        step_call_kwargs["tools"] = [t for t in tools_copy if t["function"]["name"] == target]
                        step_call_kwargs["tool_choice"] = {"type": "function", "function": {"name": target}}
                    elif mode == "add":
                        target = "create_sections_under_parent"
                        step_call_kwargs["tools"] = [t for t in tools_copy if t["function"]["name"] == target]
                        step_call_kwargs["tool_choice"] = {"type": "function", "function": {"name": target}}

            # リフレクション（draft / rewrite / expand ステップのみ）
            step_reflection = None
            if step_type in ("draft", "rewrite", "expand"):
                refl_template = self._load_template("reflection.jinja2")
                step_reflection = refl_template.render(command=step_type)

            step_agent = AgentLoop(
                client=client,
                tool_executor=tool_executor,
                model=settings.model,
                max_rounds=5,
                context_builder=context_builder,
                reflection_prompt=step_reflection,
            )
            async for event in step_agent.run(step_messages, step_call_kwargs):
                # done イベントはステップ完了後に plan_step_done に変換するためスキップ
                try:
                    payload = json.loads(event.removeprefix("data: ").strip())
                    if payload.get("type") == "done":
                        continue
                except (json.JSONDecodeError, AttributeError):
                    pass
                yield event

            yield self._sse("plan_step_done", {"step": i})

        yield self._sse("done", {})


class _SystemContextBuilder:
    """AgentLoop のコンテキスト再注入用ビルダー（Phase 4）。

    各ラウンドで最新のプロジェクト状態を system メッセージに反映する。
    """

    def __init__(
        self,
        llm_service: LLMService,
        project: Project,
        settings: LLMSettings,
        context_scope: str,
    ):
        self._llm_service = llm_service
        self._settings = settings
        self._context_scope = context_scope

    def build_system(self, project: Project) -> str:
        """最新の project 状態を元に system プロンプトを再生成する。"""
        sorted_sections = _sort_sections_hierarchically(project.sections)
        enabled_rules = [r for r in project.rules if r.enabled]
        source_summaries = [
            {
                "id": s.id,
                "name": s.name,
                "summary": s.summary,
                "include_in_references": s.bibliography.include_in_references,
            }
            for s in project.sources
            if s.summary
        ]
        system_template = self._llm_service._load_template("chat_system.jinja2")
        return system_template.render(
            enabled_rules=enabled_rules,
            sections=sorted_sections,
            source_summaries=source_summaries,
            max_fetch_source_count=self._settings.max_fetch_source_count,
        )
