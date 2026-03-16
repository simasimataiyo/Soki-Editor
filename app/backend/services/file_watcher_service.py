"""FileWatcherService — ファイルシステム監視・変更処理"""
from __future__ import annotations

import asyncio
import logging
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from watchdog.events import FileCreatedEvent, FileDeletedEvent, FileSystemEventHandler
from watchdog.observers import Observer

if TYPE_CHECKING:
    from app.backend.models import WatchEvent
    from app.backend.services.project_service import ProjectService

logger = logging.getLogger("app.file_watcher")

# sources/ で監視対象の拡張子
_SOURCE_EXTENSIONS = {".txt", ".md", ".pdf", ".csv"}
# materials/ で監視対象の拡張子
_MATERIAL_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}

# デバウンス秒数
_DEBOUNCE_SECONDS = 1.0


class _SokiEventHandler(FileSystemEventHandler):
    """watchdog イベントを asyncio キューに渡すハンドラ。"""

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        queue: asyncio.Queue,
        project_id: str,
        project_dir: Path,
    ) -> None:
        super().__init__()
        self._loop = loop
        self._queue = queue
        self._project_id = project_id
        self._project_dir = project_dir
        # デバウンスタイマー {path_str: threading.Timer}
        self._debounce_timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()

    def on_created(self, event: FileCreatedEvent) -> None:  # type: ignore[override]
        if event.is_directory:
            return
        self._debounce(event.src_path, "created")

    def on_deleted(self, event: FileDeletedEvent) -> None:  # type: ignore[override]
        if event.is_directory:
            return
        # 削除はデバウンス不要（ファイルが消えているため即時処理）
        self._submit(event.src_path, "deleted")

    def _debounce(self, path_str: str, event_type: str) -> None:
        with self._lock:
            timer = self._debounce_timers.get(path_str)
            if timer is not None:
                timer.cancel()
            t = threading.Timer(_DEBOUNCE_SECONDS, self._submit, args=(path_str, event_type))
            self._debounce_timers[path_str] = t
            t.start()

    def _submit(self, path_str: str, event_type: str) -> None:
        with self._lock:
            self._debounce_timers.pop(path_str, None)
        asyncio.run_coroutine_threadsafe(
            self._handle(path_str, event_type), self._loop
        )

    async def _handle(self, path_str: str, event_type: str) -> None:
        self._queue.put_nowait((self._project_id, path_str, event_type))


class FileWatcherService:
    """プロジェクトディレクトリの sources/ と materials/ を監視し、
    ファイル追加・削除に応じて Source / Material エントリを自動管理する。
    最大 1 プロジェクトのみ同時監視。"""

    def __init__(self) -> None:
        self._observer: Observer | None = None
        self._current_project_id: str | None = None
        self._raw_queue: asyncio.Queue[tuple[str, str, str]] = asyncio.Queue()
        self._lock = threading.Lock()
        self._processor_task: asyncio.Task | None = None
        self._project_service: ProjectService | None = None
        # Observer 再起動カウンタ
        self._restart_count: int = 0
        self._max_restarts: int = 3
        # 監視中のプロジェクトディレクトリ
        self._project_dir: Path | None = None
        # SSE subscriber キュー（fan-out ブロードキャスト）
        self._subscribers: list[asyncio.Queue] = []
        self._sub_lock = threading.Lock()

    def set_project_service(self, svc: ProjectService) -> None:
        self._project_service = svc

    def subscribe(self) -> asyncio.Queue:
        """新しい SSE クライアントキューを作成して登録する。"""
        q: asyncio.Queue = asyncio.Queue()
        with self._sub_lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        """SSE クライアントキューの登録を解除する。"""
        with self._sub_lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass

    async def broadcast_event(self, event: object) -> None:
        """外部からイベントをブロードキャストする（sync_complete など）。"""
        await self._broadcast(event)

    # ------------------------------------------------------------------
    # 公開インターフェース
    # ------------------------------------------------------------------

    async def start_watching(self, project_id: str, project_dir: Path) -> None:
        """指定プロジェクトの監視を開始する。既存監視があれば停止してから開始する。"""
        await self.stop_watching()

        with self._lock:
            self._current_project_id = project_id
            self._project_dir = project_dir
            self._restart_count = 0

        loop = asyncio.get_event_loop()
        self._start_observer(project_id, project_dir, loop)

        # イベント処理タスクを開始
        self._processor_task = asyncio.create_task(self._process_events())
        logger.info("ファイル監視開始: project_id=%s dir=%s", project_id, project_dir)

    async def stop_watching(self, project_id: str | None = None) -> None:
        """監視を停止する。project_id が None の場合は現在の監視を停止する。"""
        with self._lock:
            if project_id is not None and self._current_project_id != project_id:
                return
            current = self._current_project_id
            self._current_project_id = None
            self._project_dir = None

        if current is None:
            return

        if self._processor_task is not None:
            self._processor_task.cancel()
            try:
                await self._processor_task
            except asyncio.CancelledError:
                pass
            self._processor_task = None

        self._stop_observer()
        logger.info("ファイル監視停止: project_id=%s", current)

    async def sync_files(self, project_id: str) -> dict[str, int]:
        """ディレクトリと登録済みエントリを照合し差分を同期する。
        Returns: {"added": N, "removed": M}
        """
        if self._project_service is None:
            raise RuntimeError("ProjectService が設定されていません")

        svc = self._project_service
        project = await svc.get_project(project_id)
        project_dir = Path(project.json_file_path).parent

        added = 0
        removed = 0

        # ── sources 同期 ────────────────────────────────
        sources_dir = project_dir / "sources"
        if sources_dir.exists():
            # ディレクトリ上の対象ファイル一覧
            real_files: dict[str, Path] = {
                str(p): p
                for p in sources_dir.iterdir()
                if p.is_file() and p.suffix.lower() in _SOURCE_EXTENSIONS
            }
            registered_paths = {s.file_path for s in project.sources if s.file_path}

            # 未登録ファイルを追加
            for path_str, path in real_files.items():
                if path_str not in registered_paths:
                    try:
                        await self._create_source_from_file(project_id, path)
                        added += 1
                    except Exception:
                        logger.exception("sync: source 追加失敗: %s", path_str)

            # 消えたエントリを削除
            for src in list(project.sources):
                if src.file_path and src.file_path not in real_files:
                    # sources/ 配下のファイルのみ対象（手動登録は除外）
                    if src.file_path.startswith(str(sources_dir)):
                        try:
                            await svc.delete_source(project_id, src.id)
                            removed += 1
                        except Exception:
                            logger.exception("sync: source 削除失敗: %s", src.id)

        # ── materials 同期 ──────────────────────────────
        materials_dir = project_dir / "materials"
        if materials_dir.exists():
            real_mats: dict[str, Path] = {
                str(p): p
                for p in materials_dir.iterdir()
                if p.is_file() and p.suffix.lower() in _MATERIAL_EXTENSIONS
            }
            registered_mat_paths = {m.file_path for m in project.materials if m.file_path}

            for path_str, path in real_mats.items():
                if path_str not in registered_mat_paths:
                    try:
                        await self._create_material_from_file(project_id, path)
                        added += 1
                    except Exception:
                        logger.exception("sync: material 追加失敗: %s", path_str)

            for mat in list(project.materials):
                if mat.file_path and mat.file_path not in real_mats:
                    if mat.file_path.startswith(str(materials_dir)):
                        try:
                            await svc.delete_material(project_id, mat.id)
                            removed += 1
                        except Exception:
                            logger.exception("sync: material 削除失敗: %s", mat.id)

        return {"added": added, "removed": removed}

    # ------------------------------------------------------------------
    # 内部: Observer 管理
    # ------------------------------------------------------------------

    def _start_observer(
        self, project_id: str, project_dir: Path, loop: asyncio.AbstractEventLoop
    ) -> None:
        """watchdog Observer を起動してsources/ materials/ を監視する。"""
        handler = _SokiEventHandler(loop, self._raw_queue, project_id, project_dir)
        observer = Observer()

        # sources/ と materials/ のみ監視（再帰なし）
        for subdir in ("sources", "materials"):
            target = project_dir / subdir
            target.mkdir(parents=True, exist_ok=True)
            observer.schedule(handler, str(target), recursive=False)

        observer.start()
        with self._lock:
            self._observer = observer

    def _stop_observer(self) -> None:
        with self._lock:
            observer = self._observer
            self._observer = None

        if observer is not None:
            try:
                observer.stop()
                observer.join(timeout=5)
            except Exception:
                logger.exception("Observer 停止中にエラー")

    # ------------------------------------------------------------------
    # 内部: イベント処理ループ
    # ------------------------------------------------------------------

    async def _process_events(self) -> None:
        """raw_queue からイベントを取り出し、Source/Material の追加・削除を処理する。
        Observer の異常終了を 5 秒間隔でチェックし、最大 3 回まで再起動を試みる。"""
        _CHECK_INTERVAL = 5.0
        _last_check = asyncio.get_event_loop().time()

        while True:
            try:
                try:
                    project_id, path_str, event_type = await asyncio.wait_for(
                        self._raw_queue.get(), timeout=_CHECK_INTERVAL
                    )
                    await self._dispatch(project_id, path_str, event_type)
                    self._raw_queue.task_done()
                except asyncio.TimeoutError:
                    pass

                # Observer 死活チェック
                now = asyncio.get_event_loop().time()
                if now - _last_check >= _CHECK_INTERVAL:
                    _last_check = now
                    await self._check_observer_health()

            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("イベント処理中にエラー")

    async def _check_observer_health(self) -> None:
        """Observer スレッドが停止していた場合に再起動を試みる（最大 3 回）。"""
        with self._lock:
            observer = self._observer
            current = self._current_project_id
            project_dir = self._project_dir
            restart_count = self._restart_count

        if observer is None or current is None or project_dir is None:
            return

        if observer.is_alive():
            return

        # Observer 停止を検知
        logger.warning("Observer スレッドが停止しました。再起動を試みます（%d/%d）", restart_count + 1, self._max_restarts)

        if restart_count >= self._max_restarts:
            logger.error("Observer 再起動の最大試行回数に達しました。監視を停止します。")
            with self._lock:
                self._observer = None
            return

        with self._lock:
            self._restart_count += 1

        try:
            loop = asyncio.get_event_loop()
            self._stop_observer()
            self._start_observer(current, project_dir, loop)
            logger.info("Observer 再起動成功: project_id=%s", current)
        except Exception:
            logger.exception("Observer 再起動失敗")

    async def _dispatch(self, project_id: str, path_str: str, event_type: str) -> None:
        """ファイルパスとイベント種別に応じてハンドラを呼び出す。"""
        # 現在監視中のプロジェクトかチェック
        with self._lock:
            current = self._current_project_id
            project_dir = self._project_dir
        if current != project_id or project_dir is None:
            return

        path = Path(path_str)

        # ── パス安全性チェック（ディレクトリトラバーサル防止）────
        try:
            path.resolve().relative_to(project_dir.resolve())
        except ValueError:
            logger.warning("プロジェクトディレクトリ外のパスは無視します: %s", path_str)
            return

        suffix = path.suffix.lower()
        parent_name = path.parent.name  # "sources" or "materials"

        if event_type == "created":
            # ファイルサイズ 0 はスキップ（書き込み中の誤検知防止）
            try:
                if path.stat().st_size == 0:
                    logger.debug("サイズ 0 のファイルをスキップ: %s", path_str)
                    return
            except FileNotFoundError:
                return

            if parent_name == "sources" and suffix in _SOURCE_EXTENSIONS:
                await self._handle_source_added(project_id, path)
            elif parent_name == "materials" and suffix in _MATERIAL_EXTENSIONS:
                await self._handle_material_added(project_id, path)

        elif event_type == "deleted":
            if parent_name == "sources":
                await self._handle_source_removed(project_id, path)
            elif parent_name == "materials":
                await self._handle_material_removed(project_id, path)

    # ------------------------------------------------------------------
    # 内部: Source / Material 操作
    # ------------------------------------------------------------------

    async def _handle_source_added(self, project_id: str, path: Path) -> None:
        if self._project_service is None:
            return
        project = await self._project_service.get_project(project_id)
        # 重複チェック
        if any(s.file_path == str(path) for s in project.sources):
            logger.debug("ソース重複スキップ: %s", path)
            return
        src = await self._create_source_from_file(project_id, path)
        await self._put_event("source_added", project_id, src.id)

    async def _handle_source_removed(self, project_id: str, path: Path) -> None:
        if self._project_service is None:
            return
        project = await self._project_service.get_project(project_id)
        src = next((s for s in project.sources if s.file_path == str(path)), None)
        if src is None:
            return
        await self._project_service.delete_source(project_id, src.id)
        await self._put_event("source_removed", project_id, src.id)

    async def _handle_material_added(self, project_id: str, path: Path) -> None:
        if self._project_service is None:
            return
        project = await self._project_service.get_project(project_id)
        if any(m.file_path == str(path) for m in project.materials):
            logger.debug("マテリアル重複スキップ: %s", path)
            return
        mat = await self._create_material_from_file(project_id, path)
        await self._put_event("material_added", project_id, mat.id)

    async def _handle_material_removed(self, project_id: str, path: Path) -> None:
        if self._project_service is None:
            return
        project = await self._project_service.get_project(project_id)
        mat = next((m for m in project.materials if m.file_path == str(path)), None)
        if mat is None:
            return
        await self._project_service.delete_material(project_id, mat.id)
        await self._put_event("material_removed", project_id, mat.id)

    async def _create_source_from_file(self, project_id: str, path: Path) -> object:
        """ファイルから Source エントリを作成し、テキスト抽出・PDF画像生成を行う。"""
        from app.backend.models import SourceUpdate
        from app.backend.services.file_service import FileService
        from app.backend.services.global_settings_service import get_settings_service

        svc = self._project_service
        src = await svc.add_source(project_id)
        # 名前をファイル名（拡張子なし）に設定
        stem = path.stem
        await svc.update_source(
            project_id, src.id,
            SourceUpdate(name=stem, file_path=str(path)),
        )

        suffix = path.suffix.lower()
        file_type = "pdf" if suffix == ".pdf" else suffix.lstrip(".") or "text"

        # テキスト抽出
        text = ""
        try:
            file_svc = FileService()
            text = await file_svc.read_file_as_text(str(path))
        except Exception:
            logger.exception("テキスト抽出失敗: %s", path)

        # PDF ページ画像生成
        if suffix == ".pdf":
            try:
                project = await svc.get_project(project_id)
                from app.backend.services.project_service import ProjectService
                src_meta_dir = ProjectService._source_metadata_dir(project, src.id)
                page_dir = src_meta_dir / "page"
                thumb_dir = src_meta_dir / "thumbnails"
                page_dir.mkdir(parents=True, exist_ok=True)
                thumb_dir.mkdir(parents=True, exist_ok=True)
                raw_dpi = get_settings_service().get().pdf_page_dpi

                import asyncio as _asyncio
                import fitz  # noqa: PLC0415

                def _gen_pdf_images(path_str: str, td: str, pd: str, dpi: int) -> None:
                    doc = fitz.open(path_str)
                    for i in range(len(doc)):
                        pg = doc.load_page(i)
                        pg.get_pixmap(dpi=72).save(str(Path(td) / f"page_{i}.jpg"))
                        pg.get_pixmap(dpi=dpi).save(str(Path(pd) / f"page_raw_{i}.jpg"))
                    doc.close()

                await _asyncio.to_thread(
                    _gen_pdf_images, str(path), str(thumb_dir), str(page_dir), raw_dpi
                )
            except Exception:
                logger.exception("PDF 画像生成失敗: %s", path)

        src = await svc.update_source(
            project_id, src.id,
            SourceUpdate(full_text=text, file_path=str(path), file_type=file_type),
        )
        return src

    async def _create_material_from_file(self, project_id: str, path: Path) -> object:
        """ファイルから Material エントリを作成し、サムネイルを生成する。"""
        from app.backend.models import MaterialUpdate
        from app.backend.services.file_service import FileService
        from app.backend.services.project_service import ProjectService

        svc = self._project_service
        mat = await svc.add_material(project_id)

        stem = path.stem
        await svc.update_material(
            project_id, mat.id,
            MaterialUpdate(name=stem, file_path=str(path)),
        )

        # サムネイル生成
        thumb_path = None
        try:
            project = await svc.get_project(project_id)
            thumb_dir = ProjectService._material_metadata_dir(project, mat.id)
            thumb_dir.mkdir(parents=True, exist_ok=True)
            thumb_dest = str(thumb_dir / f"{mat.id}_thumb.png")
            file_svc = FileService()
            thumb_path = await file_svc.generate_thumbnail_to(str(path), thumb_dest)
        except Exception:
            logger.exception("サムネイル生成失敗: %s", path)

        mat = await svc.update_material(
            project_id, mat.id,
            MaterialUpdate(thumbnail_path=thumb_path),
        )
        return mat

    async def _put_event(self, event_type: str, project_id: str, item_id: str) -> None:
        from app.backend.models import WatchEvent
        event = WatchEvent(type=event_type, project_id=project_id, item_id=item_id)
        await self._broadcast(event)

    async def _broadcast(self, event: object) -> None:
        """全 subscriber キューにイベントをブロードキャストする。"""
        with self._sub_lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("subscriber キューが満杯。イベントをドロップ: %s", event)
        logger.debug("WatchEvent ブロードキャスト (%d 件): %s", len(subs), event)
