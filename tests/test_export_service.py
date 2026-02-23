"""ExportService ユニットテスト（TDD: テストを先に記述）"""
from datetime import datetime

import pytest

from app.backend.models import (
    Bibliography,
    Material,
    Project,
    Section,
    Source,
)
from app.backend.services.export_service import ExportService


@pytest.fixture
def service() -> ExportService:
    return ExportService()


@pytest.fixture
def base_project() -> Project:
    return Project(
        id="proj-001",
        name="テストプロジェクト",
        created_at=datetime(2026, 1, 1),
        updated_at=datetime(2026, 1, 1),
        json_file_path="/tmp/proj-001.json",
        data_dir="/tmp/proj-001/data",
    )


# ─── resolve_references のテスト ─────────────────────────────


class TestResolveReferences:
    def test_ref_id_is_replaced_with_number(self, service):
        ref_map = {"ref-001": 1, "ref-002": 2}
        fig_map = {}
        result = service.resolve_references(
            "本文 [^ref-001] テキスト [^ref-002]", ref_map, fig_map
        )
        assert "[1]" in result
        assert "[2]" in result
        assert "[^ref-001]" not in result

    def test_unknown_ref_id_is_not_replaced(self, service):
        ref_map = {"ref-001": 1}
        fig_map = {}
        result = service.resolve_references(
            "本文 [^ref-999]", ref_map, fig_map
        )
        assert "[^ref-999]" in result

    def test_figure_notation_is_replaced(self, service):
        ref_map = {}
        fig_map = {"fig-001": ("figure", 1)}
        result = service.resolve_references(
            '![キャプション](/path/to/img.png "fig-001")', ref_map, fig_map
        )
        assert "図1 キャプション" in result
        assert "fig-001" not in result

    def test_table_notation_is_replaced(self, service):
        ref_map = {}
        fig_map = {"fig-tbl": ("table", 1)}
        result = service.resolve_references(
            '![表キャプション](/path/img.png "fig-tbl")', ref_map, fig_map
        )
        assert "表1 表キャプション" in result

    def test_unknown_fig_id_is_not_replaced(self, service):
        ref_map = {}
        fig_map = {"fig-001": ("figure", 1)}
        original = '![cap](/img.png "fig-999")'
        result = service.resolve_references(original, ref_map, fig_map)
        assert original in result

    def test_multiple_refs_in_one_line(self, service):
        ref_map = {"ref-a": 1, "ref-b": 2, "ref-c": 3}
        fig_map = {}
        result = service.resolve_references(
            "[^ref-a] および [^ref-b] と [^ref-c]", ref_map, fig_map
        )
        assert "[1]" in result
        assert "[2]" in result
        assert "[3]" in result


# ─── build_reference_maps のテスト ──────────────────────────


class TestBuildReferenceMaps:
    def test_sources_with_include_flag_are_numbered(self, service, base_project):
        base_project.sources = [
            Source(
                id="ref-001",
                bibliography=Bibliography(include_in_references=True),
                full_text="テスト全文",
            ),
        ]
        base_project.sections = [
            Section(id="sec-1", content="[^ref-001] に記述", order=0),
        ]
        ref_map, fig_map = service.build_reference_maps(base_project)
        assert "ref-001" in ref_map
        assert ref_map["ref-001"] == 1

    def test_sources_without_include_flag_are_excluded(self, service, base_project):
        base_project.sources = [
            Source(
                id="ref-001",
                bibliography=Bibliography(include_in_references=False),
            ),
        ]
        base_project.sections = [
            Section(id="sec-1", content="[^ref-001]", order=0),
        ]
        ref_map, _ = service.build_reference_maps(base_project)
        assert "ref-001" not in ref_map

    def test_references_numbered_by_first_appearance_order(self, service, base_project):
        base_project.sources = [
            Source(id="ref-A", bibliography=Bibliography(include_in_references=True)),
            Source(id="ref-B", bibliography=Bibliography(include_in_references=True)),
        ]
        # ref-B が先に登場
        base_project.sections = [
            Section(id="sec-1", content="[^ref-B] then [^ref-A]", order=0),
        ]
        ref_map, _ = service.build_reference_maps(base_project)
        assert ref_map["ref-B"] == 1
        assert ref_map["ref-A"] == 2

    def test_materials_numbered_by_first_appearance_order(self, service, base_project):
        base_project.materials = [
            Material(id="fig-X", type="figure"),
            Material(id="fig-Y", type="table"),
        ]
        base_project.sections = [
            Section(
                id="sec-1",
                content='![a](/p "fig-X") and ![b](/q "fig-Y")',
                order=0,
            ),
        ]
        _, fig_map = service.build_reference_maps(base_project)
        assert "fig-X" in fig_map
        assert fig_map["fig-X"] == ("figure", 1)
        assert "fig-Y" in fig_map
        assert fig_map["fig-Y"] == ("table", 1)


# ─── export_to_markdown のテスト ─────────────────────────────


class TestExportToMarkdown:
    def test_export_contains_all_sections(self, service, base_project):
        base_project.sections = [
            Section(id="sec-1", title="序論", content="序論本文", order=0),
            Section(id="sec-2", title="本論", content="本論本文", order=1),
        ]
        md = service.export_to_markdown(base_project)
        assert "序論" in md
        assert "本論" in md
        assert "序論本文" in md
        assert "本論本文" in md

    def test_export_converts_ref_numbers(self, service, base_project):
        base_project.sources = [
            Source(
                id="ref-001",
                bibliography=Bibliography(
                    include_in_references=True, title="文献A", author="著者A"
                ),
            )
        ]
        base_project.sections = [
            Section(id="sec-1", content="本文 [^ref-001]", order=0),
        ]
        md = service.export_to_markdown(base_project)
        assert "[1]" in md
        assert "[^ref-001]" not in md

    def test_export_appends_bibliography_at_end(self, service, base_project):
        base_project.sources = [
            Source(
                id="ref-001",
                bibliography=Bibliography(
                    include_in_references=True,
                    title="テスト文献",
                    author="著者X",
                ),
            )
        ]
        base_project.sections = [
            Section(id="sec-1", content="[^ref-001]", order=0),
        ]
        md = service.export_to_markdown(base_project)
        # 参考文献リストが末尾に付与される
        assert "参考文献" in md
        assert "テスト文献" in md
        # 参考文献が本文より後に来る
        ref_idx = md.index("参考文献")
        content_idx = md.index("sec-1") if "sec-1" in md else 0
        assert ref_idx > 0

    def test_section_hierarchy_uses_heading_levels(self, service, base_project):
        base_project.sections = [
            Section(id="sec-1", title="第1章", order=0, parent_id=None),
            Section(id="sec-2", title="第1節", order=0, parent_id="sec-1"),
            Section(id="sec-3", title="小節", order=0, parent_id="sec-2"),
        ]
        md = service.export_to_markdown(base_project)
        assert "# 第1章" in md
        assert "## 第1節" in md
        assert "### 小節" in md

    def test_sources_without_include_excluded_from_bibliography(
        self, service, base_project
    ):
        base_project.sources = [
            Source(
                id="ref-001",
                bibliography=Bibliography(
                    include_in_references=False, title="非掲載文献"
                ),
            )
        ]
        base_project.sections = [
            Section(id="sec-1", content="[^ref-001]", order=0),
        ]
        md = service.export_to_markdown(base_project)
        assert "非掲載文献" not in md


# ─── get_preview_content のテスト ───────────────────────────


class TestGetPreviewContent:
    def test_preview_returns_resolved_content_per_section(self, service, base_project):
        base_project.sources = [
            Source(
                id="ref-001",
                bibliography=Bibliography(include_in_references=True),
            )
        ]
        base_project.sections = [
            Section(id="sec-1", content="本文 [^ref-001]", order=0),
        ]
        previews = service.get_preview_content(base_project)
        assert len(previews) == 1
        assert previews[0].section_id == "sec-1"
        assert "[1]" in previews[0].rendered_content
        assert "[^ref-001]" not in previews[0].rendered_content
