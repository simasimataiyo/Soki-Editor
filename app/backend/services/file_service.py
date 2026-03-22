"""FileService — ファイル読み込み・サムネイル生成・ダイアログ"""
from __future__ import annotations

import asyncio
import io
import logging
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Optional

logger = logging.getLogger(__name__)

# ソース読込の対応形式
SOURCE_TEXT_EXTENSIONS = frozenset({".txt", ".md", ".pdf", ".csv", ".docx", ".xlsx", ".pptx"})
MATERIAL_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"})

if TYPE_CHECKING:
    from app.backend.services.project_service import ProjectService


class FileService:
    """ファイル変換、サムネイル生成を担う。"""

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

    async def create_source_from_file(
        self, project_service: ProjectService, project_id: str, path: Path
    ) -> object:
        """ファイルから Source エントリを作成し、テキスト抽出・PDF画像生成を行う。"""
        from app.backend.models import SourceUpdate
        from app.backend.routers.settings import get_service as get_settings_service
        from app.backend.services.project_service import ProjectService

        src = await project_service.add_source(project_id)
        stem = path.stem
        await project_service.update_source(
            project_id,
            src.id,
            SourceUpdate(name=stem, file_path=str(path)),
        )

        suffix = path.suffix.lower()
        file_type = "pdf" if suffix == ".pdf" else suffix.lstrip(".") or "text"

        text = ""
        try:
            text = await self.read_file_as_text(str(path))
        except Exception:
            logger.exception("テキスト抽出失敗: %s", path)

        if suffix == ".pdf":
            try:
                project = await project_service.get_project(project_id)
                src_meta_dir = ProjectService._source_metadata_dir(project, src.id)
                page_dir = src_meta_dir / "page"
                thumb_dir = src_meta_dir / "thumbnails"
                page_dir.mkdir(parents=True, exist_ok=True)
                thumb_dir.mkdir(parents=True, exist_ok=True)
                raw_dpi = get_settings_service().get().pdf_page_dpi
                await asyncio.to_thread(
                    self._gen_pdf_images, str(path), str(thumb_dir), str(page_dir), raw_dpi
                )
            except Exception:
                logger.exception("PDF 画像生成失敗: %s", path)

        src = await project_service.update_source(
            project_id,
            src.id,
            SourceUpdate(full_text=text, file_path=str(path), file_type=file_type),
        )
        return src

    async def create_material_from_file(
        self, project_service: ProjectService, project_id: str, path: Path
    ) -> object:
        """ファイルから Material エントリを作成し、サムネイルを生成する。"""
        from app.backend.models import MaterialUpdate
        from app.backend.services.project_service import ProjectService

        mat = await project_service.add_material(project_id)

        stem = path.stem
        await project_service.update_material(
            project_id,
            mat.id,
            MaterialUpdate(name=stem, file_path=str(path)),
        )

        thumb_path = None
        try:
            project = await project_service.get_project(project_id)
            thumb_dir = ProjectService._material_metadata_dir(project, mat.id)
            thumb_dir.mkdir(parents=True, exist_ok=True)
            thumb_dest = str(thumb_dir / f"{mat.id}_thumb.png")
            thumb_path = await self.generate_thumbnail_to(str(path), thumb_dest)
        except Exception:
            logger.exception("サムネイル生成失敗: %s", path)

        mat = await project_service.update_material(
            project_id, mat.id, MaterialUpdate(thumbnail_path=thumb_path)
        )
        return mat

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
            img = Image.open(io.BytesIO(image_bytes))
        else:
            img = Image.open(str(path))

        img.thumbnail(size, Image.LANCZOS)
        img.save(str(thumb_path), "PNG")
        return str(thumb_path)

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

