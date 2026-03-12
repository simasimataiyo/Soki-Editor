"""マテリアル管理 API ルーター"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile

from app.backend.models import Material, MaterialUpdate, MaterialsReorder
from app.backend.routers.projects import get_service
from app.backend.services.file_service import FileService

router = APIRouter(prefix="/api/projects/{project_id}", tags=["materials"])
_file_service = FileService()


def _not_found(project_id: str):
    raise HTTPException(status_code=404, detail=f"プロジェクトが見つかりません: {project_id}")


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
    try:
        project = await svc.get_project(project_id)
        return project.materials
    except KeyError:
        _not_found(project_id)


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
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    mat = next((m for m in project.materials if m.id == mat_id), None)

    try:
        await svc.delete_material(project_id, mat_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # 関連ファイルをディスクから削除
    if mat:
        for file_path in (mat.file_path, mat.thumbnail_path):
            if file_path:
                try:
                    Path(file_path).unlink(missing_ok=True)
                except Exception:
                    pass

    return {"status": "ok"}


@router.post("/materials/{mat_id}/upload", response_model=Material)
async def upload_material_file(
    project_id: str, mat_id: str, file: UploadFile
) -> Material:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    # 画像形式のみ受け付ける
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(status_code=400, detail="画像ファイル（jpg, png, bmp など）のみアップロードできます")

    # v2: プロジェクトフォルダ直下の materials/ に保存、v1: data_dir/materials/
    if project.format_version >= 2:
        materials_dir = Path(project.json_file_path).parent / "materials"
    else:
        materials_dir = Path(project.data_dir) / "materials"
    materials_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename).suffix if file.filename else ".bin"
    dest_path = materials_dir / f"{mat_id}{suffix}"
    dest_path.write_bytes(await file.read())

    # サムネイル生成
    thumb_dir = Path(project.data_dir) / "thumbnails"
    try:
        thumb_path = await _file_service.generate_thumbnail(
            str(dest_path), str(thumb_dir)
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
