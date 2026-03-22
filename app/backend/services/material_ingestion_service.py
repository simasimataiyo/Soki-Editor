"""MaterialIngestionService — マテリアルファイル取り込みパイプライン"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

from app.backend.models import MaterialUpdate
from app.backend.services.file_service import FileService

if TYPE_CHECKING:
    from app.backend.models import Project
    from app.backend.services.project_service import ProjectService

logger = logging.getLogger(__name__)

_instance: MaterialIngestionService | None = None


def get_material_ingestion_service() -> MaterialIngestionService:
    global _instance
    if _instance is None:
        _instance = MaterialIngestionService()
    return _instance


def set_material_ingestion_service(svc: MaterialIngestionService) -> None:
    global _instance
    _instance = svc


class MaterialIngestionService:
    """マテリアルファイルの保存・サムネイル生成を統一入口として提供する。"""

    def __init__(self) -> None:
        self._file_service = FileService()

    async def add_material_from_upload(
        self,
        project_id: str,
        project: Project,
        mat_id: str,
        file_bytes: bytes,
        filename: str,
    ) -> object:
        """アップロードされたバイト列からマテリアルを更新する。
        保存 → サムネイル生成 → update_material の順で処理する。"""
        from app.backend.services.project_service import ProjectService

        svc = self._get_project_service()

        project_dir = ProjectService.get_project_dir(project)
        materials_dir = project_dir / "materials"
        materials_dir.mkdir(parents=True, exist_ok=True)
        original_name = Path(filename).name
        self._file_service.delete_related_files(materials_dir, mat_id)
        dest_path = materials_dir / f"{mat_id}_{original_name}"
        self._file_service.save_bytes_to_path(file_bytes, dest_path)

        return await self._run_pipeline(project_id, project, mat_id, dest_path)

    async def add_material_from_path(
        self,
        project_id: str,
        project: Project,
        file_path: Path,
    ) -> object:
        """既存パスのファイルからマテリアルエントリを新規作成する。
        add_material で採番 → コピー保存 → パイプライン処理。"""
        from app.backend.services.project_service import ProjectService

        if not file_path.exists():
            raise FileNotFoundError(f"ファイルが見つかりません: {file_path}")

        svc = self._get_project_service()
        mat = await svc.add_material(project_id)
        mat_id = mat.id

        project_dir = ProjectService.get_project_dir(project)
        materials_dir = project_dir / "materials"
        materials_dir.mkdir(parents=True, exist_ok=True)
        if self._is_under_dir(file_path, materials_dir):
            dest_path = file_path
        else:
            dest_path = materials_dir / f"{mat_id}_{file_path.name}"
            self._file_service.copy_file_to_path(file_path, dest_path)

        # name をファイルのstemで初期化
        await svc.update_material(project_id, mat_id, MaterialUpdate(name=file_path.stem))

        return await self._run_pipeline(project_id, project, mat_id, dest_path)

    # ------------------------------------------------------------------
    # 内部ヘルパー
    # ------------------------------------------------------------------

    async def _run_pipeline(
        self,
        project_id: str,
        project: object,
        mat_id: str,
        dest_path: Path,
    ) -> object:
        """サムネイル生成 → update_material。"""
        from app.backend.services.project_service import ProjectService

        svc = self._get_project_service()
        current_project = await svc.get_project(project_id)
        thumb_dir = ProjectService.get_material_metadata_dir(current_project, mat_id)
        thumb_dir.mkdir(parents=True, exist_ok=True)
        thumb_dest = str(thumb_dir / f"{mat_id}_thumb.png")

        thumb_path = None
        try:
            thumb_path = await self._file_service.generate_thumbnail_to(str(dest_path), thumb_dest)
        except Exception:
            logger.warning("サムネイル生成失敗（thumbnail_path=None で継続）: %s", dest_path)

        return await svc.update_material(
            project_id,
            mat_id,
            MaterialUpdate(file_path=str(dest_path), thumbnail_path=thumb_path),
        )

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
