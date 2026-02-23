"""FileService ユニットテスト（TDD: テストを先に記述）"""
import os
import tempfile
from pathlib import Path

import pytest

from app.backend.services.file_service import FileService


@pytest.fixture
def service() -> FileService:
    return FileService()


@pytest.fixture
def txt_file(tmp_path: Path) -> Path:
    f = tmp_path / "test.txt"
    f.write_text("これはテストテキストです。", encoding="utf-8")
    return f


@pytest.fixture
def md_file(tmp_path: Path) -> Path:
    f = tmp_path / "test.md"
    f.write_text("# 見出し\n\n本文テキスト", encoding="utf-8")
    return f


class TestFileServiceReadText:
    async def test_read_txt_file(self, service: FileService, txt_file: Path):
        text = await service.read_file_as_text(str(txt_file))
        assert "テストテキスト" in text

    async def test_read_md_file(self, service: FileService, md_file: Path):
        text = await service.read_file_as_text(str(md_file))
        assert "見出し" in text

    async def test_unsupported_format_raises(
        self, service: FileService, tmp_path: Path
    ):
        unsupported = tmp_path / "test.xyz"
        unsupported.write_text("data")
        with pytest.raises(Exception):
            await service.read_file_as_text(str(unsupported))

    async def test_nonexistent_file_raises(self, service: FileService):
        with pytest.raises(Exception):
            await service.read_file_as_text("/nonexistent/path/file.txt")
