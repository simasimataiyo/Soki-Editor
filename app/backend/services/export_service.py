"""ExportService — Markdown 生成・参照番号変換"""
from __future__ import annotations

import re

from app.backend.models import CitationToken, Project, SectionPreview


# デフォルトの参考文献フォーマット（種類ごと）
DEFAULT_CITATION_FORMATS: dict[str, list[CitationToken]] = {
    "paper": [
        CitationToken(field="author"),
        CitationToken(field="year", prefix="(", suffix=")"),
        CitationToken(field="title", prefix="『", suffix="』"),
        CitationToken(field="journal"),
        CitationToken(field="volume"),
        CitationToken(field="issue", prefix="(", suffix=")"),
        CitationToken(field="pages", prefix=":"),
    ],
    "book": [
        CitationToken(field="author"),
        CitationToken(field="year", prefix="(", suffix=")"),
        CitationToken(field="title", prefix="『", suffix="』"),
        CitationToken(field="publisher"),
        CitationToken(field="publication_place"),
    ],
    "book_chapter": [
        CitationToken(field="author"),
        CitationToken(field="year", prefix="(", suffix=")"),
        CitationToken(field="title", prefix="『", suffix="』"),
        CitationToken(field="editor", suffix="(編)"),
        CitationToken(field="publisher"),
        CitationToken(field="pages", prefix="pp."),
    ],
    "web": [
        CitationToken(field="author"),
        CitationToken(field="year", prefix="(", suffix=")"),
        CitationToken(field="title"),
        CitationToken(field="site_name"),
        CitationToken(field="url"),
        CitationToken(field="accessed_date", prefix="[参照: ", suffix="]"),
    ],
    "resource": [
        CitationToken(field="author"),
        CitationToken(field="year", prefix="(", suffix=")"),
        CitationToken(field="title"),
    ],
}


class ExportService:
    """プロジェクトデータから Markdown を生成し、参照 ID を番号形式に変換する。"""

    # [^ref-xxx] マッチパターン
    _REF_PATTERN = re.compile(r"\[\^(ref-[^\]]+)\]")
    # ![caption](path "fig-xxx") マッチパターン
    _FIG_PATTERN = re.compile(r'!\[([^\]]*)\]\([^)]*?"(fig-[^"]+)"\)')
    # soki-section マーカーパターン（新形式: JSON / 旧形式: UUID）
    _MARKER_PATTERN = re.compile(r'<!-- soki-section:(?:\{[^}]*\}|[a-f0-9-]+) -->\n?')
    # fig-block コメントパターン
    _FIG_BLOCK_PATTERN = re.compile(r'<!-- fig-block:(fig-[a-z0-9]+) -->')

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def export_to_markdown(self, project: Project) -> str:
        """project.content を使い、マーカーを除去した上で参照解決・参考文献付与を行う。"""
        ref_map, fig_map = self.build_reference_maps(project)

        # マーカーを除去
        content = self._MARKER_PATTERN.sub('', project.content)

        # fig-block を表Markdownに展開
        mat_by_id = {m.id: m for m in project.materials}
        content = self._expand_fig_blocks(content, mat_by_id)

        # 参照解決
        content = self.resolve_references(content, ref_map, fig_map)

        # 参考文献リスト（フラグが有効な場合のみ出力）
        if project.references_section_enabled:
            numbered = [
                (src_id, num)
                for src_id, num in sorted(ref_map.items(), key=lambda x: x[1])
            ]
            if numbered:
                lines = [content.rstrip(), "", "## 参考文献"]
                src_by_id = {s.id: s for s in project.sources}
                for src_id, num in numbered:
                    src = src_by_id.get(src_id)
                    if src:
                        bib = src.bibliography
                        tokens = (project.citation_formats or {}).get(bib.type)
                        entry = self._format_bibliography(bib, tokens)
                        lines.append(f"[{num}] {entry}")
                lines.append("")
                return "\n".join(lines)

        return content

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
            fig_id = m.group(2)
            if fig_id in fig_map:
                fig_type, num = fig_map[fig_id]
                prefix = "図" if fig_type == "figure" else "表"
                return f"{prefix}{num}"
            return m.group(0)

        content = self._REF_PATTERN.sub(replace_ref, content)
        content = self._FIG_PATTERN.sub(replace_fig, content)
        return content

    def build_reference_maps(
        self, project: Project
    ) -> tuple[dict[str, int], dict[str, tuple[str, int]]]:
        """project.content を1回スキャンして ref_map と fig_map を構築する。"""
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

        text = project.content

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
        from app.backend.services.project_service import ProjectService
        from app.backend.services.utils import sort_sections_hierarchically
        ref_map, fig_map = self.build_reference_maps(project)
        previews: list[SectionPreview] = []
        sorted_sections = sort_sections_hierarchically(project.sections)
        for sec in sorted_sections:
            body = ProjectService.extract_section_body(project.content, sec.id)
            resolved = self.resolve_references(body, ref_map, fig_map)
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
                    tokens = (project.citation_formats or {}).get(src.bibliography.type)
                    bib_lines.append(f"[{num}] {self._format_bibliography(src.bibliography, tokens)}")
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

    def _expand_fig_blocks(self, content: str, mat_by_id: dict) -> str:
        """<!-- fig-block:fig-xxx --> を表マテリアルの table_content に展開する。
        図マテリアルの場合はコメントをそのまま除去する。"""
        def replace_fig_block(m: re.Match) -> str:
            fig_id = m.group(1)
            mat = mat_by_id.get(fig_id)
            if mat and mat.type == "table" and mat.table_content:
                caption = mat.caption or mat.name
                return f"{mat.table_content.strip()}\n\n*{caption}*"
            return ""

        return self._FIG_BLOCK_PATTERN.sub(replace_fig_block, content)

    def _format_bibliography(self, bib, tokens: list[CitationToken] | None = None) -> str:
        """参考文献エントリをトークンリストに従ってフォーマットする。
        tokens が None の場合はデフォルトフォーマットを使用する。"""
        if tokens is None:
            tokens = DEFAULT_CITATION_FORMATS.get(bib.type, DEFAULT_CITATION_FORMATS["resource"])

        parts: list[str] = []
        for tok in tokens:
            if tok.field == "literal":
                if tok.prefix:
                    parts.append(tok.prefix)
                continue
            value = getattr(bib, tok.field, None) or ""
            if value:
                parts.append(f"{tok.prefix}{value}{tok.suffix}")

        return " ".join(parts) if parts else "(文献情報なし)"
