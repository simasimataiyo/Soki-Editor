"""セクション管理 API ルーター"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.backend.models import Section, SectionCreate, SectionOrder, SectionUpdate
from app.backend.routers.projects import get_service

router = APIRouter(prefix="/api/projects/{project_id}", tags=["sections"])


def _not_found(project_id: str):
    raise HTTPException(status_code=404, detail=f"プロジェクトが見つかりません: {project_id}")


@router.get("/sections", response_model=list[Section])
async def list_sections(project_id: str) -> list[Section]:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
        return sorted(project.sections, key=lambda s: s.order)
    except KeyError:
        _not_found(project_id)


@router.post("/sections", response_model=Section)
async def create_section(project_id: str, body: SectionCreate) -> Section:
    svc = get_service()
    try:
        return await svc.add_section(project_id, body)
    except KeyError:
        _not_found(project_id)


@router.put("/sections/{section_id}", response_model=Section)
async def update_section(
    project_id: str, section_id: str, body: SectionUpdate
) -> Section:
    svc = get_service()
    try:
        return await svc.update_section(project_id, section_id, body)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/sections/{section_id}")
async def delete_section(project_id: str, section_id: str) -> dict:
    svc = get_service()
    try:
        await svc.delete_section(project_id, section_id)
        return {"status": "ok"}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/sections/reorder")
async def reorder_sections(
    project_id: str, body: list[SectionOrder]
) -> dict:
    svc = get_service()
    try:
        await svc.reorder_sections(project_id, body)
        return {"status": "ok"}
    except KeyError:
        _not_found(project_id)
