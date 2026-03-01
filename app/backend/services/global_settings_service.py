"""GlobalSettingsService — グローバル設定の読み書き"""
from __future__ import annotations

import json
from pathlib import Path

from app.backend.models import LLMSettings

_APPDATA_DIR = Path.home() / "AppData" / "Roaming" / "SokiEditor"
_SETTINGS_PATH = _APPDATA_DIR / "global_settings.json"

# 旧パス（プロジェクトルート）— マイグレーション用
_LEGACY_SETTINGS_PATH = Path(__file__).parent.parent.parent.parent / "global_settings.json"


class GlobalSettingsService:
    """グローバル設定 (global_settings.json) の読み書きを担う。"""

    def __init__(self, settings_path: Path | None = None) -> None:
        self._path = settings_path or _SETTINGS_PATH
        self._cached: LLMSettings | None = None
        self._migrate_legacy()

    def _migrate_legacy(self) -> None:
        """旧パス (プロジェクトルート/global_settings.json) が存在し、
        新パスがまだ存在しない場合に設定ファイルを移行する。"""
        if self._path.exists() or not _LEGACY_SETTINGS_PATH.exists():
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            data = _LEGACY_SETTINGS_PATH.read_text(encoding="utf-8")
            self._path.write_text(data, encoding="utf-8")
        except Exception:
            pass

    def get(self) -> LLMSettings:
        """グローバル設定を返す。ファイルが存在しない場合はデフォルト値を返す。"""
        if self._cached is not None:
            return self._cached
        if self._path.exists():
            try:
                data = json.loads(self._path.read_text(encoding="utf-8"))
                self._cached = LLMSettings.model_validate(data)
                return self._cached
            except Exception:
                pass
        self._cached = LLMSettings()
        return self._cached

    def save(self, settings: LLMSettings) -> LLMSettings:
        """グローバル設定をディスクに保存してキャッシュを更新する。"""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(settings.model_dump_json(indent=2), encoding="utf-8")
        self._cached = settings
        return settings
