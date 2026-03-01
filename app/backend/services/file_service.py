"""FileService — ファイル読み込み・サムネイル生成・ダイアログ"""
from __future__ import annotations

import asyncio
import io
import logging
import uuid
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_SUPPORTED_TEXT_EXTENSIONS = {".txt", ".md", ".pdf", ".csv", ".docx", ".xlsx", ".pptx"}


class FileService:
    """ファイル変換、サムネイル生成を担う。"""

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
            result = window.create_file_dialog(webview.FileDialog.OPEN, **kwargs)
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
            result = window.create_file_dialog(webview.FileDialog.FOLDER)
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

