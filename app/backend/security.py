"""アプリケーションセキュリティ設定（起動時に一度だけ初期化）"""
from __future__ import annotations

import secrets
import sys

# 起動ごとにランダム生成されるトークン（WebView → FastAPI の認証用）
APP_TOKEN: str = secrets.token_hex(32)

# 開発モードフラグ（main.py から起動前にセットする）
# True の場合、トークン認証ミドルウェアをスキップする
DEV_MODE: bool = False
