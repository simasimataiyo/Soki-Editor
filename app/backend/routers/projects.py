"""プロジェクト管理・ダイアログ API ルーター"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from app.backend.models import (
    DataDirUpdate,
    Project,
    ProjectCreate,
    ProjectMeta,
)
from app.backend.services.project_service import ProjectService

router = APIRouter(prefix="/api", tags=["projects"])
_svc: ProjectService | None = None


def get_service() -> ProjectService:
    global _svc
    if _svc is None:
        _svc = ProjectService()
    return _svc


def set_service(svc: ProjectService) -> None:
    global _svc
    _svc = svc


# ─── プロジェクト ────────────────────────────────────────────


@router.post("/projects", response_model=Project)
async def create_project(body: ProjectCreate) -> Project:
    svc = get_service()
    from pathlib import Path

    data_dir = body.data_dir
    if data_dir is None:
        p = Path(body.json_file_path)
        project_id_placeholder = p.stem
        data_dir = str(p.parent / project_id_placeholder / "data")

    project = await svc.create_project(body.name, body.json_file_path, data_dir)
    # data_dir をプロジェクト ID ベースに修正（作成後に ID が確定）
    if body.data_dir is None:
        from pathlib import Path as _Path

        actual_data_dir = str(
            _Path(body.json_file_path).parent / project.id / "data"
        )
        await svc.update_data_dir(project.id, actual_data_dir)
        project = await svc.get_project(project.id)

    # デフォルトルールカテゴリを追加
    for cat_name in ["表現方法", "心構え", "その他"]:
        await svc.add_rule_category(project.id, cat_name)

    await svc.flush(project.id)
    project = await svc.get_project(project.id)
    return project


@router.post("/projects/open-upload", response_model=Project)
async def open_project_upload(file: UploadFile) -> Project:
    """ブラウザからアップロードされたプロジェクトJSONファイルを開く。"""
    from pathlib import Path

    content = await file.read()
    save_dir = Path.home() / "soki-projects"
    save_dir.mkdir(parents=True, exist_ok=True)
    filename = file.filename or "project.json"
    save_path = save_dir / filename
    save_path.write_bytes(content)

    svc = get_service()
    try:
        return await svc.open_project(str(save_path))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/projects/suggest-path")
async def suggest_project_path(name: str = "project") -> dict:
    """新規プロジェクトのデフォルト保存パスを提案する。"""
    from pathlib import Path

    safe_name = "".join(c for c in name if c.isalnum() or c in " _-").strip() or "project"
    path = Path.home() / "soki-projects" / f"{safe_name}.json"
    return {"path": str(path)}


@router.post("/projects/open", response_model=Project)
async def open_project(body: dict) -> Project:
    json_file_path = body.get("json_file_path")
    if not json_file_path:
        raise HTTPException(status_code=422, detail="json_file_path が必要です")
    svc = get_service()
    try:
        return await svc.open_project(json_file_path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/projects/recent", response_model=list[ProjectMeta])
async def list_recent_projects() -> list[ProjectMeta]:
    svc = get_service()
    return await svc.list_recent_projects()


@router.get("/projects/{project_id}", response_model=Project)
async def get_project(project_id: str) -> Project:
    svc = get_service()
    try:
        return await svc.get_project(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")


@router.put("/projects/{project_id}/save")
async def save_project(project_id: str) -> dict:
    svc = get_service()
    try:
        await svc.flush(project_id)
        return {"status": "ok"}
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")


@router.put("/projects/{project_id}/references-section")
async def update_references_section(project_id: str, body: dict) -> dict:
    svc = get_service()
    try:
        enabled = bool(body.get("enabled", False))
        await svc.update_references_section_enabled(project_id, enabled)
        await svc.flush(project_id)
        return {"enabled": enabled}
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")


@router.get("/projects/{project_id}/content")
async def get_project_content(project_id: str) -> dict:
    """プロジェクトの本文コンテンツ（マーカー付きMarkdown）を返す。"""
    svc = get_service()
    try:
        content = await svc.get_content(project_id)
        return {"content": content}
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")


@router.put("/projects/{project_id}/content")
async def update_project_content(project_id: str, body: dict) -> dict:
    """プロジェクトの本文コンテンツを全体更新する。"""
    svc = get_service()
    try:
        content = body.get("content", "")
        await svc.update_content(project_id, content)
        return {"status": "ok"}
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")


@router.patch("/projects/{project_id}/content/sections/{section_id}")
async def patch_section_in_content(
    project_id: str, section_id: str, body: dict
) -> dict:
    """project.content の特定セクションの本文テキストを更新し、更新後の全コンテンツを返す。

    LLMツール（update_section, update_multiple_sections）からの呼び出し向け。
    """
    svc = get_service()
    try:
        new_body = body.get("content", "")
        updated_content = await svc.update_section_in_body(project_id, section_id, new_body)
        return {"content": updated_content}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.put("/projects/{project_id}/name")
async def update_project_name(project_id: str, body: dict) -> dict:
    svc = get_service()
    new_name = body.get("name", "").strip()
    if not new_name:
        raise HTTPException(status_code=422, detail="name が必要です")
    try:
        await svc.update_name(project_id, new_name)
        return {"status": "ok", "name": new_name}
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")


@router.put("/projects/{project_id}/data-dir")
async def update_data_dir(project_id: str, body: DataDirUpdate) -> dict:
    svc = get_service()
    try:
        await svc.update_data_dir(project_id, body.new_data_dir)
        return {"status": "ok", "data_dir": body.new_data_dir}
    except KeyError:
        raise HTTPException(status_code=404, detail="プロジェクトが見つかりません")


# ─── ダイアログ API ─────────────────────────────────────────


@router.post("/dialog/open-file")
def dialog_open_file(body: dict = {}) -> dict:
    from app.backend.services.file_service import FileService

    svc = FileService()
    file_types = body.get("file_types")
    path = svc.open_file_dialog(file_types)
    return {"path": path}


@router.post("/dialog/save-file")
def dialog_save_file(body: dict = {}) -> dict:
    from app.backend.services.file_service import FileService

    svc = FileService()
    path = svc.save_file_dialog(body.get("default_filename", ""))
    return {"path": path}


@router.post("/dialog/write-file")
def dialog_write_file(body: dict) -> dict:
    """指定パスにコンテンツを書き込む。"""
    import pathlib

    path = body.get("path", "")
    content = body.get("content", "")
    if not path:
        return {"ok": False, "error": "path is required"}
    try:
        pathlib.Path(path).write_text(content, encoding="utf-8-sig")
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/dialog/open-directory")
def dialog_open_directory() -> dict:
    from app.backend.services.file_service import FileService

    svc = FileService()
    path = svc.open_directory_dialog()
    return {"path": path}


# ─── ファイルシステムブラウザ API（ブラウザモード用）──────────


@router.get("/filesystem/browse")
def browse_filesystem(dir: str = "") -> dict:
    """ディレクトリ内容を返す（ブラウザモードのファイル選択用）。"""
    from pathlib import Path

    if not dir:
        base = Path.home()
    else:
        base = Path(dir)

    if not base.exists() or not base.is_dir():
        parent = base.parent
        if parent.exists():
            base = parent
        else:
            base = Path.home()

    dirs = []
    files = []
    try:
        for item in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if item.name.startswith("."):
                continue
            if item.is_dir():
                dirs.append({"name": item.name, "path": str(item)})
            elif item.suffix.lower() == ".json":
                files.append({"name": item.name, "path": str(item)})
    except PermissionError:
        pass

    return {
        "current": str(base),
        "parent": str(base.parent) if base.parent != base else None,
        "dirs": dirs,
        "files": files,
    }
