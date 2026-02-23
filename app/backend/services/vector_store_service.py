"""VectorStoreService — ソース要約の埋め込み永続化・類似検索"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from langchain_chroma import Chroma
    from chromadb.config import Settings

from app.backend.models import Project


class VectorStoreService:
    """プロジェクトごとに独立した ChromaDB コレクションを管理する。"""

    _cache: dict[str, "Chroma"] = {}

    async def upsert_source(
        self, project: Project, source_id: str, summary: str
    ) -> None:
        """ソース要約を ChromaDB に追加または更新する（delete-then-add）。"""
        try:
            store = self._get_store(project)
            await asyncio.to_thread(
                self._upsert_sync, store, source_id, summary
            )
        except Exception as e:
            logger.warning("VectorStore upsert 失敗 (source_id=%s): %s", source_id, e)

    async def remove_source(
        self, project: Project, source_id: str
    ) -> None:
        """ソースを ChromaDB から削除する。"""
        try:
            store = self._get_store(project)
            await asyncio.to_thread(
                self._delete_by_source_id, store, source_id
            )
        except Exception as e:
            logger.warning("VectorStore remove 失敗 (source_id=%s): %s", source_id, e)

    async def search_relevant_sources(
        self, project: Project, query: str, k: int = 5
    ) -> list[str]:
        """クエリに意味的に近いソース ID を最大 k 件返す。
        インデックスが空・埋め込みエラー時は [] を返す。"""
        try:
            store = self._get_store(project)
            docs = await asyncio.to_thread(
                store.similarity_search, query, k=k
            )
            return [
                doc.metadata["source_id"]
                for doc in docs
                if "source_id" in doc.metadata
            ]
        except Exception as e:
            logger.warning("VectorStore 検索失敗: %s", e)
            return []

    def invalidate_cache(self, project_id: str) -> None:
        """プロジェクト削除時にメモリキャッシュを破棄する。"""
        self._cache.pop(project_id, None)

    # ------------------------------------------------------------------
    # 内部ヘルパー
    # ------------------------------------------------------------------

    def _get_store(self, project: Project) -> "Chroma":
        """キャッシュまたはディスクから ChromaDB インスタンスを返す。"""
        if project.id in self._cache:
            return self._cache[project.id]

        from langchain_chroma import Chroma
        from chromadb.config import Settings

        persist_dir = str(
            __import__("pathlib").Path(project.data_dir)
            / "vectorstore"
            / "chroma_db"
        )
        collection_name = f"project_{project.id}_sources"
        embeddings = self._get_embeddings(project.settings)

        client_settings = Settings(anonymized_telemetry=False)

        store = Chroma(
            collection_name=collection_name,
            embedding_function=embeddings,
            client_settings=client_settings,
            persist_directory=persist_dir,
        )
        self._cache[project.id] = store
        return store

    def _get_embeddings(self, settings):
        """プロジェクト設定から OpenAIEmbeddings を生成する。"""
        from langchain_openai import OpenAIEmbeddings

        kwargs = {
            "api_key": settings.api_key or "dummy",
            "model": "text-embedding-3-small",
        }
        if settings.endpoint_url:
            kwargs["base_url"] = settings.endpoint_url
        return OpenAIEmbeddings(**kwargs)

    def _upsert_sync(self, store, source_id: str, summary: str) -> None:
        """delete-then-add パターンで冪等 upsert を実現する（同期処理）。"""
        self._delete_by_source_id(store, source_id)
        store.add_texts(
            texts=[summary],
            metadatas=[{"source_id": source_id}],
            ids=[source_id],
        )

    def _delete_by_source_id(self, store, source_id: str) -> None:
        """source_id に対応するドキュメントを削除する（同期処理）。"""
        try:
            store.delete(ids=[source_id])
        except Exception:
            pass
