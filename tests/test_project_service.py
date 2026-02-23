"""ProjectService ユニットテスト（TDD: テストを先に記述）"""
import asyncio
import json
import os
import tempfile
from datetime import datetime
from pathlib import Path

import pytest

from app.backend.models import (
    LLMSettings,
    Project,
    RuleCreate,
    SectionCreate,
    SectionUpdate,
    SourceUpdate,
)
from app.backend.services.project_service import ProjectService


@pytest.fixture
def tmp_dir(tmp_path: Path) -> Path:
    return tmp_path


@pytest.fixture
def service(tmp_dir: Path) -> ProjectService:
    registry_path = tmp_dir / "registry.json"
    return ProjectService(registry_path=str(registry_path))


@pytest.fixture
async def project(service: ProjectService, tmp_dir: Path) -> Project:
    json_path = str(tmp_dir / "myproject.json")
    data_dir = str(tmp_dir / "myproject" / "data")
    return await service.create_project("テストプロジェクト", json_path, data_dir)


# ─── プロジェクト CRUD ────────────────────────────────────────


class TestProjectCRUD:
    async def test_create_project_returns_project(
        self, service: ProjectService, tmp_dir: Path
    ):
        json_path = str(tmp_dir / "p.json")
        data_dir = str(tmp_dir / "data")
        p = await service.create_project("My Project", json_path, data_dir)
        assert p.name == "My Project"
        assert p.id is not None
        assert p.json_file_path == json_path
        assert p.data_dir == data_dir

    async def test_create_project_saves_json_file(
        self, service: ProjectService, tmp_dir: Path
    ):
        json_path = str(tmp_dir / "saved.json")
        data_dir = str(tmp_dir / "data")
        p = await service.create_project("Saved", json_path, data_dir)
        # flush で即時保存
        await service.flush(p.id)
        assert Path(json_path).exists()

    async def test_open_project_loads_from_disk(
        self, service: ProjectService, tmp_dir: Path
    ):
        json_path = str(tmp_dir / "openme.json")
        data_dir = str(tmp_dir / "d")
        p = await service.create_project("Open Me", json_path, data_dir)
        await service.flush(p.id)

        svc2 = ProjectService(
            registry_path=str(tmp_dir / "registry2.json")
        )
        loaded = await svc2.open_project(json_path)
        assert loaded.id == p.id
        assert loaded.name == "Open Me"

    async def test_get_project_returns_cached(
        self, service: ProjectService, project: Project
    ):
        got = await service.get_project(project.id)
        assert got.id == project.id

    async def test_get_project_raises_for_unknown_id(self, service: ProjectService):
        with pytest.raises(KeyError):
            await service.get_project("nonexistent-id")

    async def test_list_recent_projects_returns_created(
        self, service: ProjectService, project: Project
    ):
        recent = await service.list_recent_projects()
        ids = [m.id for m in recent]
        assert project.id in ids

    async def test_update_settings(
        self, service: ProjectService, project: Project
    ):
        new_settings = LLMSettings(api_key="sk-test", model="gpt-4-turbo")
        await service.update_settings(project.id, new_settings)
        p = await service.get_project(project.id)
        assert p.settings.api_key == "sk-test"
        assert p.settings.model == "gpt-4-turbo"

    async def test_update_data_dir(
        self, service: ProjectService, project: Project, tmp_dir: Path
    ):
        new_dir = str(tmp_dir / "newdata")
        await service.update_data_dir(project.id, new_dir)
        p = await service.get_project(project.id)
        assert p.data_dir == new_dir


# ─── ルール CRUD ──────────────────────────────────────────────


class TestRuleCRUD:
    async def test_add_rule_category(
        self, service: ProjectService, project: Project
    ):
        cat = await service.add_rule_category(project.id, "文体")
        assert cat.name == "文体"
        assert cat.id

    async def test_add_rule(self, service: ProjectService, project: Project):
        cat = await service.add_rule_category(project.id, "文体")
        rule = await service.add_rule(
            project.id, RuleCreate(category_id=cat.id, content="体言止め禁止")
        )
        assert rule.content == "体言止め禁止"
        assert rule.category_id == cat.id

    async def test_delete_rule_category_removes_rules(
        self, service: ProjectService, project: Project
    ):
        cat = await service.add_rule_category(project.id, "削除対象")
        await service.add_rule(
            project.id, RuleCreate(category_id=cat.id, content="ルール1")
        )
        await service.delete_rule_category(project.id, cat.id)
        p = await service.get_project(project.id)
        cat_ids = [c.id for c in p.rule_categories]
        rule_cat_ids = [r.category_id for r in p.rules]
        assert cat.id not in cat_ids
        assert cat.id not in rule_cat_ids


# ─── セクション CRUD ──────────────────────────────────────────


class TestSectionCRUD:
    async def test_add_section(self, service: ProjectService, project: Project):
        sec = await service.add_section(
            project.id, SectionCreate(title="序論", content="")
        )
        assert sec.title == "序論"
        assert sec.id

    async def test_update_section(self, service: ProjectService, project: Project):
        sec = await service.add_section(
            project.id, SectionCreate(title="旧タイトル")
        )
        updated = await service.update_section(
            project.id, sec.id, SectionUpdate(title="新タイトル")
        )
        assert updated.title == "新タイトル"

    async def test_delete_section(self, service: ProjectService, project: Project):
        sec = await service.add_section(project.id, SectionCreate(title="削除"))
        await service.delete_section(project.id, sec.id)
        p = await service.get_project(project.id)
        ids = [s.id for s in p.sections]
        assert sec.id not in ids

    async def test_reorder_sections(self, service: ProjectService, project: Project):
        from app.backend.models import SectionOrder

        sec1 = await service.add_section(project.id, SectionCreate(title="A"))
        sec2 = await service.add_section(project.id, SectionCreate(title="B"))
        await service.reorder_sections(
            project.id,
            [
                SectionOrder(section_id=sec2.id, parent_id=None, order=0),
                SectionOrder(section_id=sec1.id, parent_id=None, order=1),
            ],
        )
        p = await service.get_project(project.id)
        sec_map = {s.id: s for s in p.sections}
        assert sec_map[sec2.id].order == 0
        assert sec_map[sec1.id].order == 1


# ─── autosave ─────────────────────────────────────────────────


class TestAutosave:
    async def test_flush_saves_to_disk(
        self, service: ProjectService, project: Project
    ):
        await service.flush(project.id)
        p = await service.get_project(project.id)
        assert Path(p.json_file_path).exists()
        data = json.loads(Path(p.json_file_path).read_text(encoding="utf-8"))
        assert data["id"] == project.id

    async def test_in_memory_state_updated_before_save(
        self, service: ProjectService, project: Project
    ):
        # セクション追加後にメモリ上のプロジェクトが更新される
        sec = await service.add_section(project.id, SectionCreate(title="New"))
        p = await service.get_project(project.id)
        titles = [s.title for s in p.sections]
        assert "New" in titles
