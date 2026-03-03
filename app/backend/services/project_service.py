"""ProjectService — プロジェクト永続化・インメモリキャッシュ・自動保存"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

from app.backend.models import (
    ChatMessage,
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


def _parse_marker_id(payload: str) -> str | None:
    """マーカーペイロード（{ JSON } または UUID 文字列）からセクション ID を抽出する。"""
    if payload.startswith("{"):
        try:
            return json.loads(payload).get("id")
        except Exception:
            return None
    return payload

# 新形式 {JSON} / 旧形式 UUID 両方にマッチする共通パターン
_MARKER_RE = re.compile(r'<!-- soki-section:(\{[^}]*\}|[a-f0-9-]+) -->')


class ProjectService:
    """プロジェクトデータのインメモリキャッシュと JSON 永続化を担う。"""

    DEBOUNCE_SECONDS = 10
    MAX_MESSAGES = 50  # 全体の最大メッセージ数

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

        # --- Migration: Dict -> List (chat_history) ---
        if "chat_history" in data and isinstance(data["chat_history"], dict):
            all_messages = []
            for scope, msgs in data["chat_history"].items():
                all_messages.extend(msgs)
            # timestamp が文字列の場合があるので注意（ソート可能か）
            all_messages.sort(key=lambda m: m.get("timestamp", ""))
            data["chat_history"] = all_messages
        # ------------------------------------------

        # --- Migration: Section.content -> Project.content ---
        self._migrate_section_content_to_flat(data)
        # ---------------------------------------------------

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

    @staticmethod
    def _migrate_section_content_to_flat(data: dict) -> None:
        """旧フォーマット（各 Section.content）を新フォーマット（Project.content）に変換する。

        data["content"] が空で、かつ sections に content があれば移行を実行する。
        移行後は各 section の content を None にクリアする。
        """
        sections = data.get("sections", [])
        existing_content = data.get("content", "")
        if existing_content:
            return  # すでに新フォーマット

        # いずれかのセクションに content があれば移行対象
        has_old_content = any(
            (sec.get("content") or "") for sec in sections
        )
        if not has_old_content:
            return

        # セクションを階層・順序で並べる（深さ優先）
        sec_by_id = {s["id"]: s for s in sections}

        def _depth(sec: dict) -> int:
            d = 1
            pid = sec.get("parent_id")
            while pid and pid in sec_by_id:
                d += 1
                pid = sec_by_id[pid].get("parent_id")
            return d

        def _collect_ordered(roots: list[dict]) -> list[dict]:
            result = []
            for s in roots:
                result.append(s)
                children = sorted(
                    [c for c in sections if c.get("parent_id") == s["id"]],
                    key=lambda x: x.get("order", 0)
                )
                result.extend(_collect_ordered(children))
            return result

        roots = sorted(
            [s for s in sections if not s.get("parent_id")],
            key=lambda x: x.get("order", 0)
        )
        ordered = _collect_ordered(roots)

        parts = []
        for sec in ordered:
            depth = min(_depth(sec), 6)
            heading_level = "#" * depth  # depth=1→#(h1), depth=2→##(h2)
            sec_id = sec["id"]
            title = sec.get("title", "")
            body = (sec.get("content") or "").strip()
            meta = json.dumps({"id": sec_id, "summary": sec.get("summary", ""), "parentId": sec.get("parent_id"), "sectionOrder": sec.get("order", 0)}, ensure_ascii=False)
            parts.append(f"<!-- soki-section:{meta} -->\n{heading_level} {title}\n\n{body}\n")

        data["content"] = "\n".join(parts)

        # 各セクションの content をクリア
        for sec in sections:
            sec.pop("content", None)

    async def get_project(self, project_id: str) -> Project:
        if project_id not in self._projects:
            raise KeyError(f"プロジェクトが見つかりません: {project_id}")
        return self._projects[project_id]

    async def flush(self, project_id: str) -> None:
        """プロジェクトを即時 JSON ファイルに保存する。"""
        project = await self.get_project(project_id)
        await self._save_to_disk(project)
        self._dirty[project_id] = False

    async def flush_all_dirty(self) -> None:
        """ダーティなすべてのプロジェクトを即時保存する（シャットダウン時用）。"""
        for project_id, dirty in list(self._dirty.items()):
            if dirty:
                project = self._projects.get(project_id)
                if project:
                    try:
                        await self._save_to_disk(project)
                        self._dirty[project_id] = False
                        logger.info("シャットダウン保存完了: %s", project_id)
                    except Exception as e:
                        logger.error("シャットダウン保存失敗: %s — %s", project_id, e)

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

    async def update_name(self, project_id: str, new_name: str) -> None:
        project = await self.get_project(project_id)
        project.name = new_name
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
        # content 内の [^ref-xxx] 参照を削除
        project.content = re.sub(
            r'\s*\[\^' + re.escape(source_id) + r'\]',
            '',
            project.content,
        )
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
        if data.table_content is not None:
            mat.table_content = data.table_content
        self._mark_dirty(project_id)
        return mat

    async def delete_material(self, project_id: str, mat_id: str) -> None:
        project = await self.get_project(project_id)
        project.materials = [m for m in project.materials if m.id != mat_id]
        # content 内の ![alt]("fig-xxx") インライン参照を削除
        project.content = re.sub(
            r'!\[[^\]]*\]\([^)]*"' + re.escape(mat_id) + r'"[^)]*\)',
            '',
            project.content,
        )
        # content 内の <!-- fig-block:fig-xxx --> ブロック参照を削除
        project.content = re.sub(
            r'<!-- fig-block:' + re.escape(mat_id) + r' -->\n?',
            '',
            project.content,
        )
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
            id=data.id if data.id else str(uuid.uuid4()),
            title=data.title,
            summary=data.summary,
            parent_id=data.parent_id,
            order=order,
        )
        project.sections.append(sec)

        # 指定IDのセクション（content に既存マーカーあり）はスケルトン追記をスキップ
        marker_exists = any(
            _parse_marker_id(m.group(1)) == sec.id
            for m in _MARKER_RE.finditer(project.content)
        )
        if not marker_exists:
            # project.content にスケルトットを追記（アウトラインからの追加時）
            depth = min(self._section_depth(sec, project.sections), 6)
            heading_level = "#" * depth  # depth=1→#(h1), depth=2→##(h2)
            # 親セクションのブロック末尾に挿入する（なければ末尾）
            meta = json.dumps({"id": sec.id, "summary": sec.summary or "", "parentId": sec.parent_id, "sectionOrder": sec.order}, ensure_ascii=False)
            skeleton = f"\n<!-- soki-section:{meta} -->\n{heading_level} {sec.title}\n\n"
            project.content = self._insert_section_skeleton(
                project.content, sec, skeleton, project.sections
            )

        self._mark_dirty(project_id)
        return sec

    @staticmethod
    def _section_depth(sec: Section, all_sections: list) -> int:
        """セクションの階層深さ（ルート=1）を返す。"""
        sec_by_id = {s.id: s for s in all_sections}
        d = 1
        pid = sec.parent_id
        while pid and pid in sec_by_id:
            d += 1
            pid = sec_by_id[pid].parent_id
        return d

    @staticmethod
    def _insert_section_skeleton(
        content: str, sec: Section, skeleton: str, all_sections: list
    ) -> str:
        """親セクションのブロック末尾にスケルトットを挿入する。

        親がない場合は文書末尾に追記する。
        """
        if not sec.parent_id:
            return content + skeleton

        # 親セクションのブロック範囲末尾を探す
        # 親マーカーの後、次の同レベル以上のマーカーの直前に挿入
        matches = list(_MARKER_RE.finditer(content))

        parent_match_idx = next(
            (i for i, m in enumerate(matches) if _parse_marker_id(m.group(1)) == sec.parent_id),
            None
        )
        if parent_match_idx is None:
            return content + skeleton

        # 親セクションのブロックの深さを把握する
        sec_by_id = {s.id: s for s in all_sections}

        def get_depth_by_id(sec_id: str) -> int:
            s = sec_by_id.get(sec_id)
            if not s:
                return 1
            d = 1
            pid = s.parent_id
            while pid and pid in sec_by_id:
                d += 1
                pid = sec_by_id[pid].parent_id
            return d

        parent_depth = get_depth_by_id(sec.parent_id)

        # 親マーカー以降の同じかより浅い深さの次のマーカーを探す
        insert_pos = len(content)
        for match in matches[parent_match_idx + 1:]:
            other_id = _parse_marker_id(match.group(1))
            if other_id:
                other_depth = get_depth_by_id(other_id)
                if other_depth <= parent_depth:
                    insert_pos = match.start()
                    break

        return content[:insert_pos] + skeleton + content[insert_pos:]

    async def update_section(
        self, project_id: str, section_id: str, data: SectionUpdate
    ) -> Section:
        project = await self.get_project(project_id)
        sec = self._find_or_raise(project.sections, section_id)
        if data.title is not None:
            sec.title = data.title
            # project.content 内の見出しタイトルも更新
            project.content = self._update_section_title_in_body(
                project.content, section_id, data.title
            )
        if data.summary is not None:
            sec.summary = data.summary
        if data.parent_id is not None:
            sec.parent_id = data.parent_id
        if data.order is not None:
            sec.order = data.order
        self._mark_dirty(project_id)
        return sec

    @staticmethod
    def _update_section_title_in_body(body: str, section_id: str, new_title: str) -> str:
        """project.content 内の特定セクションの見出しタイトルを更新する。新旧両マーカー形式対応。"""
        # 新旧両形式のマーカーにマッチするパターン
        pattern = re.compile(
            r'(<!-- soki-section:(?:\{[^}]*\}|' + re.escape(section_id) + r') -->\n)'
            r'(#{1,6} )([^\n]+)(\n)'
        )

        def replacer(m: re.Match) -> str:
            # マーカー内のIDが対象と一致するか確認
            marker = m.group(1)
            payload_match = re.search(r'<!-- soki-section:(\{[^}]*\}|[a-f0-9-]+) -->', marker)
            if not payload_match:
                return m.group(0)
            mid = _parse_marker_id(payload_match.group(1))
            if mid != section_id:
                return m.group(0)
            return m.group(1) + m.group(2) + new_title + m.group(4)

        return pattern.sub(replacer, body)

    async def delete_section(self, project_id: str, section_id: str) -> None:
        project = await self.get_project(project_id)
        project.sections = [s for s in project.sections if s.id != section_id]
        # project.content からそのセクションのマーカーブロックを除去する
        project.content = self.remove_section_from_body(project.content, section_id)
        self._mark_dirty(project_id)

    # ------------------------------------------------------------------
    # コンテンツ（本文テキスト）管理
    # ------------------------------------------------------------------

    async def get_content(self, project_id: str) -> str:
        project = await self.get_project(project_id)
        return project.content

    async def update_content(self, project_id: str, content: str) -> None:
        project = await self.get_project(project_id)
        project.content = content
        self._mark_dirty(project_id)

    async def update_section_in_body(
        self, project_id: str, section_id: str, new_body_text: str
    ) -> str:
        """project.content の特定セクションブロックの本文のみを置換し、
        更新後の全 content 文字列を返す。"""
        project = await self.get_project(project_id)
        project.content = self.replace_section_body(
            project.content, section_id, new_body_text
        )
        self._mark_dirty(project_id)
        return project.content

    @staticmethod
    def extract_section_body(body: str, section_id: str) -> str:
        """project.content から特定セクションのボディテキスト（見出し行除く）を抽出する。新旧両マーカー形式対応。"""
        pattern = re.compile(
            r'<!-- soki-section:(?:\{[^}]*\}|[a-f0-9-]+) -->\n'
            r'#{1,6} [^\n]+\n'
            r'(.*?)(?=<!-- soki-section:|$)',
            re.DOTALL
        )
        for m in pattern.finditer(body):
            # マーカーのIDが一致するブロックを探す
            marker_match = re.search(r'<!-- soki-section:(\{[^}]*\}|[a-f0-9-]+) -->', m.group(0))
            if marker_match and _parse_marker_id(marker_match.group(1)) == section_id:
                return m.group(1).strip()
        return ''

    @staticmethod
    def replace_section_body(body: str, section_id: str, new_body_text: str) -> str:
        """body の中から section_id のブロックを探して本文部分を置換する。新旧両マーカー形式対応。

        マーカー行と見出し行は保持し、その後の本文テキストのみを new_body_text に置換する。
        """
        pattern = re.compile(
            r'(<!-- soki-section:(?:\{[^}]*\}|[a-f0-9-]+) -->\n'
            r'#{1,6} [^\n]+\n)'
            r'(.*?)'
            r'(?=<!-- soki-section:|$)',
            re.DOTALL
        )
        replacement_text = new_body_text.strip()
        if replacement_text:
            replacement_text = "\n" + replacement_text + "\n\n"
        else:
            replacement_text = "\n\n"

        replaced = False

        def replacer(m: re.Match) -> str:
            nonlocal replaced
            if replaced:
                return m.group(0)
            marker_match = re.search(r'<!-- soki-section:(\{[^}]*\}|[a-f0-9-]+) -->', m.group(1))
            if marker_match and _parse_marker_id(marker_match.group(1)) == section_id:
                replaced = True
                return m.group(1) + replacement_text
            return m.group(0)

        result = pattern.sub(replacer, body)
        if not replaced:
            return body
        return result

    @staticmethod
    def remove_section_from_body(body: str, section_id: str) -> str:
        """body から特定セクションのマーカーブロックを除去する。新旧両マーカー形式対応。"""
        pattern = re.compile(
            r'<!-- soki-section:(?:\{[^}]*\}|[a-f0-9-]+) -->\n'
            r'#{1,6} [^\n]+\n'
            r'.*?'
            r'(?=<!-- soki-section:|$)',
            re.DOTALL
        )

        def remover(m: re.Match) -> str:
            marker_match = re.search(r'<!-- soki-section:(\{[^}]*\}|[a-f0-9-]+) -->', m.group(0))
            if marker_match and _parse_marker_id(marker_match.group(1)) == section_id:
                return ''
            return m.group(0)

        return pattern.sub(remover, body)

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
        # scope 引数は後方互換で受け取るが全体を返す
        return project.chat_history

    async def append_chat_message(
        self, project_id: str, scope: str, message
    ) -> None:
        project = await self.get_project(project_id)
        project.chat_history.append(message)

        # 最大メッセージ数を保持（コマンドはカウントしないなどの複雑な制御を一旦単純化し、そのまま上限を設けるか、userだけ数える）
        user_indices = [i for i, m in enumerate(project.chat_history) if m.role == "user"]
        if len(user_indices) > self.MAX_MESSAGES:
            trim_before = user_indices[-self.MAX_MESSAGES]
            project.chat_history = project.chat_history[trim_before:]
        self._mark_dirty(project_id)

    async def clear_chat_history(self, project_id: str, scope: str) -> None:
        project = await self.get_project(project_id)
        project.chat_history = []
        self._mark_dirty(project_id)

    async def append_command_message(
        self, project_id: str, scope: str, command_name: str, command_args: list[str],
        user_message: str | None = None,
        selected_section_id: str | None = None,
        selected_section_title: str | None = None,
        explicit_refs: list[str] | None = None,
        ref_names: list[str] | None = None,
    ) -> None:
        """コマンド実行を履歴に追加する。"""
        project = await self.get_project(project_id)

        # コマンド名 + 追加指示テキストを content に含める
        base_content = f"/{command_name}"
        if user_message and user_message.strip() and user_message.strip() != f"/{command_name}":
            base_content = f"/{command_name} {user_message.strip()}"

        message = ChatMessage(
            role="command",
            content=base_content,
            timestamp=datetime.now(),
            command_name=command_name,
            command_args=command_args,
            selected_section_id=selected_section_id,
            selected_section_title=selected_section_title,
            explicit_refs=explicit_refs or [],
            ref_names=ref_names or [],
            prompt_text=base_content,
        )
        project.chat_history.append(message)
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
