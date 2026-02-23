"""ExportService — Markdown 生成・参照番号変換"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

from app.backend.models import Project, Section, SectionPreview


class ExportService:
    """プロジェクトデータから Markdown を生成し、参照 ID を番号形式に変換する。"""

    # [^ref-xxx] マッチパターン
    _REF_PATTERN = re.compile(r"\[\^(ref-[^\]]+)\]")
    # ![caption](path "fig-xxx") マッチパターン
    _FIG_PATTERN = re.compile(r'!\[([^\]]*)\]\([^)]*\s+"(fig-[^"]+)"\)')

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def export_to_markdown(self, project: Project) -> str:
        """全セクションを階層見出し付き Markdown に変換し、
        参照解決・参考文献付与を行う。"""
        ref_map, fig_map = self.build_reference_maps(project)
        sections_by_id = {s.id: s for s in project.sections}
        sorted_sections = sorted(project.sections, key=lambda s: s.order)

        lines: list[str] = []

        def _depth(sec: Section) -> int:
            d = 1
            pid = sec.parent_id
            while pid and pid in sections_by_id:
                d += 1
                pid = sections_by_id[pid].parent_id
            return d

        for sec in sorted_sections:
            depth = _depth(sec)
            heading = "#" * depth
            lines.append(f"{heading} {sec.title}")
            if sec.content:
                resolved = self.resolve_references(sec.content, ref_map, fig_map)
                lines.append(resolved)
            lines.append("")

        # 参考文献リスト（フラグが有効な場合のみ出力）
        if project.references_section_enabled:
            numbered = [
                (src_id, num)
                for src_id, num in sorted(ref_map.items(), key=lambda x: x[1])
            ]
            if numbered:
                lines.append("## 参考文献")
                src_by_id = {s.id: s for s in project.sources}
                for src_id, num in numbered:
                    src = src_by_id.get(src_id)
                    if src:
                        bib = src.bibliography
                        entry = self._format_bibliography(bib)
                        lines.append(f"[{num}] {entry}")
                lines.append("")

        return "\n".join(lines)

    def resolve_references(
        self,
        content: str,
        ref_map: dict[str, int],
        fig_map: dict[str, tuple[str, int]],
    ) -> str:
        """[^ref-ID] → [N]、![caption](path "fig-ID") → 図N caption に変換する。"""

        def replace_ref(m: re.Match) -> str:
            src_id = m.group(1)
            if src_id in ref_map:
                return f"[{ref_map[src_id]}]"
            return m.group(0)

        def replace_fig(m: re.Match) -> str:
            caption = m.group(1)
            fig_id = m.group(2)
            if fig_id in fig_map:
                fig_type, num = fig_map[fig_id]
                prefix = "図" if fig_type == "figure" else "表"
                return f"{prefix}{num} {caption}"
            return m.group(0)

        content = self._REF_PATTERN.sub(replace_ref, content)
        content = self._FIG_PATTERN.sub(replace_fig, content)
        return content

    def build_reference_maps(
        self, project: Project
    ) -> tuple[dict[str, int], dict[str, tuple[str, int]]]:
        """本文出現順に ref_map と fig_map を構築する。"""
        src_by_id = {
            s.id: s
            for s in project.sources
            if s.bibliography.include_in_references
        }
        mat_by_id = {m.id: m for m in project.materials}

        ref_map: dict[str, int] = {}
        fig_map: dict[str, tuple[str, int]] = {}
        ref_counter = 0
        # 図と表は別系列でカウント
        fig_counter = 0
        tbl_counter = 0

        sorted_sections = sorted(project.sections, key=lambda s: s.order)

        for sec in sorted_sections:
            text = sec.content
            # 文献参照
            for m in self._REF_PATTERN.finditer(text):
                src_id = m.group(1)
                if src_id in src_by_id and src_id not in ref_map:
                    ref_counter += 1
                    ref_map[src_id] = ref_counter
            # 図表参照
            for m in self._FIG_PATTERN.finditer(text):
                fig_id = m.group(2)
                if fig_id in mat_by_id and fig_id not in fig_map:
                    mat = mat_by_id[fig_id]
                    if mat.type == "figure":
                        fig_counter += 1
                        fig_map[fig_id] = ("figure", fig_counter)
                    else:
                        tbl_counter += 1
                        fig_map[fig_id] = ("table", tbl_counter)

        return ref_map, fig_map

    def get_preview_content(self, project: Project) -> list[SectionPreview]:
        """Review タブ表示用: 各セクションの参照解決済みコンテンツを返す。"""
        ref_map, fig_map = self.build_reference_maps(project)
        previews: list[SectionPreview] = []
        sorted_sections = sorted(project.sections, key=lambda s: s.order)
        for sec in sorted_sections:
            resolved = self.resolve_references(sec.content, ref_map, fig_map)
            previews.append(
                SectionPreview(section_id=sec.id, rendered_content=resolved)
            )
        # 参考文献セクションが有効な場合、末尾に追加
        if project.references_section_enabled and ref_map:
            src_by_id = {s.id: s for s in project.sources}
            bib_lines: list[str] = []
            for src_id, num in sorted(ref_map.items(), key=lambda x: x[1]):
                src = src_by_id.get(src_id)
                if src:
                    bib_lines.append(f"[{num}] {self._format_bibliography(src.bibliography)}")
            previews.append(
                SectionPreview(
                    section_id="__references__",
                    rendered_content="\n".join(bib_lines),
                )
            )
        return previews

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _format_bibliography(self, bib) -> str:
        """参考文献エントリを簡易テキスト形式にフォーマットする。"""
        parts: list[str] = []
        if bib.author:
            parts.append(bib.author)
        if bib.title:
            parts.append(f"『{bib.title}』")
        if bib.journal:
            parts.append(bib.journal)
        if bib.year:
            parts.append(f"({bib.year})")
        if bib.url:
            parts.append(bib.url)
        return " ".join(parts) if parts else "(文献情報なし)"
