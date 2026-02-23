"""FileService — ファイル読み込み・画像解析・サムネイル生成・ダイアログ"""
from __future__ import annotations

import asyncio
import base64
import logging
import uuid
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_SUPPORTED_TEXT_EXTENSIONS = {".txt", ".md", ".pdf", ".csv", ".docx", ".xlsx", ".pptx"}


class FileService:
    """ファイル変換、Vision API 解析、サムネイル生成を担う。"""

    async def read_file_as_text(self, file_path: str) -> str:
        """markitdown で .txt/.md/.pdf/.csv 等を Markdown テキストに変換する。"""
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"ファイルが見つかりません: {file_path}")

        suffix = path.suffix.lower()
        if suffix not in _SUPPORTED_TEXT_EXTENSIONS:
            raise ValueError(f"非対応のファイル形式です: {suffix}")

        result = await asyncio.to_thread(self._convert_with_markitdown, str(path))
        return result

    async def analyze_image_with_vision(
        self, file_path: str, settings
    ) -> str:
        """Vision API（GPT-4o Vision）で画像/PDF を解析してテキストを返す。"""
        from openai import AsyncOpenAI

        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"ファイルが見つかりません: {file_path}")

        # PDF の場合は 1 ページ目を画像として抽出
        suffix = path.suffix.lower()
        if suffix == ".pdf":
            image_bytes = await asyncio.to_thread(self._extract_pdf_first_page, str(path))
            media_type = "image/png"
        else:
            image_bytes = path.read_bytes()
            media_type = self._get_media_type(suffix)

        image_b64 = base64.b64encode(image_bytes).decode()

        client_kwargs = {"api_key": settings.api_key or "dummy"}
        if settings.endpoint_url:
            client_kwargs["base_url"] = settings.endpoint_url

        client = AsyncOpenAI(**client_kwargs)
        response = await client.chat.completions.create(
            model=settings.model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{media_type};base64,{image_b64}"
                            },
                        },
                        {
                            "type": "text",
                            "text": "この画像の内容を詳しく説明してください。",
                        },
                    ],
                }
            ],
        )
        return response.choices[0].message.content or ""

    async def analyze_image_bytes_with_vision(
        self,
        image_bytes: bytes,
        media_type: str,
        settings,
        prompt_text: str = "この画像の内容を詳しく説明してください。",
    ) -> str:
        """バイト列の画像をVision APIで解析してテキストを返す。"""
        from openai import AsyncOpenAI

        image_b64 = base64.b64encode(image_bytes).decode()

        client_kwargs = {"api_key": settings.api_key or "dummy"}
        if settings.endpoint_url:
            client_kwargs["base_url"] = settings.endpoint_url

        client = AsyncOpenAI(**client_kwargs)
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

    async def analyze_image_bytes_with_vision_stream(
        self,
        image_bytes: bytes,
        media_type: str,
        settings,
        prompt_text: str = "この画像の内容を詳しく説明してください。",
    ):
        """バイト列の画像をVision APIで解析してテキストをストリーミングで返す非同期ジェネレータ。"""
        from openai import AsyncOpenAI

        image_b64 = base64.b64encode(image_bytes).decode()

        client_kwargs = {"api_key": settings.api_key or "dummy"}
        if settings.endpoint_url:
            client_kwargs["base_url"] = settings.endpoint_url

        client = AsyncOpenAI(**client_kwargs)
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

    async def generate_thumbnail(
        self,
        file_path: str,
        dest_dir: str,
        size: tuple[int, int] = (200, 200),
    ) -> str:
        """画像または PDF 1 ページ目からサムネイルを生成して dest_dir に保存。パスを返す。"""
        return await asyncio.to_thread(
            self._generate_thumbnail_sync, file_path, dest_dir, size
        )

    def open_file_dialog(
        self, file_types: Optional[list[tuple[str, str]]] = None
    ) -> Optional[str]:
        """pywebview のネイティブファイル開くダイアログを開く。"""
        try:
            import webview

            window = webview.windows[0] if webview.windows else None
            if window is None:
                return None
            kwargs = {}
            if file_types:
                kwargs["file_types"] = [f"{desc} ({ext})" for desc, ext in file_types]
            result = window.create_file_dialog(webview.OPEN_DIALOG, **kwargs)
            if result and len(result) > 0:
                return result[0]
            return None
        except Exception as e:
            logger.warning("ファイルダイアログ失敗: %s", e)
            return None

    def save_file_dialog(self, default_filename: str = "") -> Optional[str]:
        """pywebview のネイティブファイル保存ダイアログを開く。"""
        try:
            import webview

            window = webview.windows[0] if webview.windows else None
            if window is None:
                return None
            result = window.create_file_dialog(
                webview.FileDialog.SAVE,
                save_filename=default_filename,
            )
            if result:
                return result if isinstance(result, str) else result[0]
            return None
        except Exception as e:
            logger.warning("保存ダイアログ失敗: %s", e)
            return None

    def open_directory_dialog(self) -> Optional[str]:
        """pywebview のネイティブフォルダ選択ダイアログを開く。"""
        try:
            import webview

            window = webview.windows[0] if webview.windows else None
            if window is None:
                return None
            result = window.create_file_dialog(webview.FOLDER_DIALOG)
            if result and len(result) > 0:
                return result[0]
            return None
        except Exception as e:
            logger.warning("フォルダダイアログ失敗: %s", e)
            return None

    # ------------------------------------------------------------------
    # 内部ヘルパー（同期）
    # ------------------------------------------------------------------

    def _convert_with_markitdown(self, file_path: str) -> str:
        from markitdown import MarkItDown

        md = MarkItDown()
        result = md.convert(file_path)
        return result.text_content

    def _generate_thumbnail_sync(
        self, file_path: str, dest_dir: str, size: tuple[int, int]
    ) -> str:
        from PIL import Image

        path = Path(file_path)
        dest = Path(dest_dir)
        dest.mkdir(parents=True, exist_ok=True)
        thumb_name = f"{uuid.uuid4().hex[:8]}_thumb.png"
        thumb_path = dest / thumb_name

        suffix = path.suffix.lower()
        if suffix == ".pdf":
            image_bytes = self._extract_pdf_first_page(str(path))
            import io

            img = Image.open(io.BytesIO(image_bytes))
        else:
            img = Image.open(str(path))

        img.thumbnail(size, Image.LANCZOS)
        img.save(str(thumb_path), "PNG")
        return str(thumb_path)

    def _extract_pdf_first_page(self, file_path: str) -> bytes:
        import io

        import fitz  # PyMuPDF

        doc = fitz.open(file_path)
        page = doc.load_page(0)
        pix = page.get_pixmap(dpi=150)
        from PIL import Image

        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def _get_media_type(self, suffix: str) -> str:
        mapping = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        }
        return mapping.get(suffix, "image/png")
