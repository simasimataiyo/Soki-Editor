"""マテリアル管理 API ルーター"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile

from app.backend.models import Material, MaterialUpdate, MaterialsReorder
from app.backend.routers.projects import get_service
from app.backend.services.file_service import FileService
from app.backend.services.project_service import ProjectService

router = APIRouter(prefix="/api/projects/{project_id}", tags=["materials"])
_file_service = FileService()


def _not_found(project_id: str):
    raise HTTPException(status_code=404, detail=f"プロジェクトが見つかりません: {project_id}")


async def _get_project_or_404(svc, project_id: str):
    try:
        return await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass


def _safe_rmtree(path: Path) -> None:
    if not path.exists():
        return
    import shutil
    try:
        shutil.rmtree(path)
    except Exception:
        pass


def _delete_related_files(base_dir: Path, item_id: str) -> None:
    for old in list(base_dir.glob(f"{item_id}_*")) + list(base_dir.glob(f"{item_id}.*")):
        _safe_unlink(old)


@router.post("/materials/reorder")
async def reorder_materials(project_id: str, body: MaterialsReorder) -> dict:
    svc = get_service()
    try:
        await svc.reorder_materials(project_id, body.ordered_ids)
        return {"status": "ok"}
    except KeyError:
        _not_found(project_id)


@router.get("/materials", response_model=list[Material])
async def list_materials(project_id: str) -> list[Material]:
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)
    return project.materials


@router.post("/materials", response_model=Material)
async def create_material(project_id: str) -> Material:
    svc = get_service()
    try:
        return await svc.add_material(project_id)
    except KeyError:
        _not_found(project_id)


@router.put("/materials/{mat_id}", response_model=Material)
async def update_material(project_id: str, mat_id: str, body: MaterialUpdate) -> Material:
    svc = get_service()
    try:
        return await svc.update_material(project_id, mat_id, body)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/materials/{mat_id}")
async def delete_material(project_id: str, mat_id: str) -> dict:
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)

    mat = next((m for m in project.materials if m.id == mat_id), None)

    try:
        await svc.delete_material(project_id, mat_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # 関連ファイルをディスクから削除
    if mat:
        # 実ファイル削除
        if mat.file_path:
            _safe_unlink(Path(mat.file_path))
        # materials/{mat_id}_* の残骸も削除
        materials_dir = ProjectService._project_dir(project) / "materials"
        _delete_related_files(materials_dir, mat_id)
        # v3: metadata/materials/{id}/ ディレクトリを丸ごと削除
        meta_dir = ProjectService._material_metadata_dir(project, mat_id)
        _safe_rmtree(meta_dir)

    return {"status": "ok"}


@router.post("/materials/{mat_id}/upload", response_model=Material)
async def upload_material_file(
    project_id: str, mat_id: str, file: UploadFile
) -> Material:
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)

    # 画像形式のみ受け付ける
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(status_code=400, detail="画像ファイル（jpg, png, bmp など）のみアップロードできます")

    # v3: materials/{mat_id}_{original_filename} に保存
    project_dir = ProjectService._project_dir(project)
    materials_dir = project_dir / "materials"
    materials_dir.mkdir(parents=True, exist_ok=True)
    original_name = Path(file.filename or "file").name
    # 既存の関連ファイルを削除（拡張子変更時の残骸対策）
    _delete_related_files(materials_dir, mat_id)
    dest_path = materials_dir / f"{mat_id}_{original_name}"
    dest_path.write_bytes(await file.read())

    # v3: サムネイルを metadata/materials/{id}/{mat_id}_thumb.png に生成
    thumb_dir = ProjectService._material_metadata_dir(project, mat_id)
    thumb_dir.mkdir(parents=True, exist_ok=True)
    thumb_dest = str(thumb_dir / f"{mat_id}_thumb.png")
    try:
        thumb_path = await _file_service.generate_thumbnail_to(
            str(dest_path), thumb_dest
        )
    except Exception:
        thumb_path = None

    return await svc.update_material(
        project_id,
        mat_id,
        MaterialUpdate(
            file_path=str(dest_path),
            thumbnail_path=thumb_path,
        ),
    )
