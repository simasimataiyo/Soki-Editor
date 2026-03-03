"""Pydantic ドメインモデルと API DTO の定義"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ─── ドメインモデル ─────────────────────────────────────────────


class WindowState(BaseModel):
    width: int = 1400
    height: int = 900
    x: Optional[int] = None
    y: Optional[int] = None


class LLMSettings(BaseModel):
    api_key: str = ""
    endpoint_url: Optional[str] = None
    model: str = "gpt-4o"
    pdf_page_dpi: int = 96  # PDF等倍画像のDPI（設定画面から変更可能）
    left_panel_width: int = 280  # 左パネル標準幅（px）
    history_panel_width: int = 280  # チャット履歴右パネル標準幅（px）
    outline_panel_width: int = 280  # アウトライン左パネル幅（px）
    review_max_comments: int = 0    # レビューコメントの最大件数（0=無制限）
    window_state: WindowState = Field(default_factory=WindowState)


class Bibliography(BaseModel):
    type: Literal["paper", "book", "book_chapter", "web", "resource"] = "paper"
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
    created_date: Optional[str] = None  # YYYY-MM-DD format (for resource type)


class Source(BaseModel):
    id: str  # "ref-{uuid8}"
    name: str = "新しいソース"
    file_path: Optional[str] = None
    file_type: Optional[str] = None  # "pdf" | "image" | "text" | None
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
    table_content: Optional[str] = None


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
    content: Optional[str] = None  # 非推奨。新アーキテクチャでは project.content に統合
    parent_id: Optional[str] = None
    order: int = 0


class ReviewCommentItem(BaseModel):
    section: str = ""
    problem: str = ""
    suggestion: str = ""


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "command"]
    content: str
    timestamp: datetime
    command_name: Optional[str] = None      # コマンド名（role="command"の場合）
    command_args: list[str] = []            # コマンド引数
    explicit_refs: list[str] = []          # このメッセージで明示参照したソース/マテリアルID
    selected_section_id: Optional[str] = None   # 送信時に選択中だったセクションID
    selected_section_title: Optional[str] = None  # 送信時に選択中だったセクションタイトル
    ref_names: list[str] = []              # 明示参照したソース/マテリアルの表示名
    prompt_text: Optional[str] = None      # ユーザーが入力したプロンプトテキスト（コマンドの場合はフリーテキスト部分）
    review_comments: list[ReviewCommentItem] = []  # レビューコマンドの結果コメント一覧


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
    settings: Optional[LLMSettings] = None  # 後方互換のみ。グローバル設定に移行済み
    rule_categories: list[RuleCategory] = []
    rules: list[Rule] = []
    sources: list[Source] = []
    materials: list[Material] = []
    sections: list[Section] = []
    content: str = ""  # 全文Markdownテキスト（<!-- soki-section:uuid --> マーカー付き）
    chat_history: list[ChatMessage] = []
    review_system_prompt: str = ""
    review_comments: list[ReviewComment] = []
    references_section_enabled: bool = False
    saved_review_prompts: dict[str, str] = {}  # name → prompt text


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
    command: Optional[str] = None          # "structure", "draft", "rewrite", etc.
    command_args: list[str] = []           # ["replace"], ["500"], etc.
    explicit_refs: list[str] = []          # ["ref-abc123", "fig-def456"]
    selected_text: Optional[str] = None   # ユーザーが選択中のテキスト（文脈として使用）
    selected_section_id: Optional[str] = None    # 送信時に選択中だったセクションID
    selected_section_title: Optional[str] = None  # 送信時に選択中だったセクションタイトル
    ref_names: list[str] = []              # 明示参照のソース/マテリアル名


class ReviewRequest(BaseModel):
    system_prompt: str
    context_scope: str = "all"
    command: Optional[str] = None          # "structure", "rule", "source"
    command_args: list[str] = []
    explicit_refs: list[str] = []


class SectionCreate(BaseModel):
    id: Optional[str] = None  # 指定時はそのIDを使用（整合性修復時など）
    title: str
    summary: str = ""
    parent_id: Optional[str] = None
    order: Optional[int] = None


class SectionUpdate(BaseModel):
    title: Optional[str] = None
    summary: Optional[str] = None
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
    file_type: Optional[str] = None
    full_text: Optional[str] = None
    summary: Optional[str] = None
    bibliography: Optional[Bibliography] = None


class MaterialUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[Literal["figure", "table"]] = None
    caption: Optional[str] = None
    file_path: Optional[str] = None
    thumbnail_path: Optional[str] = None
    table_content: Optional[str] = None


class ErrorResponse(BaseModel):
    detail: str
