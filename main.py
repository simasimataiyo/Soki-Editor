"""Soki Editor — アプリケーション起動スクリプト"""
from __future__ import annotations

import asyncio
import os
import socket
import sys
import threading
import time
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Uvicorn が使用しているイベントループを保持する（終了時の保存用）
_uvicorn_loop: asyncio.AbstractEventLoop | None = None
_exit_called = False
_webview_window = None  # ウィンドウ状態保存用


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
    global _uvicorn_loop
    import uvicorn
    from app.backend.main import app

    async def _run() -> None:
        global _uvicorn_loop
        _uvicorn_loop = asyncio.get_running_loop()
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            log_level="info",
            access_log=False,
        )
        server = uvicorn.Server(config)
        await server.serve()

    asyncio.run(_run())


def _get_dpi_scale_factor() -> float:
    """Windows の DPI スケールファクターを返す（例: 150% → 1.5）。取得失敗時は 1.0。"""
    try:
        from ctypes import windll
        return windll.shcore.GetScaleFactorForDevice(0) / 100
    except Exception:
        return 1.0


def _save_window_state() -> None:
    """現在のウィンドウサイズ・位置をグローバル設定に保存する。

    pywebview (winforms + EdgeChromium) は get_position()/get_size() で物理ピクセルを返し、
    create_window() に渡した x/y に内部で scale_factor を掛けて配置する。
    そのため保存時に scale_factor で割り、論理ピクセルに変換して保存する。
    """
    global _webview_window
    if _webview_window is None:
        return
    try:
        from app.backend.services.global_settings_service import GlobalSettingsService
        from app.backend.models import WindowState
        scale = _get_dpi_scale_factor()
        raw_w = _webview_window.width
        raw_h = _webview_window.height
        raw_x = _webview_window.x
        raw_y = _webview_window.y
        svc = GlobalSettingsService()
        settings = svc.get()
        settings.window_state = WindowState(
            width=round(raw_w / scale),
            height=round(raw_h / scale),
            x=round(raw_x / scale) if raw_x is not None else None,
            y=round(raw_y / scale) if raw_y is not None else None,
        )
        svc.save(settings)
        logger.info("ウィンドウ状態を保存: %dx%d @ (%s, %s) [scale=%.2f]",
                    raw_w, raw_h, raw_x, raw_y, scale)
    except Exception as e:
        logger.error("ウィンドウ状態の保存に失敗: %s", e)


def _save_all_and_exit() -> None:
    """ダーティなプロジェクトをすべて保存してから終了する。"""
    global _uvicorn_loop, _exit_called
    if _exit_called:
        return
    _exit_called = True
    if _uvicorn_loop and _uvicorn_loop.is_running():
        from app.backend.routers.projects import get_service
        svc = get_service()
        future = asyncio.run_coroutine_threadsafe(svc.flush_all_dirty(), _uvicorn_loop)
        try:
            future.result(timeout=10.0)
            logger.info("終了前保存完了")
        except Exception as e:
            logger.error("終了前保存中にエラー: %s", e)
    os._exit(0)


def main() -> None:
    # 開発モード判定: --dev フラグ or SOKI_DEV=1 環境変数、ただし frozen exe では常に False
    import app.backend.security as _security
    is_frozen = getattr(sys, "frozen", False)
    is_dev = not is_frozen and (
        "--dev" in sys.argv or os.environ.get("SOKI_DEV") == "1"
    )
    _security.DEV_MODE = is_dev
    if is_dev:
        logger.info("開発モード: トークン認証を無効化します")

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
        from app.backend.services.global_settings_service import GlobalSettingsService

        ws = GlobalSettingsService().get().window_state
        launch_url = f"http://127.0.0.1:{port}/launch/{_security.APP_TOKEN}"
        window = webview.create_window(
            title="Soki Editor",
            url=launch_url,
            width=ws.width,
            height=ws.height,
            x=ws.x,
            y=ws.y,
            min_size=(900, 600),
            resizable=True,
        )
        global _webview_window
        _webview_window = window
        window.events.closing += _save_window_state  # ウィンドウが閉じる前（GUI存在中）に保存
        window.events.closed += _save_all_and_exit
        try:
            webview.start(debug=_security.DEV_MODE)
        finally:
            _save_all_and_exit()
    except ImportError:
        logger.warning("pywebview が見つかりません。ブラウザでアクセスしてください: http://127.0.0.1:%d/", port)
        # pywebview なし → スレッドが終了しないように待機
        thread.join()


if __name__ == "__main__":
    main()
