"""API 統合テスト (Task 18.5)

テスト対象:
- チャット SSE ストリームの chunk → tool_call → done イベント順序
- 要約生成後に VectorStoreService へのインデックス登録
- ソース削除後に類似検索が該当 ID を返さない
- エクスポート結果の全セクション含有・参照番号変換・参考文献末尾付与
- ルール・ソースの CSV インポート・エクスポートのラウンドトリップ一致
- プロジェクト作成時の JSON ファイルパスとデータディレクトリの分離
"""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.backend.main import app
from app.backend.models import (
    Bibliography,
    RuleCreate,
    SectionCreate,
    SectionUpdate,
    SourceUpdate,
)
from app.backend.services.project_service import ProjectService
import app.backend.routers.projects as proj_router


# ─── フィクスチャ ────────────────────────────────────────────────────────────


@pytest.fixture
def tmp_svc(tmp_path: Path) -> ProjectService:
    """テスト用 ProjectService（一時レジストリ）を DI する。"""
    svc = ProjectService(registry_path=str(tmp_path / "registry.json"))
    proj_router.set_service(svc)
    yield svc
    proj_router.set_service(None)  # 後始末：次テストで再生成させる


@pytest.fixture
async def ac(tmp_svc: ProjectService):
    """httpx.AsyncClient with ASGI transport。"""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
async def pid(tmp_svc: ProjectService, tmp_path: Path) -> str:
    """テスト用プロジェクトを作成して ID を返す。"""
    p = await tmp_svc.create_project(
        "統合テスト", str(tmp_path / "proj.json"), str(tmp_path / "data")
    )
    return p.id


# ─── 1. プロジェクト作成：JSON ファイルパスとデータディレクトリの分離 ────


class TestProjectCreation:
    async def test_json_path_and_data_dir_are_separate(
        self, ac: httpx.AsyncClient, tmp_path: Path
    ) -> None:
        """json_file_path と data_dir が別ディレクトリに設定されること。"""
        json_path = str(tmp_path / "myproject.json")
        data_dir = str(tmp_path / "mydata")
        resp = await ac.post(
            "/api/projects",
            json={"name": "テスト", "json_file_path": json_path, "data_dir": data_dir},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["json_file_path"] == json_path
        assert body["data_dir"] == data_dir
        # 2 つのパスが異なること
        assert Path(body["json_file_path"]) != Path(body["data_dir"])

    async def test_project_json_file_is_written_to_disk(
        self, ac: httpx.AsyncClient, tmp_path: Path
    ) -> None:
        """作成時に JSON ファイルがディスクへ保存されること。"""
        json_path = str(tmp_path / "created.json")
        await ac.post(
            "/api/projects",
            json={
                "name": "ファイル確認",
                "json_file_path": json_path,
                "data_dir": str(tmp_path / "data"),
            },
        )
        assert Path(json_path).exists()
        with open(json_path, encoding="utf-8") as f:
            saved = json.load(f)
        assert saved["name"] == "ファイル確認"

    async def test_recent_projects_lists_created_project(
        self, ac: httpx.AsyncClient, tmp_path: Path
    ) -> None:
        """最近使用一覧に作成プロジェクトが含まれること。"""
        json_path = str(tmp_path / "recent.json")
        create_resp = await ac.post(
            "/api/projects",
            json={
                "name": "最近使用テスト",
                "json_file_path": json_path,
                "data_dir": str(tmp_path / "data"),
            },
        )
        project_id = create_resp.json()["id"]
        recent_resp = await ac.get("/api/projects/recent")
        assert recent_resp.status_code == 200
        ids = [p["id"] for p in recent_resp.json()]
        assert project_id in ids


# ─── 2. エクスポート：全セクション・参照番号変換・参考文献末尾付与 ──────


class TestExportEndpoint:
    async def test_export_contains_all_sections(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """エクスポート Markdown に全セクションのタイトルが含まれること。"""
        await tmp_svc.add_section(pid, SectionCreate(title="序章", level=1, content="序章本文"))
        await tmp_svc.add_section(pid, SectionCreate(title="結論", level=1, content="結論本文"))

        resp = await ac.get(f"/api/projects/{pid}/export")
        assert resp.status_code == 200
        md = resp.text
        assert "序章" in md
        assert "結論" in md

    async def test_export_resolves_reference_numbers(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """[^ref-ID] が [N] に変換されること。"""
        # ソースを追加して include_in_references=True に設定
        src = await tmp_svc.add_source(pid)
        await tmp_svc.update_source(
            pid,
            src.id,
            SourceUpdate(
                bibliography=Bibliography(
                    title="参照テスト論文",
                    author="著者A",
                    year="2024",
                    include_in_references=True,
                ),
            ),
        )
        # セクション本文で source ID を参照
        sec = await tmp_svc.add_section(
            pid,
            SectionCreate(title="本文", level=1, content=f"本文テキスト [^{src.id}]"),
        )

        resp = await ac.get(f"/api/projects/{pid}/export")
        assert resp.status_code == 200
        md = resp.text
        # [^ref-xxx] が [1] に変換されている
        assert "[1]" in md
        assert f"[^{src.id}]" not in md

    async def test_export_appends_bibliography_at_end(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """include_in_references=True のソースが末尾の参考文献に含まれること。"""
        src = await tmp_svc.add_source(pid)
        await tmp_svc.update_source(
            pid,
            src.id,
            SourceUpdate(
                bibliography=Bibliography(
                    title="末尾確認論文",
                    author="著者B",
                    year="2023",
                    include_in_references=True,
                ),
            ),
        )
        # セクション本文でソースを引用
        await tmp_svc.add_section(
            pid,
            SectionCreate(title="章", level=1, content=f"本文 [^{src.id}]"),
        )

        resp = await ac.get(f"/api/projects/{pid}/export")
        md = resp.text
        bib_pos = md.find("参考文献")
        paper_pos = md.find("末尾確認論文")
        # 参考文献セクションの後に論文タイトルが出現すること
        assert bib_pos != -1
        assert paper_pos > bib_pos

    async def test_export_excludes_source_not_in_references(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """include_in_references=False のソースは参考文献に含まれないこと。"""
        src = await tmp_svc.add_source(pid)
        await tmp_svc.update_source(
            pid,
            src.id,
            SourceUpdate(
                bibliography=Bibliography(
                    title="非掲載論文",
                    author="著者C",
                    year="2022",
                    include_in_references=False,
                ),
            ),
        )
        await tmp_svc.add_section(pid, SectionCreate(title="章", level=1, content="本文"))

        resp = await ac.get(f"/api/projects/{pid}/export")
        md = resp.text
        assert "非掲載論文" not in md

    async def test_export_content_disposition_header(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """Content-Disposition: attachment が設定されること。"""
        await tmp_svc.add_section(pid, SectionCreate(title="章", level=1, content="本文"))
        resp = await ac.get(f"/api/projects/{pid}/export")
        assert resp.status_code == 200
        assert "attachment" in resp.headers.get("content-disposition", "")


# ─── 3. ルール CSV ラウンドトリップ ──────────────────────────────────────


class TestRuleCsvRoundtrip:
    async def test_export_then_import_matches(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """ルールを登録 → CSV エクスポート → 別プロジェクトにインポートで一致。"""
        # カテゴリとルールを作成
        cat = await tmp_svc.add_rule_category(pid, "文体")
        await tmp_svc.add_rule(pid, RuleCreate(category_id=cat.id, content="敬体で統一する"))
        await tmp_svc.add_rule(pid, RuleCreate(category_id=cat.id, content="一文は80文字以内"))

        # CSV エクスポート
        export_resp = await ac.get(f"/api/projects/{pid}/rules/export")
        assert export_resp.status_code == 200
        csv_bytes = export_resp.content

        # 別プロジェクトを作成してインポート
        from pathlib import Path as _P
        import tempfile, os
        with tempfile.TemporaryDirectory() as td:
            json2 = str(_P(td) / "proj2.json")
            data2 = str(_P(td) / "data2")
            p2_resp = await ac.post(
                "/api/projects",
                json={"name": "インポート先", "json_file_path": json2, "data_dir": data2},
            )
            pid2 = p2_resp.json()["id"]

            import_resp = await ac.post(
                f"/api/projects/{pid2}/rules/import",
                files={"file": ("rules.csv", csv_bytes, "text/csv")},
            )
            assert import_resp.status_code == 200
            assert import_resp.json()["imported"] == 2

            # インポート後のルールを確認
            rules_resp = await ac.get(f"/api/projects/{pid2}/rules")
            rules = rules_resp.json()
            contents = {r["content"] for r in rules}
            assert "敬体で統一する" in contents
            assert "一文は80文字以内" in contents

    async def test_csv_format_has_correct_columns(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """CSV の列が「カテゴリ, ルール内容」形式であること。"""
        cat = await tmp_svc.add_rule_category(pid, "書式")
        await tmp_svc.add_rule(pid, RuleCreate(category_id=cat.id, content="見出しはATX形式"))

        resp = await ac.get(f"/api/projects/{pid}/rules/export")
        reader = csv.reader(io.StringIO(resp.text))
        rows = list(reader)
        assert rows[0] == ["カテゴリ", "ルール内容"]
        assert rows[1][0] == "書式"
        assert rows[1][1] == "見出しはATX形式"


# ─── 4. ソース CSV ラウンドトリップ ──────────────────────────────────────


class TestSourceCsvRoundtrip:
    async def test_export_then_import_source_count(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """ソースを登録 → CSV エクスポート → インポートで件数が一致。"""
        # ソースを 2 件追加
        s1 = await tmp_svc.add_source(pid)
        await tmp_svc.update_source(
            pid,
            s1.id,
            SourceUpdate(
                id=s1.id,
                bibliography=Bibliography(bib_type="paper", title="論文A", author="著者A"),
            ),
        )
        s2 = await tmp_svc.add_source(pid)
        await tmp_svc.update_source(
            pid,
            s2.id,
            SourceUpdate(
                id=s2.id,
                bibliography=Bibliography(bib_type="book", title="図書B", author="著者B"),
            ),
        )

        # CSV エクスポート
        export_resp = await ac.get(f"/api/projects/{pid}/sources/export")
        assert export_resp.status_code == 200
        csv_bytes = export_resp.content

        # 別プロジェクトに インポート
        import tempfile
        from pathlib import Path as _P
        with tempfile.TemporaryDirectory() as td:
            json2 = str(_P(td) / "proj2.json")
            data2 = str(_P(td) / "data2")
            p2 = await ac.post(
                "/api/projects",
                json={"name": "ソースインポート先", "json_file_path": json2, "data_dir": data2},
            )
            pid2 = p2.json()["id"]

            imp = await ac.post(
                f"/api/projects/{pid2}/sources/import",
                files={"file": ("sources.csv", csv_bytes, "text/csv")},
            )
            assert imp.status_code == 200
            assert imp.json()["imported"] == 2

            # タイトルが一致すること
            sources_resp = await ac.get(f"/api/projects/{pid2}/sources")
            titles = {s["bibliography"]["title"] for s in sources_resp.json()}
            assert "論文A" in titles
            assert "図書B" in titles


# ─── 5. チャット SSE ストリームのイベント順序 ────────────────────────────


class TestChatSseEventOrder:
    async def test_chunk_then_done_event_order(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """SSE ストリームが chunk → done の順でイベントを返すこと。"""

        async def _fake_stream(*args, **kwargs):
            yield 'data: {"type": "chunk", "text": "こんにちは"}\n\n'
            yield 'data: {"type": "chunk", "text": "世界"}\n\n'
            yield 'data: {"type": "done"}\n\n'

        with patch("app.backend.routers.llm._llm_service") as mock_llm:
            mock_llm.chat_stream = _fake_stream

            resp = await ac.post(
                f"/api/projects/{pid}/chat",
                json={
                    "user_message": "テスト",
                    "context_scope": "all",
                    "use_full_sources": False,
                },
            )
        assert resp.status_code == 200

        # SSE テキストを解析してイベント順序を検証
        events = []
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                try:
                    data = json.loads(line[5:].strip())
                    events.append(data["type"])
                except Exception:
                    pass

        assert "chunk" in events
        assert "done" in events
        # chunk が done より先に出現すること
        assert events.index("chunk") < events.index("done")

    async def test_chunk_then_tool_call_then_done(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """tool_call イベントが chunk と done の間に出現すること。"""
        sec = await tmp_svc.add_section(
            pid, SectionCreate(title="テストセクション", level=1, content="初期本文")
        )

        async def _fake_stream_with_tool(*args, **kwargs):
            yield 'data: {"type": "chunk", "text": "修正案："}\n\n'
            yield (
                f'data: {{"type": "tool_call", "name": "update_section",'
                f' "args": {{"section_id": "{sec.id}", "content": "新本文"}}}}\n\n'
            )
            yield 'data: {"type": "done"}\n\n'

        with patch("app.backend.routers.llm._llm_service") as mock_llm:
            mock_llm.chat_stream = _fake_stream_with_tool

            resp = await ac.post(
                f"/api/projects/{pid}/chat",
                json={
                    "user_message": "セクションを修正して",
                    "context_scope": "all",
                    "use_full_sources": False,
                },
            )
        assert resp.status_code == 200

        events = []
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                try:
                    data = json.loads(line[5:].strip())
                    events.append(data["type"])
                except Exception:
                    pass

        assert events.index("chunk") < events.index("tool_call")
        assert events.index("tool_call") < events.index("done")


# ─── 6. 要約生成後の VectorStore インデックス登録 ──────────────────────


class TestSummarizeAndVectorIndex:
    async def test_summarize_calls_vector_store_upsert(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """要約生成後に VectorStoreService.upsert_source が呼ばれること。"""
        src = await tmp_svc.add_source(pid)
        await tmp_svc.update_source(
            pid,
            src.id,
            SourceUpdate(
                id=src.id,
                full_text="これはテスト用の全文テキストです。",
                bibliography=Bibliography(bib_type="paper", title="要約テスト"),
            ),
        )

        with patch("app.backend.routers.sources._llm_service") as mock_llm, \
             patch("app.backend.routers.sources._vs_service") as mock_vs:
            mock_llm.generate_summary = AsyncMock(return_value="要約テキスト")
            mock_vs.upsert_source = AsyncMock()

            resp = await ac.post(f"/api/projects/{pid}/sources/{src.id}/summarize")

        assert resp.status_code == 200
        mock_vs.upsert_source.assert_called_once()
        # 要約がソースに保存されていること
        project = await tmp_svc.get_project(pid)
        updated_src = next(s for s in project.sources if s.id == src.id)
        assert updated_src.summary == "要約テキスト"


# ─── 7. ソース削除後の類似検索 ──────────────────────────────────────────


class TestSourceDeletionAndVectorSearch:
    async def test_delete_source_removes_from_vector_store(
        self, ac: httpx.AsyncClient, pid: str, tmp_svc: ProjectService
    ) -> None:
        """ソース削除時に VectorStoreService.remove_source が呼ばれること。"""
        src = await tmp_svc.add_source(pid)

        with patch("app.backend.routers.sources._vs_service") as mock_vs:
            mock_vs.remove_source = AsyncMock()
            resp = await ac.delete(f"/api/projects/{pid}/sources/{src.id}")

        assert resp.status_code == 200
        mock_vs.remove_source.assert_called_once()

        # ソースがプロジェクトから削除されていること
        project = await tmp_svc.get_project(pid)
        assert all(s.id != src.id for s in project.sources)
