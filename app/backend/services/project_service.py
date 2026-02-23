"""ProjectService — プロジェクト永続化・インメモリキャッシュ・自動保存"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from app.backend.models import (
    ChatMessage,
    LLMSettings,
    Material,
    MaterialUpdate,
    Project,
    ProjectMeta,
    Rule,
    RuleCategory,
    RuleCreate,
    RuleUpdate,
    Section,
    SectionCreate,
    SectionOrder,
    SectionUpdate,
    Source,
    SourceUpdate,
)

_APPDATA_DIR = Path.home() / "AppData" / "Roaming" / "SokiEditor"
_DEFAULT_REGISTRY = _APPDATA_DIR / "projects_registry.json"


class ProjectService:
    """プロジェクトデータのインメモリキャッシュと JSON 永続化を担う。"""

    DEBOUNCE_SECONDS = 10
    MAX_SCOPES = 8              # 最大スコープ数
    MAX_MESSAGES_PER_SCOPE = 32  # スコープあたりの最大メッセージ数

    def __init__(self, registry_path: Optional[str] = None) -> None:
        self._registry_path = Path(registry_path) if registry_path else _DEFAULT_REGISTRY
        self._projects: dict[str, Project] = {}
        self._dirty: dict[str, bool] = {}
        self._autosave_tasks: dict[str, asyncio.Task] = {}

    # ------------------------------------------------------------------
    # プロジェクト CRUD
    # ------------------------------------------------------------------

    async def create_project(
        self, name: str, json_file_path: str, data_dir: str
    ) -> Project:
        project_id = str(uuid.uuid4())
        now = datetime.now()
        project = Project(
            id=project_id,
            name=name,
            created_at=now,
            updated_at=now,
            json_file_path=json_file_path,
            data_dir=data_dir,
        )
        self._projects[project_id] = project
        self._dirty[project_id] = True
        await self._update_registry(project_id, json_file_path)
        self._schedule_autosave(project_id)
        return project

    async def open_project(self, json_file_path: str) -> Project:
        path = Path(json_file_path)
        if not path.exists():
            raise FileNotFoundError(f"プロジェクトファイルが見つかりません: {json_file_path}")
        data = json.loads(path.read_text(encoding="utf-8"))
        project_id = data.get("id")
        # すでにメモリ上にある場合はそのまま返す（ダーティな変更を保持）
        if project_id and project_id in self._projects:
            existing = self._projects[project_id]
            await self._update_registry(project_id, json_file_path)
            return existing
        project = Project.model_validate(data)
        self._projects[project.id] = project
        self._dirty[project.id] = False
        await self._update_registry(project.id, json_file_path)
        return project

    async def get_project(self, project_id: str) -> Project:
        if project_id not in self._projects:
            raise KeyError(f"プロジェクトが見つかりません: {project_id}")
        return self._projects[project_id]

    async def flush(self, project_id: str) -> None:
        """プロジェクトを即時 JSON ファイルに保存する。"""
        project = await self.get_project(project_id)
        await self._save_to_disk(project)
        self._dirty[project_id] = False

    async def list_recent_projects(self) -> list[ProjectMeta]:
        registry = self._load_registry()
        metas: list[ProjectMeta] = []
        for pid, file_path in registry.items():
            # メモリキャッシュにあれば使う
            if pid in self._projects:
                p = self._projects[pid]
                metas.append(
                    ProjectMeta(
                        id=p.id,
                        name=p.name,
                        file_path=file_path,
                        updated_at=p.updated_at,
                    )
                )
            else:
                # ファイルから最低限の情報だけ読み込む
                fp = Path(file_path)
                if fp.exists():
                    try:
                        data = json.loads(fp.read_text(encoding="utf-8"))
                        metas.append(
                            ProjectMeta(
                                id=data["id"],
                                name=data["name"],
                                file_path=file_path,
                                updated_at=datetime.fromisoformat(data["updated_at"]),
                            )
                        )
                    except Exception:
                        pass
        return sorted(metas, key=lambda m: m.updated_at, reverse=True)

    async def update_settings(self, project_id: str, settings: LLMSettings) -> None:
        project = await self.get_project(project_id)
        project.settings = settings
        self._mark_dirty(project_id)

    async def update_data_dir(self, project_id: str, new_data_dir: str) -> None:
        project = await self.get_project(project_id)
        project.data_dir = new_data_dir
        self._mark_dirty(project_id)

    async def update_references_section_enabled(self, project_id: str, enabled: bool) -> None:
        project = await self.get_project(project_id)
        project.references_section_enabled = enabled
        self._mark_dirty(project_id)

    # ------------------------------------------------------------------
    # ルール CRUD
    # ------------------------------------------------------------------

    async def add_rule_category(self, project_id: str, name: str) -> RuleCategory:
        project = await self.get_project(project_id)
        cat = RuleCategory(
            id=str(uuid.uuid4()),
            name=name,
            order=len(project.rule_categories),
        )
        project.rule_categories.append(cat)
        self._mark_dirty(project_id)
        return cat

    async def update_rule_category(
        self, project_id: str, cat_id: str, name: str
    ) -> RuleCategory:
        project = await self.get_project(project_id)
        cat = self._find_or_raise(project.rule_categories, cat_id)
        cat.name = name
        self._mark_dirty(project_id)
        return cat

    async def delete_rule_category(self, project_id: str, cat_id: str) -> None:
        project = await self.get_project(project_id)
        project.rule_categories = [c for c in project.rule_categories if c.id != cat_id]
        project.rules = [r for r in project.rules if r.category_id != cat_id]
        self._mark_dirty(project_id)

    async def add_rule(self, project_id: str, rule: RuleCreate) -> Rule:
        project = await self.get_project(project_id)
        r = Rule(
            id=str(uuid.uuid4()),
            category_id=rule.category_id,
            content=rule.content,
            enabled=rule.enabled,
            order=len(project.rules),
        )
        project.rules.append(r)
        self._mark_dirty(project_id)
        return r

    async def update_rule(
        self, project_id: str, rule_id: str, data: RuleUpdate
    ) -> Rule:
        project = await self.get_project(project_id)
        rule = self._find_or_raise(project.rules, rule_id)
        if data.content is not None:
            rule.content = data.content
        if data.enabled is not None:
            rule.enabled = data.enabled
        if data.order is not None:
            rule.order = data.order
        if data.category_id is not None:
            rule.category_id = data.category_id
        self._mark_dirty(project_id)
        return rule

    async def delete_rule(self, project_id: str, rule_id: str) -> None:
        project = await self.get_project(project_id)
        project.rules = [r for r in project.rules if r.id != rule_id]
        self._mark_dirty(project_id)

    # ------------------------------------------------------------------
    # ソース CRUD
    # ------------------------------------------------------------------

    async def add_source(self, project_id: str) -> Source:
        project = await self.get_project(project_id)
        src = Source(id=f"ref-{uuid.uuid4().hex[:8]}")
        project.sources.append(src)
        self._mark_dirty(project_id)
        return src

    async def update_source(
        self, project_id: str, source_id: str, data: SourceUpdate
    ) -> Source:
        project = await self.get_project(project_id)
        src = self._find_or_raise(project.sources, source_id)
        if data.name is not None:
            src.name = data.name
        if data.file_path is not None:
            src.file_path = data.file_path
        if data.file_type is not None:
            src.file_type = data.file_type
        if data.full_text is not None:
            src.full_text = data.full_text
        if data.summary is not None:
            src.summary = data.summary
        if data.bibliography is not None:
            src.bibliography = data.bibliography
        self._mark_dirty(project_id)
        return src

    async def delete_source(self, project_id: str, source_id: str) -> None:
        project = await self.get_project(project_id)
        project.sources = [s for s in project.sources if s.id != source_id]
        self._mark_dirty(project_id)

    # ------------------------------------------------------------------
    # マテリアル CRUD
    # ------------------------------------------------------------------

    async def add_material(self, project_id: str) -> Material:
        project = await self.get_project(project_id)
        mat = Material(id=f"fig-{uuid.uuid4().hex[:8]}")
        project.materials.append(mat)
        self._mark_dirty(project_id)
        return mat

    async def update_material(
        self, project_id: str, mat_id: str, data: MaterialUpdate
    ) -> Material:
        project = await self.get_project(project_id)
        mat = self._find_or_raise(project.materials, mat_id)
        if data.name is not None:
            mat.name = data.name
        if data.type is not None:
            mat.type = data.type
        if data.caption is not None:
            mat.caption = data.caption
        if data.file_path is not None:
            mat.file_path = data.file_path
        if data.thumbnail_path is not None:
            mat.thumbnail_path = data.thumbnail_path
        self._mark_dirty(project_id)
        return mat

    async def delete_material(self, project_id: str, mat_id: str) -> None:
        project = await self.get_project(project_id)
        project.materials = [m for m in project.materials if m.id != mat_id]
        self._mark_dirty(project_id)

    # ------------------------------------------------------------------
    # セクション CRUD
    # ------------------------------------------------------------------

    async def add_section(
        self, project_id: str, data: SectionCreate
    ) -> Section:
        project = await self.get_project(project_id)
        order = data.order if data.order is not None else len(project.sections)
        sec = Section(
            id=str(uuid.uuid4()),
            title=data.title,
            summary=data.summary,
            content=data.content,
            parent_id=data.parent_id,
            order=order,
        )
        project.sections.append(sec)
        self._mark_dirty(project_id)
        return sec

    async def update_section(
        self, project_id: str, section_id: str, data: SectionUpdate
    ) -> Section:
        project = await self.get_project(project_id)
        sec = self._find_or_raise(project.sections, section_id)
        if data.title is not None:
            sec.title = data.title
        if data.summary is not None:
            sec.summary = data.summary
        if data.content is not None:
            sec.content = data.content
        if data.parent_id is not None:
            sec.parent_id = data.parent_id
        if data.order is not None:
            sec.order = data.order
        self._mark_dirty(project_id)
        return sec

    async def delete_section(self, project_id: str, section_id: str) -> None:
        project = await self.get_project(project_id)
        project.sections = [s for s in project.sections if s.id != section_id]
        self._mark_dirty(project_id)

    async def reorder_sections(
        self, project_id: str, order: list[SectionOrder]
    ) -> None:
        project = await self.get_project(project_id)
        sec_map = {s.id: s for s in project.sections}
        for item in order:
            if item.section_id in sec_map:
                sec_map[item.section_id].order = item.order
                sec_map[item.section_id].parent_id = item.parent_id
        self._mark_dirty(project_id)

    # ------------------------------------------------------------------
    # チャット履歴
    # ------------------------------------------------------------------

    async def get_chat_history(self, project_id: str, scope: str) -> list:
        project = await self.get_project(project_id)
        return project.chat_history.get(scope, [])

    async def append_chat_message(
        self, project_id: str, scope: str, message
    ) -> None:
        project = await self.get_project(project_id)
        if scope not in project.chat_history:
            project.chat_history[scope] = []
        project.chat_history[scope].append(message)

        # スコープ数制限：古いスコープを削除
        if len(project.chat_history) > self.MAX_SCOPES:
            sorted_scopes = sorted(
                project.chat_history.keys(),
                key=lambda k: min((m.timestamp for m in project.chat_history[k]), default=datetime.min)
            )
            oldest_scope = sorted_scopes[0]
            del project.chat_history[oldest_scope]

        # 最大16件のユーザーメッセージを保持（コマンドメッセージはカウントしない）
        history = project.chat_history[scope]
        user_indices = [i for i, m in enumerate(history) if m.role == "user"]
        if len(user_indices) > self.MAX_MESSAGES_PER_SCOPE:
            trim_before = user_indices[-self.MAX_MESSAGES_PER_SCOPE]
            project.chat_history[scope] = history[trim_before:]
        self._mark_dirty(project_id)

    async def create_new_scope(self, project_id: str) -> str:
        """新しいスコープを作成して返す。現在のスコープ数が上限の場合は最古のスコープを削除。"""
        project = await self.get_project(project_id)

        # 新しいスコープ名を生成（scope-1, scope-2, ...）
        existing_numbers = []
        for key in project.chat_history.keys():
            if key.startswith("scope-"):
                try:
                    num = int(key.split("-")[1])
                    existing_numbers.append(num)
                except (ValueError, IndexError):
                    pass

        # 既存の番号があれば最大+1、なければ1
        new_number = max(existing_numbers) + 1 if existing_numbers else 1
        new_scope = f"scope-{new_number}"

        # スコープ数制限
        if len(project.chat_history) >= self.MAX_SCOPES:
            # 最古のスコープを削除
            sorted_scopes = sorted(
                project.chat_history.keys(),
                key=lambda k: min((m.timestamp for m in project.chat_history[k]), default=datetime.min)
            )
            oldest_scope = sorted_scopes[0]
            del project.chat_history[oldest_scope]

        # 新しいスコープを追加
        project.chat_history[new_scope] = []
        self._mark_dirty(project_id)
        return new_scope

    async def clear_chat_history(self, project_id: str, scope: str) -> None:
        project = await self.get_project(project_id)
        project.chat_history.pop(scope, None)
        self._mark_dirty(project_id)

    async def append_command_message(
        self, project_id: str, scope: str, command_name: str, command_args: list[str]
    ) -> None:
        """コマンド実行を履歴に追加する。"""
        project = await self.get_project(project_id)
        if scope not in project.chat_history:
            project.chat_history[scope] = []

        message = ChatMessage(
            role="command",
            content=f"/{command_name} {' '.join(command_args)}",
            timestamp=datetime.now(),
            command_name=command_name,
            command_args=command_args,
        )
        project.chat_history[scope].append(message)
        self._mark_dirty(project_id)

    # ------------------------------------------------------------------
    # 内部ヘルパー
    # ------------------------------------------------------------------

    def _mark_dirty(self, project_id: str) -> None:
        project = self._projects.get(project_id)
        if project:
            project.updated_at = datetime.now()
        self._dirty[project_id] = True
        self._schedule_autosave(project_id)

    def _schedule_autosave(self, project_id: str) -> None:
        # 既存のタスクをキャンセルしてデバウンス
        existing = self._autosave_tasks.get(project_id)
        if existing and not existing.done():
            existing.cancel()
        try:
            loop = asyncio.get_running_loop()
            task = loop.create_task(self._autosave(project_id))
            self._autosave_tasks[project_id] = task
        except RuntimeError:
            # イベントループが実行されていない場合は即時保存をスキップ
            pass

    async def _autosave(self, project_id: str) -> None:
        await asyncio.sleep(self.DEBOUNCE_SECONDS)
        if self._dirty.get(project_id):
            project = self._projects.get(project_id)
            if project:
                await self._save_to_disk(project)
                self._dirty[project_id] = False

    async def _save_to_disk(self, project: Project) -> None:
        path = Path(project.json_file_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            project.model_dump_json(indent=2), encoding="utf-8"
        )

    async def _update_registry(self, project_id: str, file_path: str) -> None:
        registry = self._load_registry()
        registry[project_id] = file_path
        self._registry_path.parent.mkdir(parents=True, exist_ok=True)
        self._registry_path.write_text(
            json.dumps(registry, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _load_registry(self) -> dict[str, str]:
        if self._registry_path.exists():
            try:
                return json.loads(self._registry_path.read_text(encoding="utf-8"))
            except Exception:
                return {}
        return {}

    def _find_or_raise(self, items: list, item_id: str):
        for item in items:
            if item.id == item_id:
                return item
        raise KeyError(f"ID が見つかりません: {item_id}")
