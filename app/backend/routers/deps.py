"""router 共通依存関数"""
from __future__ import annotations

from fastapi import HTTPException


def not_found(project_id: str) -> None:
    raise HTTPException(status_code=404, detail=f"プロジェクトが見つかりません: {project_id}")


async def get_project_or_404(svc, project_id: str):
    try:
        return await svc.get_project(project_id)
    except KeyError:
        not_found(project_id)
