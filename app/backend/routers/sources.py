"""ソース CRUD・ファイル読み込み・CSV インポート/エクスポート API"""
from __future__ import annotations

import asyncio
import base64
import csv
import io
import json
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.backend.models import Bibliography, Source, SourceUpdate
from app.backend.routers.projects import get_service
from app.backend.services.file_service import FileService
from app.backend.services.llm_service import LLMService
from app.backend.services.vector_store_service import VectorStoreService

router = APIRouter(prefix="/api/projects/{project_id}", tags=["sources"])
_vs_service = VectorStoreService()
_llm_service = LLMService()
_file_service = FileService()


def _not_found(project_id: str):
    raise HTTPException(status_code=404, detail=f"プロジェクトが見つかりません: {project_id}")


# ─── ソース CRUD ──────────────────────────────────────────────


@router.get("/sources", response_model=list[Source])
async def list_sources(project_id: str) -> list[Source]:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
        return project.sources
    except KeyError:
        _not_found(project_id)


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
    try:
        project = await svc.get_project(project_id)
        await svc.delete_source(project_id, source_id)
        # VectorStore と連動削除
        await _vs_service.remove_source(project, source_id)
        return {"status": "ok"}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ─── ファイル読み込み・画像解析 ─────────────────────────────


@router.post("/sources/{source_id}/read-file", response_model=Source)
async def read_source_file(
    project_id: str, source_id: str, body: dict
) -> Source:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    file_path = body.get("file_path", "")
    if not file_path:
        raise HTTPException(status_code=422, detail="file_path が必要です")

    try:
        text = await _file_service.read_file_as_text(file_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ファイル読み込み失敗: {e}")

    return await svc.update_source(
        project_id, source_id, SourceUpdate(full_text=text, file_path=file_path)
    )


@router.post("/sources/{source_id}/analyze-image", response_model=Source)
async def analyze_source_image(
    project_id: str, source_id: str, body: dict
) -> Source:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    file_path = body.get("file_path", "")
    if not file_path:
        raise HTTPException(status_code=422, detail="file_path が必要です")

    try:
        text = await _llm_service.analyze_image(file_path, project.settings)
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
    """ブラウザからアップロードされたファイルを読み込んでソースの全文に設定する。"""
    svc = get_service()
    try:
        await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    suffix = Path(file.filename or "file").suffix
    content = await file.read()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        text = await _file_service.read_file_as_text(tmp_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ファイル読み込み失敗: {e}")
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    return await svc.update_source(
        project_id, source_id,
        SourceUpdate(full_text=text, file_path=file.filename or "")
    )


@router.post("/sources/{source_id}/analyze-image-upload", response_model=Source)
async def analyze_source_image_upload(
    project_id: str, source_id: str, file: UploadFile
) -> Source:
    """ブラウザからアップロードされた画像/PDFをVision APIで解析する。"""
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    suffix = Path(file.filename or "image").suffix
    content = await file.read()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        text = await _llm_service.analyze_image(tmp_path, project.settings)
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


# ─── PDFページ選択・解析 ───────────────────────────────────


@router.post("/sources/{source_id}/pdf-thumbnails")
async def get_pdf_thumbnails(
    project_id: str, source_id: str, file: UploadFile
) -> dict:
    """PDFの各ページをサムネイル画像として返す（base64 JPEG）。"""
    import fitz  # PyMuPDF

    content = await file.read()
    try:
        doc = await asyncio.to_thread(fitz.open, stream=content, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PDF解析失敗: {e}")

    def _render_thumbnails(doc):
        thumbs = []
        for page_num in range(len(doc)):
            page = doc.load_page(page_num)
            pix = page.get_pixmap(dpi=72)
            img_bytes = pix.tobytes("jpeg")
            b64 = base64.b64encode(img_bytes).decode()
            thumbs.append({
                "page": page_num,
                "label": f"p.{page_num + 1}",
                "data": f"data:image/jpeg;base64,{b64}",
            })
        doc.close()
        return thumbs

    thumbnails = await asyncio.to_thread(_render_thumbnails, doc)
    return {"total": len(thumbnails), "thumbnails": thumbnails}


@router.post("/sources/{source_id}/analyze-pdf-pages", response_model=Source)
async def analyze_pdf_pages(
    project_id: str,
    source_id: str,
    file: UploadFile,
    pages: str = Form(...),
) -> Source:
    """PDFの選択ページをVision APIで解析してfull_textに追記する。"""
    import fitz  # PyMuPDF

    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    page_indices = []
    for p in pages.split(","):
        p = p.strip()
        if p.isdigit():
            page_indices.append(int(p))
    if not page_indices:
        raise HTTPException(status_code=422, detail="ページ番号が必要です")

    content = await file.read()

    def _render_pages(content_bytes, indices):
        doc = fitz.open(stream=content_bytes, filetype="pdf")
        results = []
        for page_num in indices:
            if page_num >= len(doc):
                continue
            page = doc.load_page(page_num)
            pix = page.get_pixmap(dpi=150)
            results.append((page_num, pix.tobytes("png")))
        doc.close()
        return results

    try:
        rendered = await asyncio.to_thread(_render_pages, content, page_indices)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"PDFレンダリング失敗: {e}")

    analyses = []
    for page_num, img_bytes in rendered:
        try:
            text = await _file_service.analyze_image_bytes_with_vision(
                img_bytes,
                "image/png",
                project.settings,
                f"このPDFの{page_num + 1}ページ目の内容を詳しく説明してください。",
            )
            analyses.append(f"--- {page_num + 1}ページ目 ---\n{text}")
        except Exception as e:
            analyses.append(f"--- {page_num + 1}ページ目 ---\n[解析失敗: {e}]")

    src = next((s for s in project.sources if s.id == source_id), None)
    existing = src.full_text if src else ""
    separator = "\n\n" if existing else ""
    new_text = existing + separator + "\n\n".join(analyses)

    return await svc.update_source(
        project_id, source_id, SourceUpdate(full_text=new_text)
    )


# ─── 要約生成・インデックス化 ───────────────────────────────


@router.post("/sources/{source_id}/summarize", response_model=Source)
async def summarize_source(project_id: str, source_id: str) -> Source:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    src_map = {s.id: s for s in project.sources}
    src = src_map.get(source_id)
    if not src:
        raise HTTPException(status_code=404, detail="ソースが見つかりません")

    if not src.full_text:
        raise HTTPException(status_code=400, detail="全文が登録されていません")

    try:
        summary = await _llm_service.generate_summary(src.full_text, project.settings)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"要約生成失敗: {e}")

    updated = await svc.update_source(
        project_id, source_id, SourceUpdate(summary=summary)
    )
    # VectorStore にインデックス登録
    await _vs_service.upsert_source(project, source_id, summary)
    return updated


# ─── CSV エクスポート・インポート ─────────────────────────────

_SOURCE_CSV_FIELDS = [
    "id", "name", "bib_type", "title", "author", "journal",
    "volume", "issue", "pages", "year", "publisher",
    "publication_place", "editor", "url", "site_name",
    "accessed_date", "include_in_references",
]


@router.get("/sources/export")
async def export_sources_csv(project_id: str) -> StreamingResponse:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

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
            "include_in_references": b.include_in_references,
        })

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=sources.csv"},
    )


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
    try:
        await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

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
            include_in_references=str(row.get("include_in_references", "False")).lower() == "true",
        )
        src = await svc.add_source(project_id)
        await svc.update_source(
            project_id,
            src.id,
            SourceUpdate(name=row.get("name", src.name), bibliography=bib),
        )
        imported += 1

    return {"imported": imported}


@router.post("/sources/import")
async def import_sources_csv(project_id: str, file: UploadFile) -> dict:
    svc = get_service()
    try:
        await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    content = await file.read()
    text = content.decode("utf-8-sig")
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
            include_in_references=str(row.get("include_in_references", "False")).lower() == "true",
        )
        src = await svc.add_source(project_id)
        await svc.update_source(
            project_id,
            src.id,
            SourceUpdate(name=row.get("name", src.name), bibliography=bib),
        )
        imported += 1

    return {"imported": imported}
