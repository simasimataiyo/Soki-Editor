"""ルール・カテゴリ CRUD・CSV インポート/エクスポート API"""
from __future__ import annotations

import csv
import io

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.backend.models import Rule, RuleCategory, RuleCreate, RuleCategoryCreate, RuleUpdate
from app.backend.routers.projects import get_service

router = APIRouter(prefix="/api/projects/{project_id}", tags=["rules"])


def _not_found(project_id: str):
    raise HTTPException(status_code=404, detail=f"プロジェクトが見つかりません: {project_id}")


# ─── ルール ──────────────────────────────────────────────────


@router.get("/rules", response_model=list[Rule])
async def list_rules(project_id: str) -> list[Rule]:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
        return project.rules
    except KeyError:
        _not_found(project_id)


@router.post("/rules", response_model=Rule)
async def create_rule(project_id: str, body: RuleCreate) -> Rule:
    svc = get_service()
    try:
        return await svc.add_rule(project_id, body)
    except KeyError:
        _not_found(project_id)


@router.put("/rules/{rule_id}", response_model=Rule)
async def update_rule(project_id: str, rule_id: str, body: RuleUpdate) -> Rule:
    svc = get_service()
    try:
        return await svc.update_rule(project_id, rule_id, body)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/rules/{rule_id}")
async def delete_rule(project_id: str, rule_id: str) -> dict:
    svc = get_service()
    try:
        await svc.delete_rule(project_id, rule_id)
        return {"status": "ok"}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ─── カテゴリ ─────────────────────────────────────────────────


@router.get("/rule-categories", response_model=list[RuleCategory])
async def list_categories(project_id: str) -> list[RuleCategory]:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
        return project.rule_categories
    except KeyError:
        _not_found(project_id)


@router.post("/rule-categories", response_model=RuleCategory)
async def create_category(project_id: str, body: RuleCategoryCreate) -> RuleCategory:
    svc = get_service()
    try:
        return await svc.add_rule_category(project_id, body.name)
    except KeyError:
        _not_found(project_id)


@router.put("/rule-categories/{cat_id}", response_model=RuleCategory)
async def update_category(project_id: str, cat_id: str, body: RuleCategoryCreate) -> RuleCategory:
    svc = get_service()
    try:
        return await svc.update_rule_category(project_id, cat_id, body.name)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/rule-categories/{cat_id}")
async def delete_category(project_id: str, cat_id: str) -> dict:
    svc = get_service()
    try:
        await svc.delete_rule_category(project_id, cat_id)
        return {"status": "ok"}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ─── CSV エクスポート・インポート ─────────────────────────────


@router.get("/rules/export")
async def export_rules_csv(project_id: str) -> StreamingResponse:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    cat_map = {c.id: c.name for c in project.rule_categories}

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["カテゴリ", "ルール内容"])
    for rule in project.rules:
        cat_name = cat_map.get(rule.category_id, "")
        writer.writerow([cat_name, rule.content])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=rules.csv"},
    )


@router.post("/rules/import")
async def import_rules_csv(project_id: str, file: UploadFile) -> dict:
    svc = get_service()
    try:
        project = await svc.get_project(project_id)
    except KeyError:
        _not_found(project_id)

    content = await file.read()
    text = content.decode("utf-8-sig")
    reader = csv.reader(io.StringIO(text))

    # 既存カテゴリ名 → ID マップ
    cat_name_to_id: dict[str, str] = {
        c.name: c.id for c in project.rule_categories
    }
    imported = 0
    for row in reader:
        if len(row) < 2 or row[0] == "カテゴリ":
            continue
        cat_name, content_text = row[0].strip(), row[1].strip()
        if not content_text:
            continue
        # カテゴリが存在しなければ作成
        if cat_name not in cat_name_to_id:
            cat = await svc.add_rule_category(project_id, cat_name)
            cat_name_to_id[cat_name] = cat.id
        await svc.add_rule(
            project_id,
            RuleCreate(category_id=cat_name_to_id[cat_name], content=content_text),
        )
        imported += 1

    return {"imported": imported}
