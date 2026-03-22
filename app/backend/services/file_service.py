"""FileService — ファイル読み込み・サムネイル生成・ダイアログ"""
from __future__ import annotations

import asyncio
import io
import logging
import uuid
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ソース読込の対応形式
SOURCE_TEXT_EXTENSIONS = frozenset({".txt", ".md", ".pdf", ".csv", ".docx", ".xlsx", ".pptx"})
MATERIAL_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"})


class FileService:
    """ファイル変換、サムネイル生成を担う。"""

    def save_bytes_to_path(self, file_bytes: bytes, dest_path: Path) -> None:
        """バイト列を指定パスに保存する。親ディレクトリが存在しない場合は作成する。"""
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(file_bytes)

    def copy_file_to_path(self, src_path: Path, dest_path: Path) -> None:
        """ファイルを指定パスにコピーする。親ディレクトリが存在しない場合は作成する。"""
        import shutil
        if not src_path.exists():
            raise FileNotFoundError(f"コピー元ファイルが見つかりません: {src_path}")
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(src_path), str(dest_path))

    def safe_unlink(self, path: Path | str) -> None:
        """ファイル削除。失敗時は握りつぶす。"""
        try:
            Path(path).unlink(missing_ok=True)
        except Exception:
            logger.debug("ファイル削除失敗: %s", path)

    def safe_rmtree(self, path: Path | str) -> None:
        """ディレクトリ削除。失敗時は握りつぶす。"""
        target = Path(path)
        if not target.exists():
            return
        import shutil

        try:
            shutil.rmtree(target)
        except Exception:
            logger.debug("ディレクトリ削除失敗: %s", path)

    def delete_related_files(self, base_dir: Path | str, item_id: str) -> None:
        """`{item_id}_*` および `{item_id}.*` 形式の関連ファイルを削除する。"""
        base = Path(base_dir)
        for old in list(base.glob(f"{item_id}_*")) + list(base.glob(f"{item_id}.*")):
            self.safe_unlink(old)

    async def read_file_as_text(self, file_path: str) -> str:
        """markitdown で .txt/.md/.pdf/.csv 等を Markdown テキストに変換する。"""
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"ファイルが見つかりません: {file_path}")

        suffix = path.suffix.lower()
        if suffix not in SOURCE_TEXT_EXTENSIONS:
            raise ValueError(f"非対応のファイル形式です: {suffix}")

        result = await asyncio.to_thread(self._convert_with_markitdown, str(path))
        return result

    async def generate_thumbnail_to(
        self,
        file_path: str,
        dest_path: str,
        size: tuple[int, int] = (200, 200),
    ) -> str:
        """画像または PDF 1 ページ目からサムネイルを生成して指定パスに保存。パスを返す。"""
        return await asyncio.to_thread(
            self._generate_thumbnail_to_sync, file_path, dest_path, size
        )

    async def generate_pdf_images(
        self, file_path: str, thumb_dir: str, page_dir: str, dpi: int
    ) -> None:
        """PDF 各ページのサムネイルと等倍画像を生成する。"""
        await asyncio.to_thread(self._gen_pdf_images, file_path, thumb_dir, page_dir, dpi)

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

    def _generate_thumbnail_to_sync(
        self, file_path: str, dest_path: str, size: tuple[int, int]
    ) -> str:
        from PIL import Image

        path = Path(file_path)
        dest = Path(dest_path)
        dest.parent.mkdir(parents=True, exist_ok=True)

        suffix = path.suffix.lower()
        if suffix == ".pdf":
            image_bytes = self._extract_pdf_first_page(str(path))
            img = Image.open(io.BytesIO(image_bytes))
        else:
            img = Image.open(str(path))

        img.thumbnail(size, Image.LANCZOS)
        img.save(str(dest), "PNG")
        return str(dest)

    def _extract_pdf_first_page(self, pdf_path: str) -> bytes:
        import fitz  # PyMuPDF

        doc = fitz.open(pdf_path)
        page = doc.load_page(0)
        pix = page.get_pixmap()
        return pix.tobytes("png")

    def _gen_pdf_images(self, path_str: str, td: str, pd: str, dpi: int) -> None:
        import fitz

        doc = fitz.open(path_str)
        try:
            for i in range(len(doc)):
                pg = doc.load_page(i)
                pg.get_pixmap(dpi=72).save(str(Path(td) / f"page_{i}.jpg"))
                pg.get_pixmap(dpi=dpi).save(str(Path(pd) / f"page_raw_{i}.jpg"))
        finally:
            doc.close()

