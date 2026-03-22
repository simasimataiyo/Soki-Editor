/**
 * BubblePrompt - Tiptapエディタ内からAIにプロンプトを送るインラインフォーム
 * Ctrl+K でトグル表示。/ コマンドと @ 参照に対応。
 */
import { AutocompletePopup } from './autocomplete-popup.js';
import { CommandParser } from './command-parser.js';

export const BubblePrompt = (function () {
  let _el = null;
  let _textarea = null;
  let _isVisible = false;
  let _capturedSelectedText = '';

  function _ensureEl() {
    if (_el) return _el;

    _el = document.createElement('div');
    _el.className = 'bubble-prompt';
    _el.id = 'bubble-prompt';
    _el.innerHTML = [
      '<div class="bubble-prompt-body">',
      '  <div id="bubble-prompt-selection-badge" class="bubble-prompt-selection-badge" style="display:none"></div>',
      '  <textarea id="bubble-prompt-input" class="bubble-prompt-textarea"',
      '    placeholder="AIプロンプトを入力（/ でコマンド、@ で参照）" rows="2"></textarea>',
      '  <div class="bubble-prompt-actions">',
      '    <span class="bubble-prompt-hint">Enter 送信 / Shift+Enter 改行 / Esc 閉じる</span>',
      '    <button class="btn-icon btn-send" id="bubble-prompt-send-btn" title="送信">',
      '      <svg viewBox="0 0 16 16" width="16" height="16"',
      '           fill="none" stroke="currentColor" stroke-width="1.5"',
      '           stroke-linecap="round" stroke-linejoin="round">',
      '        <line x1="8" y1="13" x2="8" y2="3" />',
      '        <polyline points="4,7 8,3 12,7" />',
      '      </svg>',
      '    </button>',
      '  </div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(_el);

    _textarea = _el.querySelector('#bubble-prompt-input');

    // オートコンプリートをバブルのテキストエリアにも適用（1度のみ）
    AutocompletePopup.attachAll(['bubble-prompt-input']);

    // キーボードハンドラ
    _textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        hide();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        // オートコンプリートが開いている間は送信しない（候補確定のみ）
        if (AutocompletePopup.isOpen()) return;
        e.preventDefault();
        _handleSend();
      }
    });

    // 送信ボタン
    _el.querySelector('#bubble-prompt-send-btn').addEventListener('click', _handleSend);

    // クリックアウトで閉じる
    document.addEventListener('mousedown', function (e) {
      if (!_isVisible) return;
      if (_el.contains(e.target)) return;
      // オートコンプリートポップアップのクリックは無視
      var popup = document.querySelector('.autocomplete-popup');
      if (popup && popup.contains(e.target)) return;
      hide();
    });

    return _el;
  }

  function _position(rect) {
    var EL_W = 420;
    var PADDING = 8;
    var elH = _el.offsetHeight || 90;

    var top = rect.top - elH - PADDING;
    if (top < PADDING) top = rect.bottom + PADDING; // 上に入らない場合は下に表示

    var left = rect.left;
    if (left + EL_W > window.innerWidth - PADDING) {
      left = window.innerWidth - EL_W - PADDING;
    }
    left = Math.max(PADDING, left);

    _el.style.top = top + 'px';
    _el.style.left = left + 'px';
  }

  function _handleSend() {
    var message = _textarea.value.trim();
    if (!message) return;

    var parsed = CommandParser.parse(message, 'edit');

    if (parsed.error) {
      // app.js の showToast はモジュールスコープ外なのでカスタムイベントで通知
      document.dispatchEvent(new CustomEvent('bubble-prompt-error', { detail: parsed.error }));
      return;
    }

    // バブルを開いた時点でキャプチャした選択テキストを渡す
    parsed._capturedSelectedText = _capturedSelectedText;

    document.dispatchEvent(new CustomEvent('bubble-prompt-send', { detail: parsed }));
    hide();
  }

  function show(rect, capturedText) {
    var el = _ensureEl();
    _capturedSelectedText = capturedText || '';

    // 選択バッジの表示更新
    var badge = el.querySelector('#bubble-prompt-selection-badge');
    if (badge) {
      if (_capturedSelectedText) {
        var charCount = _capturedSelectedText.replace(/\s/g, '').length;
        badge.textContent = '選択中: ' + charCount.toLocaleString() + ' 文字をコンテキストに含む';
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }

    el.style.visibility = 'hidden';
    el.style.display = 'block';
    _isVisible = true;

    // 描画後にサイズが確定するので requestAnimationFrame で位置を計算
    requestAnimationFrame(function () {
      _position(rect);
      el.style.visibility = 'visible';
      _textarea.focus();
    });
  }

  function hide() {
    if (!_el) return;
    _el.style.display = 'none';
    _isVisible = false;
    _capturedSelectedText = '';
    if (_textarea) _textarea.value = '';
  }

  function toggle(rect, capturedText) {
    if (_isVisible) {
      hide();
    } else {
      show(rect, capturedText);
    }
  }

  return {
    show: show,
    hide: hide,
    toggle: toggle,
    isVisible: function () { return _isVisible; },
  };
})();

