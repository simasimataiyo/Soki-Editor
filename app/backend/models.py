"""Pydantic ドメインモデルと API DTO の定義"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ─── ドメインモデル ─────────────────────────────────────────────


class LLMSettings(BaseModel):
    api_key: str = ""
    endpoint_url: Optional[str] = None
    model: str = "gpt-4o"


class Bibliography(BaseModel):
    type: Literal["paper", "book", "book_chapter", "web"] = "paper"
    include_in_references: bool = False
    title: str = ""
    author: str = ""
    journal: Optional[str] = None
    volume: Optional[str] = None
    issue: Optional[str] = None
    pages: Optional[str] = None
    year: Optional[str] = None
    publisher: Optional[str] = None
    publication_place: Optional[str] = None
    editor: Optional[str] = None
    url: Optional[str] = None
    site_name: Optional[str] = None
    accessed_date: Optional[str] = None
    other: Optional[str] = None


class Source(BaseModel):
    id: str  # "ref-{uuid8}"
    name: str = "新しいソース"
    file_path: Optional[str] = None
    full_text: str = ""
    summary: str = ""
    bibliography: Bibliography = Field(default_factory=Bibliography)


class Material(BaseModel):
    id: str  # "fig-{uuid8}"
    name: str = "新しいマテリアル"
    type: Literal["figure", "table"] = "figure"
    caption: str = ""
    file_path: Optional[str] = None
    thumbnail_path: Optional[str] = None


class Rule(BaseModel):
    id: str
    category_id: str
    content: str
    enabled: bool = True
    order: int = 0


class RuleCategory(BaseModel):
    id: str
    name: str
    order: int = 0


class Section(BaseModel):
    id: str
    title: str = "新しいセクション"
    summary: str = ""
    content: str = ""
    parent_id: Optional[str] = None
    order: int = 0


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    timestamp: datetime


class ReviewComment(BaseModel):
    id: str
    section_id: str
    content: str
    created_at: datetime


class Project(BaseModel):
    id: str
    name: str
    created_at: datetime
    updated_at: datetime
    json_file_path: str  # プロジェクト JSON の保存先絶対パス
    data_dir: str  # データディレクトリの絶対パス
    settings: LLMSettings = Field(default_factory=LLMSettings)
    rule_categories: list[RuleCategory] = []
    rules: list[Rule] = []
    sources: list[Source] = []
    materials: list[Material] = []
    sections: list[Section] = []
    chat_history: dict[str, list[ChatMessage]] = {}
    review_system_prompt: str = ""
    review_comments: list[ReviewComment] = []
    references_section_enabled: bool = False


# ─── API DTOs ──────────────────────────────────────────────────


class ProjectCreate(BaseModel):
    name: str
    json_file_path: str
    data_dir: Optional[str] = None


class ProjectMeta(BaseModel):
    id: str
    name: str
    file_path: str
    updated_at: datetime


class ChatRequest(BaseModel):
    user_message: str
    context_scope: str = "all"
    use_full_sources: bool = False


class ReviewRequest(BaseModel):
    system_prompt: str
    context_scope: str = "all"
    use_full_sources: bool = False


class SectionCreate(BaseModel):
    title: str
    summary: str = ""
    content: str = ""
    parent_id: Optional[str] = None
    order: Optional[int] = None


class SectionUpdate(BaseModel):
    title: Optional[str] = None
    summary: Optional[str] = None
    content: Optional[str] = None
    parent_id: Optional[str] = None
    order: Optional[int] = None


class SectionOrder(BaseModel):
    section_id: str
    parent_id: Optional[str]
    order: int


class SectionPreview(BaseModel):
    section_id: str
    rendered_content: str


class DataDirUpdate(BaseModel):
    new_data_dir: str


class RuleCreate(BaseModel):
    category_id: str
    content: str
    enabled: bool = True


class RuleUpdate(BaseModel):
    content: Optional[str] = None
    enabled: Optional[bool] = None
    order: Optional[int] = None
    category_id: Optional[str] = None


class RuleCategoryCreate(BaseModel):
    name: str


class SourceUpdate(BaseModel):
    name: Optional[str] = None
    file_path: Optional[str] = None
    full_text: Optional[str] = None
    summary: Optional[str] = None
    bibliography: Optional[Bibliography] = None


class MaterialUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[Literal["figure", "table"]] = None
    caption: Optional[str] = None
    file_path: Optional[str] = None
    thumbnail_path: Optional[str] = None


class ErrorResponse(BaseModel):
    detail: str
