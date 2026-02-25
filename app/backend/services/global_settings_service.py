"""GlobalSettingsService — グローバル設定の読み書き"""
from __future__ import annotations

import json
from pathlib import Path

from app.backend.models import LLMSettings

# main.py と同階層 (プロジェクトルート) に配置
_GLOBAL_SETTINGS_PATH = Path(__file__).parent.parent.parent.parent / "global_settings.json"


class GlobalSettingsService:
    """グローバル設定 (global_settings.json) の読み書きを担う。"""

    def __init__(self, settings_path: Path | None = None) -> None:
        self._path = settings_path or _GLOBAL_SETTINGS_PATH
        self._cached: LLMSettings | None = None

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
