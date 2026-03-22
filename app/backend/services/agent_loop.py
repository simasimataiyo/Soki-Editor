"""AgentLoop — LLM ツールコール → 解決 → 再呼び出しの汎用ループ"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator

from app.backend.services.tool_executor import ToolExecutor

logger = logging.getLogger(__name__)


class AgentLoop:
    """LLM ツールコール → 解決 → 再呼び出しの汎用ループ"""

    def __init__(
        self,
        client,                          # AsyncOpenAI クライアント
        tool_executor: ToolExecutor,
        model: str,
        max_rounds: int = 5,
        context_builder=None,            # オプション: コンテキスト再注入用（Phase 4）
        reflection_prompt: str | None = None,  # オプション: リフレクション用（Phase 6）
    ):
        self._client = client
        self._tool_executor = tool_executor
        self._model = model
        self._max_rounds = max_rounds
        self._context_builder = context_builder
        self._reflection_prompt = reflection_prompt
        self._reflection_done = False

    async def run(
        self,
        messages: list[dict],
        call_kwargs: dict,
    ) -> AsyncGenerator[str, None]:
        """SSE ペイロード文字列を yield するエージェントループ"""

        for round_num in range(self._max_rounds):
            # ラウンド2以降: system メッセージのアウトラインを最新化（Phase 4）
            if round_num > 0 and self._context_builder:
                await self._refresh_system_context(messages)

            stream = await self._call_with_retry(call_kwargs)

            text_chunks: list[str] = []
            tool_calls: list[dict] = []

            async for event_type, data in self._iter_stream_events(stream):
                if event_type == "chunk":
                    yield self._sse("chunk", data)
                    text_chunks.append(data["text"])
                elif event_type == "tool_call":
                    tool_calls.append(data)

            if not tool_calls:
                # リフレクションが有効で未実行なら追加ラウンド
                if self._reflection_prompt and not self._reflection_done:
                    yield self._sse("reflection_start", {})
                    messages.append({
                        "role": "user",
                        "content": self._reflection_prompt,
                    })
                    self._reflection_done = True
                    continue
                break

            # assistant メッセージを追加
            assistant_tool_calls = [
                {
                    "id": tc["id"],
                    "type": "function",
                    "function": {
                        "name": tc["tool"],
                        "arguments": json.dumps(tc["args"], ensure_ascii=False),
                    },
                }
                for tc in tool_calls
            ]
            messages.append({
                "role": "assistant",
                "content": "".join(text_chunks) or None,
                "tool_calls": assistant_tool_calls,
            })

            # ツール実行
            has_backend = False
            has_frontend = False

            for tc in tool_calls:
                result = await self._tool_executor.execute(tc)

                # SSE イベントをフロントエンドに配信
                for event in result.sse_events:
                    yield self._sse(event["type"], event.get("data", {}))

                # ツール結果を messages に追加（フィードバック強化済み）
                messages.append({
                    "role": "tool",
                    "tool_call_id": result.tool_call_id,
                    "content": result.content,
                })

                if result.is_backend_only:
                    has_backend = True
                else:
                    has_frontend = True

            call_kwargs["messages"] = messages

            if has_backend:
                logger.info(
                    "バックエンドツール ラウンド %d 完了、再呼び出し", round_num + 1
                )
            if has_frontend and not has_backend:
                # フロントエンドツールのみ: 次ラウンドはサマリ生成専用なのでツール禁止
                call_kwargs["tool_choice"] = "none"
                logger.info(
                    "フロントエンドツール実行完了、サマリ生成のための追加呼び出し (%d / %d)",
                    round_num + 1, self._max_rounds,
                )

        yield self._sse("done", {})

    async def _refresh_system_context(self, messages: list[dict]) -> None:
        """system メッセージ内のセクションアウトラインを最新状態に更新する（Phase 4）"""
        project = await self._tool_executor.get_latest_project()
        updated_system = self._context_builder.build_system(project)
        if messages and messages[0]["role"] == "system":
            messages[0]["content"] = updated_system

    async def _call_with_retry(self, call_kwargs: dict, max_retries: int = 3):
        """レートリミット(429)時に指数バックオフでリトライする。"""
        from openai import RateLimitError

        wait = 5.0
        for attempt in range(max_retries):
            try:
                return await self._client.chat.completions.create(**call_kwargs)
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

    @staticmethod
    def _sse(event_type: str, data: dict) -> str:
        return f"data: {json.dumps({'type': event_type, **data}, ensure_ascii=False)}\n\n"
