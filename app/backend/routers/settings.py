"""グローバル設定 API ルーター"""
from __future__ import annotations

from fastapi import APIRouter

from app.backend.models import LLMSettings
from app.backend.services.global_settings_service import GlobalSettingsService

router = APIRouter(prefix="/api", tags=["settings"])
_svc: GlobalSettingsService | None = None


def get_service() -> GlobalSettingsService:
    global _svc
    if _svc is None:
        _svc = GlobalSettingsService()
    return _svc


@router.get("/settings", response_model=LLMSettings)
def get_settings() -> LLMSettings:
    return get_service().get()


@router.put("/settings", response_model=LLMSettings)
def update_settings(body: LLMSettings) -> LLMSettings:
    return get_service().save(body)
