"""マテリアル管理 API ルーター"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile

from app.backend.models import Material, MaterialUpdate, MaterialsReorder
from app.backend.routers.deps import get_project_or_404 as _get_project_or_404, not_found as _not_found
from app.backend.routers.projects import get_service
from app.backend.services.file_service import FileService
from app.backend.services.material_ingestion_service import get_material_ingestion_service
from app.backend.services.project_service import ProjectService

router = APIRouter(prefix="/api/projects/{project_id}", tags=["materials"])
_file_service = FileService()


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
            _file_service.safe_unlink(Path(mat.file_path))
        # materials/{mat_id}_* の残骸も削除
        materials_dir = ProjectService.get_project_dir(project) / "materials"
        _file_service.delete_related_files(materials_dir, mat_id)
        # v3: metadata/materials/{id}/ ディレクトリを丸ごと削除
        meta_dir = ProjectService.get_material_metadata_dir(project, mat_id)
        _file_service.safe_rmtree(meta_dir)

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

    filename = Path(file.filename or "file").name
    content = await file.read()

    return await get_material_ingestion_service().add_material_from_upload(
        project_id, project, mat_id, content, filename
    )
