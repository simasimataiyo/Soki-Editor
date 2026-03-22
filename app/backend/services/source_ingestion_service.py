"""SourceIngestionService — ソースファイル取り込みパイプライン"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

from app.backend.models import SourceUpdate
from app.backend.services.file_service import FileService

if TYPE_CHECKING:
    from app.backend.models import LLMSettings, Project  # noqa: F401
    from app.backend.services.project_service import ProjectService

logger = logging.getLogger(__name__)

_IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"})

_instance: SourceIngestionService | None = None


def get_source_ingestion_service() -> SourceIngestionService:
    global _instance
    if _instance is None:
        _instance = SourceIngestionService()
    return _instance


def set_source_ingestion_service(svc: SourceIngestionService) -> None:
    global _instance
    _instance = svc


class SourceIngestionService:
    """ソースファイルの保存・テキスト抽出・PDF画像生成を統一入口として提供する。"""

    def __init__(self) -> None:
        self._file_service = FileService()

    async def add_source_from_upload(
        self,
        project_id: str,
        project: Project,
        source_id: str,
        file_bytes: bytes,
        filename: str,
        settings: LLMSettings,
    ) -> object:
        """アップロードされたバイト列からソースを更新する。
        保存 → テキスト抽出 → PDF画像生成 → update_source の順で処理する。"""
        from app.backend.services.project_service import ProjectService

        svc = self._get_project_service()
        suffix = Path(filename).suffix.lower()
        file_type = self._detect_file_type(suffix)

        # sources/{source_id}_{filename} に保存
        project_dir = ProjectService.get_project_dir(project)
        sources_dir = project_dir / "sources"
        sources_dir.mkdir(parents=True, exist_ok=True)
        self._file_service.delete_related_files(sources_dir, source_id)
        saved_path = sources_dir / f"{source_id}_{Path(filename).name}"
        self._file_service.save_bytes_to_path(file_bytes, saved_path)

        return await self._run_pipeline(project_id, project, source_id, saved_path, file_type, settings)

    async def add_source_from_path(
        self,
        project_id: str,
        project: Project,
        file_path: Path,
        settings: LLMSettings,
    ) -> object:
        """既存パスのファイルからソースエントリを新規作成する。
        add_source で採番 → コピー保存 → パイプライン処理。"""
        from app.backend.services.project_service import ProjectService

        if not file_path.exists():
            raise FileNotFoundError(f"ファイルが見つかりません: {file_path}")

        svc = self._get_project_service()
        src = await svc.add_source(project_id)
        source_id = src.id

        project_dir = ProjectService.get_project_dir(project)
        sources_dir = project_dir / "sources"
        sources_dir.mkdir(parents=True, exist_ok=True)
        if self._is_under_dir(file_path, sources_dir):
            dest_path = file_path
        else:
            dest_path = sources_dir / f"{source_id}_{file_path.name}"
            self._file_service.copy_file_to_path(file_path, dest_path)

        suffix = file_path.suffix.lower()
        file_type = self._detect_file_type(suffix)

        # name をファイルのstemで初期化
        await svc.update_source(project_id, source_id, SourceUpdate(name=file_path.stem))

        return await self._run_pipeline(project_id, project, source_id, dest_path, file_type, settings)

    # ------------------------------------------------------------------
    # 内部ヘルパー
    # ------------------------------------------------------------------

    async def _run_pipeline(
        self,
        project_id: str,
        project: object,
        source_id: str,
        saved_path: Path,
        file_type: str,
        settings: LLMSettings,
    ) -> object:
        """テキスト抽出 → PDF画像生成 → update_source。"""
        from app.backend.services.project_service import ProjectService

        svc = self._get_project_service()

        # PDFの場合: サムネイルと等倍画像を metadata/sources/{id}/ に保存
        if file_type == "pdf":
            # プロジェクトを最新状態で再取得（コピー後にproject参照が変わることがある）
            current_project = await svc.get_project(project_id)
            src_meta_dir = ProjectService.get_source_metadata_dir(current_project, source_id)
            page_dir = src_meta_dir / "page"
            thumb_dir = src_meta_dir / "thumbnails"
            self._file_service.safe_rmtree(page_dir)
            self._file_service.safe_rmtree(thumb_dir)
            page_dir.mkdir(parents=True, exist_ok=True)
            thumb_dir.mkdir(parents=True, exist_ok=True)
            try:
                await self._file_service.generate_pdf_images(
                    str(saved_path), str(thumb_dir), str(page_dir), settings.pdf_page_dpi
                )
            except Exception:
                logger.warning("PDF 画像生成失敗（継続）: %s", saved_path)

        # テキスト抽出
        text = ""
        try:
            text = await self._file_service.read_file_as_text(str(saved_path))
        except Exception:
            logger.warning("テキスト抽出失敗（継続）: %s", saved_path)

        return await svc.update_source(
            project_id,
            source_id,
            SourceUpdate(full_text=text, file_path=str(saved_path), file_type=file_type),
        )

    @staticmethod
    def _detect_file_type(suffix: str) -> str:
        if suffix == ".pdf":
            return "pdf"
        if suffix in _IMAGE_SUFFIXES:
            return "image"
        return suffix.lstrip(".") or "text"

    @staticmethod
    def _is_under_dir(path: Path, root_dir: Path) -> bool:
        try:
            path.resolve(strict=False).relative_to(root_dir.resolve(strict=False))
            return True
        except ValueError:
            return False

    def _get_project_service(self) -> ProjectService:
        from app.backend.routers.projects import get_service
        return get_service()
