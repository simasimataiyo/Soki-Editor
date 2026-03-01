/**
 * ChatBarCommon — エディット・レビュータブのチャットバー共通処理
 *
 * コマンドパース、オートコンプリート、リサイズハンドル、Enter送信などの共通機能
 */

const ChatBarCommon = (() => {
  // 入力欄ID → 設定のマップ
  const _configByInputId = new Map();

  /**
   * チャットバーを初期化
   * @param {string} inputId - textareaのID
   * @param {string} sendBtnId - 送信ボタンのID
   * @param {string} tab - タブ名 ('edit' | 'review')
   * @param {Object} config - 追加設定
   * @param {Function} config.onSend - 送信時のコールバック (parsed) => void
   * @param {Function} config.onEnter - Enterキー押下時のコールバック (e) => boolean (trueで送信)
   * @param {Function} config.onResize - リサイズ時のコールバック (height) => void
   */
  function init(inputId, sendBtnId, tab, config = {}) {
    const input = document.getElementById(inputId);
    const sendBtn = document.getElementById(sendBtnId);
    if (!input || !sendBtn) return;

    _configByInputId.set(inputId, { ...config, tab, input, sendBtn });

    // Enterキーで送信 (Shift+Enterは改行)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        // オートコンプリートポップアップ表示中はEnter送信を抑止（候補確定のみ）
        if (window.AutocompletePopup && AutocompletePopup.isOpen()) return;

        let shouldSend = true;
        if (config.onEnter) {
          shouldSend = config.onEnter(e);
        }
        if (shouldSend) {
          e.preventDefault();
          _handleSend(inputId);
        }
      }
    });

    // 送信ボタンクリック
    sendBtn.addEventListener('click', () => _handleSend(inputId));
  }

  /**
   * 送信処理
   */
  async function _handleSend(inputId) {
    const config = _configByInputId.get(inputId);
    if (!config || !config.onSend) return;

    const { input, sendBtn, tab, onSend } = config;

    const message = input.value.trim();
    if (!message) return;

    // コマンドパース
    const parsed = CommandParser.parse(message, tab);
    if (parsed.error) {
      showToast(parsed.error, 'error');
      return;
    }

    await onSend(parsed);
  }

  /**
   * 入力欄の値を取得
   */
  function getValue(inputId) {
    const config = _configByInputId.get(inputId);
    return config ? config.input.value : '';
  }

  /**
   * 入力欄の値を設定
   */
  function setValue(inputId, value) {
    const config = _configByInputId.get(inputId);
    if (config) {
      config.input.value = value;
    }
  }

  /**
   * 入力欄をクリア
   */
  function clear(inputId) {
    setValue(inputId, '');
  }

  /**
   * 送信ボタンを有効/無効化
   */
  function setSendBtnEnabled(inputId, enabled) {
    const config = _configByInputId.get(inputId);
    if (config) {
      config.sendBtn.disabled = !enabled;
    }
  }

  return {
    init,
    getValue,
    setValue,
    clear,
    setSendBtnEnabled,
  };
})();

/**
 * リサイズハンドルの初期化（app.jsから移動）
 */
function initResizeHandle(handleId, textareaId) {
  const resizeHandle = document.getElementById(handleId);
  const textarea = document.getElementById(textareaId);
  if (!resizeHandle || !textarea) return;

  let isResizing = false;
  let startY = 0;
  let startHeight = 0;

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startY = e.clientY;
    startHeight = textarea.offsetHeight;
    resizeHandle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const dy = e.clientY - startY;
    const newHeight = Math.max(40, Math.min(300, startHeight - dy));
    textarea.style.height = newHeight + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizeHandle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
  });
}

// app.jsから呼び出せるようにグローバルに公開
window.initResizeHandle = initResizeHandle;

