"""ソース CRUD・ファイル読み込み・CSV インポート/エクスポート API"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.backend.models import Bibliography, Source, SourceUpdate, SourcesReorder
from app.backend.routers.projects import get_service
from app.backend.routers.settings import get_service as get_settings_service
from app.backend.services.file_service import FileService
from app.backend.services.llm_service import LLMService
from app.backend.services.project_service import ProjectService

router = APIRouter(prefix="/api/projects/{project_id}", tags=["sources"])
_llm_service = LLMService()
_file_service = FileService()

_LONG_SUMMARY_EXTS = {".txt", ".md", ".pdf", ".docx", ".pptx"}
_SHORT_ONLY_EXTS = {".csv", ".xlsx"}
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}


def _should_generate_extended_summary(src: Source) -> bool:
    """長文の要約を生成するか判別する"""
    if src.file_type == "image":
        return False
    if src.file_type in {"csv", "xlsx"}:
        return False
    if src.file_type in {"pdf", "txt", "md", "docx", "pptx", "text"}:
        return True
    if src.file_path:
        suffix = Path(src.file_path).suffix.lower()
        if suffix in _SHORT_ONLY_EXTS:
            return False
        if suffix in _LONG_SUMMARY_EXTS:
            return True
    return True


def _not_found(project_id: str):
    raise HTTPException(status_code=404, detail=f"プロジェクトが見つかりません: {project_id}")


async def _get_project_or_404(svc, project_id: str):
    try:
        return await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)


def _get_source_or_404(project, source_id: str) -> Source:
    src = next((s for s in project.sources if s.id == source_id), None)
    if not src:
        raise HTTPException(status_code=404, detail="ソースが見つかりません")
    return src


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass


def _safe_rmtree(path: Path) -> None:
    if not path.exists():
        return
    import shutil
    try:
        shutil.rmtree(path)
    except Exception:
        pass


def _delete_related_files(base_dir: Path, item_id: str) -> None:
    for old in list(base_dir.glob(f"{item_id}_*")) + list(base_dir.glob(f"{item_id}.*")):
        _safe_unlink(old)


async def _build_summary_update(src: Source, *, clear_extended_when_short: bool) -> SourceUpdate:
    settings = get_settings_service().get()
    if _should_generate_extended_summary(src):
        summary, extended_summary = await asyncio.gather(
            _llm_service.generate_summary(src.full_text, settings),
            _llm_service.generate_extended_summary(src.full_text, settings),
        )
        return SourceUpdate(summary=summary, extended_summary=extended_summary)
    summary = await _llm_service.generate_summary(src.full_text, settings)
    if clear_extended_when_short:
        return SourceUpdate(summary=summary, extended_summary="")
    return SourceUpdate(summary=summary)


# ─── ソース CRUD ──────────────────────────────────────────────


@router.get("/sources", response_model=list[Source])
async def list_sources(project_id: str) -> list[Source]:
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)
    return project.sources


@router.post("/sources", response_model=Source)
async def create_source(project_id: str) -> Source:
    svc = get_service()
    try:
        return await svc.add_source(project_id)
    except KeyError:
        _not_found(project_id)


@router.put("/sources/{source_id}", response_model=Source)
async def update_source(project_id: str, source_id: str, body: SourceUpdate) -> Source:
    svc = get_service()
    try:
        return await svc.update_source(project_id, source_id, body)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/sources/{source_id}")
async def delete_source(project_id: str, source_id: str) -> dict:
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)
    src = next((s for s in project.sources if s.id == source_id), None)

    try:
        await svc.delete_source(project_id, source_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # 関連ファイルをディスクから削除（sources/{source_id}_*）
    sources_dir = ProjectService._project_dir(project) / "sources"
    _delete_related_files(sources_dir, source_id)
    if src and src.file_path:
        _safe_unlink(Path(src.file_path))

    return {"status": "ok"}


# ─── ファイル読み込み・画像解析 ─────────────────────────────


@router.post("/sources/{source_id}/read-file", response_model=Source)
async def read_source_file(
    project_id: str, source_id: str, body: dict
) -> Source:
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)

    file_path = body.get("file_path", "")
    if not file_path:
        raise HTTPException(status_code=422, detail="file_path が必要です")

    try:
        text = await _file_service.read_file_as_text(file_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"??????????????????? {e}")

    suffix = Path(file_path).suffix.lower()
    file_type = "pdf" if suffix == ".pdf" else (suffix.lstrip(".") or "text")

    return await svc.update_source(
        project_id, source_id, SourceUpdate(full_text=text, file_path=file_path, file_type=file_type)
    )


# ─── 要約生成 ────────────────────────────────────────────────


@router.post("/sources/{source_id}/summarize", response_model=Source)
async def summarize_source(project_id: str, source_id: str) -> Source:
    """LLMを使用してソース全文から要約を生成する（必要なら長い要約も生成）。"""
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)
    src = _get_source_or_404(project, source_id)
    if not src.full_text:
        raise HTTPException(status_code=400, detail="全文が登録されていません")

    try:
        update = await _build_summary_update(src, clear_extended_when_short=False)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"要約生成失敗: {e}")

    return await svc.update_source(project_id, source_id, update)


@router.post("/sources/{source_id}/analyze-image", response_model=Source)
async def analyze_source_image(
    project_id: str, source_id: str, body: dict
) -> Source:
    svc = get_service()
    file_path = body.get("file_path", "")
    if not file_path:
        raise HTTPException(status_code=422, detail="file_path が必要です")

    try:
        text = await _llm_service.analyze_image_with_vision(file_path, get_settings_service().get())
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"画像解析失敗: {e}")

    return await svc.update_source(
        project_id, source_id, SourceUpdate(full_text=text)
    )


# ─── ブラウザ用ファイルアップロード（pywebview なし対応）──────


@router.post("/sources/{source_id}/read-file-upload", response_model=Source)
async def read_source_file_upload(
    project_id: str, source_id: str, file: UploadFile
) -> Source:
    """ブラウザからアップロードされたファイルをディスクに保存し、テキスト抽出する。
    PDFの場合はサムネイルと等倍画像も生成する。"""
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)

    filename = Path(file.filename or "file").name
    suffix = Path(filename).suffix.lower()
    content = await file.read()

    # v3: ファイルを sources/{source_id}_{filename} に永続保存
    project_dir = ProjectService._project_dir(project)
    sources_dir = project_dir / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)
    # 既存の関連ファイルを削除（拡張子変更時の残骸対策）
    _delete_related_files(sources_dir, source_id)
    saved_path = sources_dir / f"{source_id}_{filename}"
    saved_path.write_bytes(content)

    # ファイル形式を判定
    if suffix == ".pdf":
        file_type = "pdf"
    elif suffix in _IMAGE_SUFFIXES:
        file_type = "image"
    else:
        file_type = suffix.lstrip(".") or "text"

    # PDFの場合: サムネイルと等倍画像をディスクに保存
    if file_type == "pdf":
        import fitz  # PyMuPDF

        # v3: page/ と thumbnails/ は metadata/sources/{id}/ 配下
        src_meta_dir = ProjectService._source_metadata_dir(project, source_id)
        page_dir = src_meta_dir / "page"
        thumb_dir = src_meta_dir / "thumbnails"
        # 既存のページ画像・サムネイルを削除（差し替え時の残骸対策）
        _safe_rmtree(page_dir)
        _safe_rmtree(thumb_dir)
        page_dir.mkdir(parents=True, exist_ok=True)
        thumb_dir.mkdir(parents=True, exist_ok=True)
        raw_dpi = get_settings_service().get().pdf_page_dpi

        def _generate_pdf_images(path_str: str, thumb_dir_str: str, page_dir_str: str, dpi: int) -> None:
            doc = fitz.open(path_str)
            for page_num in range(len(doc)):
                page = doc.load_page(page_num)
                # サムネイル (72dpi)
                pix = page.get_pixmap(dpi=72)
                pix.save(str(Path(thumb_dir_str) / f"page_{page_num}.jpg"))
                # 等倍画像（設定DPI）
                pix_raw = page.get_pixmap(dpi=dpi)
                pix_raw.save(str(Path(page_dir_str) / f"page_raw_{page_num}.jpg"))
            doc.close()

        try:
            await asyncio.to_thread(
                _generate_pdf_images,
                str(saved_path),
                str(thumb_dir),
                str(page_dir),
                raw_dpi,
            )
        except Exception:
            pass  # PDFページ画像の保存に失敗しても続行（テキスト抽出を優先）

    # テキスト抽出
    try:
        text = await _file_service.read_file_as_text(str(saved_path))
    except Exception:
        text = ""

    return await svc.update_source(
        project_id, source_id,
        SourceUpdate(full_text=text, file_path=str(saved_path), file_type=file_type)
    )


@router.post("/sources/{source_id}/analyze-image-upload", response_model=Source)
async def analyze_source_image_upload(
    project_id: str, source_id: str, file: UploadFile
) -> Source:
    """ブラウザからアップロードされた画像/PDFをVision APIで解析する。"""
    svc = get_service()
    suffix = Path(file.filename or "image").suffix
    content = await file.read()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        text = await _llm_service.analyze_image_with_vision(tmp_path, get_settings_service().get())
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"画像解析失敗: {e}")
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    return await svc.update_source(
        project_id, source_id, SourceUpdate(full_text=text)
    )


# ─── 保存済みPDFページ一覧・解析 ──────────────────────────────


@router.get("/sources/{source_id}/pdf-page-list")
async def get_pdf_page_list(project_id: str, source_id: str) -> dict:
    """ディスクに保存済みのPDFサムネイル一覧を返す。"""
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)
    src = _get_source_or_404(project, source_id)
    if src.file_type != "pdf":
        raise HTTPException(status_code=400, detail="PDFソースではありません")

    # v3: metadata/sources/{id}/ 配下を参照
    src_meta_dir = ProjectService._source_metadata_dir(project, source_id)
    thumb_dir = src_meta_dir / "thumbnails"
    page_dir = src_meta_dir / "page"

    pages = []
    page_num = 0
    while True:
        thumb_path = thumb_dir / f"page_{page_num}.jpg"
        if not thumb_path.exists():
            break
        raw_path = page_dir / f"page_raw_{page_num}.jpg"
        pages.append({
            "page": page_num,
            "label": f"p.{page_num + 1}",
            "thumbnail_path": str(thumb_path),
            "raw_path": str(raw_path) if raw_path.exists() else None,
        })
        page_num += 1

    return {"total": len(pages), "pages": pages}


@router.post("/sources/{source_id}/analyze-saved-pdf-pages", response_model=Source)
async def analyze_saved_pdf_pages(
    project_id: str, source_id: str, body: dict
) -> Source:
    """保存済みPDF等倍画像をVision APIで解析し、markdown形式でfull_textに追記する。"""
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)
    src = _get_source_or_404(project, source_id)

    page_indices: list[int] = body.get("pages", [])
    if not page_indices:
        raise HTTPException(status_code=422, detail="ページ番号が必要です")

    # v3: metadata/sources/{id}/page/
    page_dir = ProjectService._source_metadata_dir(project, source_id) / "page"

    analyses = []
    for page_num in page_indices:
        raw_path = page_dir / f"page_raw_{page_num}.jpg"
        if not raw_path.exists():
            analyses.append(f"--- {page_num + 1}ページ目 ---\n[ファイルが見つかりません]")
            continue
        try:
            img_bytes = raw_path.read_bytes()
            text = await _llm_service.analyze_image_bytes_with_vision(
                img_bytes,
                "image/jpeg",
                get_settings_service().get(),
                f"このページ（{page_num + 1}ページ目）の内容をmarkdown記法を使って詳しく説明してください。"
                "テキスト、図表、数式などを含む場合はできる限りmarkdown構文で表現してください。",
            )
            analyses.append(f"--- {page_num + 1}ページ目 ---\n{text}")
        except Exception as e:
            analyses.append(f"--- {page_num + 1}ページ目 ---\n[解析失敗: {e}]")

    existing = src.full_text or ""
    separator = "\n\n" if existing else ""
    new_text = existing + separator + "\n\n".join(analyses)

    return await svc.update_source(
        project_id, source_id, SourceUpdate(full_text=new_text)
    )


# ─── 保存済みPDF単一ページ・ストリーミング解析 ────────────────


@router.post("/sources/{source_id}/analyze-saved-pdf-page-stream")
async def analyze_saved_pdf_page_stream(
    project_id: str, source_id: str, body: dict
) -> StreamingResponse:
    """保存済みPDF単一ページをVision APIでストリーミング解析する。"""
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)
    _get_source_or_404(project, source_id)

    page_num: int = body.get("page", 0)
    # v3: metadata/sources/{id}/page/
    page_dir = ProjectService._source_metadata_dir(project, source_id) / "page"
    raw_path = page_dir / f"page_raw_{page_num}.jpg"
    if not raw_path.exists():
        raise HTTPException(status_code=404, detail="ページ画像が見つかりません")

    img_bytes = raw_path.read_bytes()
    prompt_text = (
        f"このページ（{page_num + 1}ページ目）の内容をmarkdown記法を使って詳しく説明してください。"
        "テキスト、図表、数式などを含む場合はできる限りmarkdown構文で表現してください。"
    )

    async def event_stream():
        try:
            async for chunk in _llm_service.analyze_image_bytes_with_vision_stream(
                img_bytes, "image/jpeg", get_settings_service().get(), prompt_text
            ):
                yield f"data: {json.dumps({'text': chunk})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ─── 保存済みPDF全ページ一括ストリーミング解析 ────────────────


@router.post("/sources/{source_id}/analyze-all-pages-stream")
async def analyze_all_pages_stream(
    project_id: str, source_id: str, body: dict
) -> StreamingResponse:
    """保存済みPDFの全ページをVision APIで順次ストリーミング解析する。

    SSEイベント形式:
      data: {"event": "page_start", "page": 0, "total": 5}
      data: {"event": "chunk",      "page": 0, "text": "..."}
      data: {"event": "page_done",  "page": 0}
      data: {"event": "error",      "page": 0, "message": "..."}
      data: [DONE]
    """
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)
    _get_source_or_404(project, source_id)

    max_chars_raw = body.get("max_chars_per_page")
    max_chars: int | None = None
    if max_chars_raw is not None:
        try:
            parsed = int(max_chars_raw)
            max_chars = parsed if parsed > 0 else None
        except (TypeError, ValueError):
            max_chars = None
    # v3: metadata/sources/{id}/page/
    page_dir = ProjectService._source_metadata_dir(project, source_id) / "page"

    # 全 page_raw_{n}.jpg を昇順で収集
    page_paths: list[tuple[int, Path]] = []
    pg = 0
    while True:
        raw_path = page_dir / f"page_raw_{pg}.jpg"
        if not raw_path.exists():
            break
        page_paths.append((pg, raw_path))
        pg += 1


    if not page_paths:
        raise HTTPException(
            status_code=404,
            detail="ページ画像が見つかりません。先に「ファイル読み込み」でPDFを読み込んでください。",
        )

    total = len(page_paths)
    settings = get_settings_service().get()

    async def event_stream():
        for page_num, raw_path in page_paths:
            yield (
                f"data: {json.dumps({'event': 'page_start', 'page': page_num, 'total': total}, ensure_ascii=False)}\n\n"
            )
            try:
                img_bytes = raw_path.read_bytes()
                prompt_text = (
                    f"このページ（{page_num + 1}ページ目）の内容をmarkdown記法を使って詳しく説明してください。"
                    "テキスト、図表、数式などを含む場合はできる限りmarkdown構文で表現してください。"
                )

                produced = 0
                async for chunk in _llm_service.analyze_image_bytes_with_vision_stream(
                    img_bytes, "image/jpeg", settings, prompt_text
                ):
                    if max_chars is not None:
                        remaining = max_chars - produced
                        if remaining <= 0:
                            break
                        chunk = chunk[:remaining]
                    if not chunk:
                        continue
                    produced += len(chunk)
                    yield (
                        f"data: {json.dumps({'event': 'chunk', 'page': page_num, 'text': chunk}, ensure_ascii=False)}\n\n"
                    )
                yield (
                    f"data: {json.dumps({'event': 'page_done', 'page': page_num}, ensure_ascii=False)}\n\n"
                )
            except Exception as e:
                yield (
                    f"data: {json.dumps({'event': 'error', 'page': page_num, 'message': str(e)}, ensure_ascii=False)}\n\n"
                )
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/sources/{source_id}/extract-bibliography", response_model=Source)
async def extract_bibliography(project_id: str, source_id: str) -> Source:
    """LLMを使用してソース全文から文献情報を抽出する"""
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)

    src_map = {s.id: s for s in project.sources}
    src = src_map.get(source_id)
    if not src:
        raise HTTPException(status_code=404, detail="ソースが見つかりません")

    if not src.full_text:
        raise HTTPException(status_code=400, detail="全文が登録されていません")

    try:
        bibliography = await _llm_service.extract_bibliography(
            src.full_text,
            src.bibliography.type,
            get_settings_service().get(),
        )
        return await svc.update_source(
            project_id, source_id, SourceUpdate(bibliography=bibliography)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"文献情報抽出失敗: {e}")


# ─── CSV エクスポート・インポート ─────────────────────────────

_SOURCE_CSV_FIELDS = [
    "id", "name", "bib_type", "title", "author", "journal",
    "volume", "issue", "pages", "year", "publisher",
    "publication_place", "editor", "url", "site_name",
    "accessed_date", "created_date", "include_in_references",
]


@router.post("/sources/reorder")
async def reorder_sources(project_id: str, body: SourcesReorder) -> dict:
    svc = get_service()
    try:
        await svc.reorder_sources(project_id, body.ordered_ids)
        return {"status": "ok"}
    except KeyError:
        _not_found(project_id)


@router.get("/sources/export")
async def export_sources_csv(project_id: str) -> StreamingResponse:
    svc = get_service()
    project = await _get_project_or_404(svc, project_id)

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=_SOURCE_CSV_FIELDS)
    writer.writeheader()
    for src in project.sources:
        b = src.bibliography
        writer.writerow({
            "id": src.id,
            "name": src.name,
            "bib_type": b.type,
            "title": b.title,
            "author": b.author,
            "journal": b.journal or "",
            "volume": b.volume or "",
            "issue": b.issue or "",
            "pages": b.pages or "",
            "year": b.year or "",
            "publisher": b.publisher or "",
            "publication_place": b.publication_place or "",
            "editor": b.editor or "",
            "url": b.url or "",
            "site_name": b.site_name or "",
            "accessed_date": b.accessed_date or "",
            "created_date": b.created_date or "",
            "include_in_references": b.include_in_references,
        })

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=sources.csv"},
    )


async def _import_sources_from_text(svc, project_id: str, text: str) -> int:
    """CSV テキストからソースをインポートし、追加件数を返す。"""
    reader = csv.DictReader(io.StringIO(text))
    imported = 0
    for row in reader:
        bib = Bibliography(
            type=row.get("bib_type", "paper"),
            title=row.get("title", ""),
            author=row.get("author", ""),
            journal=row.get("journal") or None,
            volume=row.get("volume") or None,
            issue=row.get("issue") or None,
            pages=row.get("pages") or None,
            year=row.get("year") or None,
            publisher=row.get("publisher") or None,
            publication_place=row.get("publication_place") or None,
            editor=row.get("editor") or None,
            url=row.get("url") or None,
            site_name=row.get("site_name") or None,
            accessed_date=row.get("accessed_date") or None,
            created_date=row.get("created_date") or None,
            include_in_references=str(row.get("include_in_references", "False")).lower() == "true",
        )
        src = await svc.add_source(project_id)
        await svc.update_source(
            project_id,
            src.id,
            SourceUpdate(name=row.get("name", src.name), bibliography=bib),
        )
        imported += 1
    return imported


@router.post("/sources/import-native")
async def import_sources_csv_native(project_id: str, body: dict) -> dict:
    """pywebview 用: ファイルパスを受け取って CSV インポート。"""
    file_path = body.get("path", "")
    if not file_path:
        raise HTTPException(status_code=400, detail="path is required")
    try:
        text = Path(file_path).read_text(encoding="utf-8-sig")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    svc = get_service()
    await _get_project_or_404(svc, project_id)

    return {"imported": await _import_sources_from_text(svc, project_id, text)}


@router.post("/sources/import")
async def import_sources_csv(project_id: str, file: UploadFile) -> dict:
    svc = get_service()
    await _get_project_or_404(svc, project_id)

    text = (await file.read()).decode("utf-8-sig")
    return {"imported": await _import_sources_from_text(svc, project_id, text)}
