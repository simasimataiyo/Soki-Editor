"""VectorStoreService ユニットテスト（TDD: テストを先に記述）"""
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.backend.models import LLMSettings, Project, Source
from app.backend.services.vector_store_service import VectorStoreService


@pytest.fixture
def project() -> Project:
    return Project(
        id="proj-vs",
        name="VectorStore テスト",
        created_at=datetime(2026, 1, 1),
        updated_at=datetime(2026, 1, 1),
        json_file_path="/tmp/proj-vs.json",
        data_dir="/tmp/proj-vs/data",
        settings=LLMSettings(api_key="sk-test", model="text-embedding-3-small"),
    )


@pytest.fixture
def service() -> VectorStoreService:
    return VectorStoreService()


class TestVectorStoreService:
    async def test_search_returns_empty_list_when_index_empty(
        self, service: VectorStoreService, project: Project
    ):
        """インデックスが空の場合、空リストを返す"""
        with patch.object(service, "_get_store") as mock_get_store:
            mock_store = MagicMock()
            mock_store.similarity_search.return_value = []
            mock_get_store.return_value = mock_store

            result = await service.search_relevant_sources(project, "クエリ", k=5)
            assert result == []

    async def test_search_returns_empty_list_on_embedding_error(
        self, service: VectorStoreService, project: Project
    ):
        """埋め込みエラー時は空リストを返す"""
        with patch.object(service, "_get_store") as mock_get_store:
            mock_store = MagicMock()
            mock_store.similarity_search.side_effect = Exception("API error")
            mock_get_store.return_value = mock_store

            result = await service.search_relevant_sources(project, "クエリ")
            assert result == []

    async def test_upsert_and_search_returns_source_id(
        self, service: VectorStoreService, project: Project
    ):
        """upsert 後に検索で該当ソース ID が返される"""
        from langchain_core.documents import Document

        with patch.object(service, "_get_store") as mock_get_store:
            mock_store = MagicMock()
            # upsert 動作のモック
            mock_store.delete = MagicMock()
            mock_store.add_texts = MagicMock()
            # 検索結果のモック
            mock_doc = MagicMock()
            mock_doc.metadata = {"source_id": "ref-001"}
            mock_store.similarity_search.return_value = [mock_doc]
            mock_get_store.return_value = mock_store

            await service.upsert_source(project, "ref-001", "テスト要約")
            result = await service.search_relevant_sources(project, "テスト", k=5)
            assert "ref-001" in result

    async def test_upsert_is_idempotent(
        self, service: VectorStoreService, project: Project
    ):
        """同一 source_id の二重 upsert で重複なし（delete-then-add パターン）"""
        with patch.object(service, "_get_store") as mock_get_store:
            mock_store = MagicMock()
            mock_store.delete = MagicMock()
            mock_store.add_texts = MagicMock()
            mock_get_store.return_value = mock_store

            await service.upsert_source(project, "ref-001", "要約v1")
            await service.upsert_source(project, "ref-001", "要約v2")

            # delete が両回呼ばれること（delete-then-add）
            assert mock_store.delete.call_count == 2

    async def test_remove_source(
        self, service: VectorStoreService, project: Project
    ):
        """削除後に検索が空を返す"""
        with patch.object(service, "_get_store") as mock_get_store:
            mock_store = MagicMock()
            mock_store.delete = MagicMock()
            mock_store.similarity_search.return_value = []
            mock_get_store.return_value = mock_store

            await service.remove_source(project, "ref-001")
            result = await service.search_relevant_sources(project, "テスト")
            assert result == []

    def test_invalidate_cache(
        self, service: VectorStoreService, project: Project
    ):
        """キャッシュのクリア"""
        service._cache["proj-vs"] = MagicMock()
        service.invalidate_cache("proj-vs")
        assert "proj-vs" not in service._cache
