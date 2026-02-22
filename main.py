"""Soki Editor — アプリケーション起動スクリプト"""
from __future__ import annotations

import socket
import threading
import time
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def _find_free_port(start: int = 8080, end: int = 8099) -> int:
    """8080–8099 の範囲で空きポートを探す。"""
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("8080–8099 の範囲に空きポートがありません")


def _wait_for_port(host: str, port: int, timeout: float = 15.0) -> bool:
    """ポートが LISTEN 状態になるまで待機する。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except (ConnectionRefusedError, OSError):
            time.sleep(0.1)
    return False


def _start_uvicorn(port: int) -> None:
    """Uvicorn を daemon スレッドで起動する。"""
    import uvicorn
    from app.backend.main import app

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        log_level="info",
        access_log=False,
    )


def main() -> None:
    port = _find_free_port()
    logger.info("起動ポート: %d", port)

    # Uvicorn を daemon スレッドで起動
    thread = threading.Thread(
        target=_start_uvicorn,
        args=(port,),
        daemon=True,
        name="uvicorn-thread",
    )
    thread.start()

    # ポートが LISTEN 状態になるまで待機
    logger.info("サーバー起動待機中 (port=%d)...", port)
    if not _wait_for_port("127.0.0.1", port, timeout=15.0):
        logger.error("サーバーが起動しませんでした")
        sys.exit(1)

    logger.info("サーバー起動完了。WebView を開きます...")

    # pywebview でウィンドウを生成・起動
    try:
        import webview

        window = webview.create_window(
            title="Soki Editor",
            url=f"http://127.0.0.1:{port}/",
            width=1400,
            height=900,
            min_size=(900, 600),
            resizable=True,
        )
        webview.start(debug=False)
    except ImportError:
        logger.warning("pywebview が見つかりません。ブラウザでアクセスしてください: http://127.0.0.1:%d/", port)
        # pywebview なし → スレッドが終了しないように待機
        thread.join()


if __name__ == "__main__":
    main()
