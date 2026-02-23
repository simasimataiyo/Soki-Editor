/**
 * Modal — 共通モーダルシステム
 * ブラウザのprompt/confirmをモーダルで代替
 */

const Modal = (() => {
  const _callbacks = {};

  // ─── プライベート関数 ─────────────────────────────────────

  function _createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    return overlay;
  }

  function _createModal(content, options = {}) {
    const modal = document.createElement('div');
    modal.className = 'modal' + (options.large ? ' modal-lg' : '');
    modal.innerHTML = content;
    return modal;
  }

  function _showModal(modalEl) {
    const overlay = _createOverlay();
    overlay.appendChild(modalEl);
    document.body.appendChild(overlay);
    // オーバーレイクリックで閉じない（明示的なキャンセルボタンのみ）
  }

  function _closeModal(overlay) {
    overlay.remove();
  }

  // ─── 公開API ─────────────────────────────────────────────

  /**
   * テキスト入力プロンプトモーダル
   * @param {string} title - タイトル
   * @param {string} message - メッセージ
   * @param {string} defaultValue - デフォルト値
   * @param {object} options - オプション
   * @returns {Promise<string|null>} 入力値（キャンセル時はnull）
   */
  async function prompt(title, message, defaultValue = '', options = {}) {
    return new Promise((resolve) => {
      const modalId = 'modal-prompt-' + Date.now();
      const modalContent = `
        <h3>${escHtml(title)}</h3>
        ${message ? `<p style="margin-bottom:12px;color:var(--color-text-muted)">${escHtml(message)}</p>` : ''}
        <div class="form-group" style="margin-bottom:16px">
          <input type="text" id="${modalId}-input" class="form-control" value="${escHtml(defaultValue)}" autofocus />
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="${modalId}-cancel">キャンセル</button>
          <button class="btn btn-primary" id="${modalId}-confirm">OK</button>
        </div>
      `;

      const modalEl = _createModal(modalContent, options);
      _showModal(modalEl);

      const overlay = modalEl.parentElement;
      const inputEl = document.getElementById(`${modalId}-input`);

      // 確定ボタン
      document.getElementById(`${modalId}-confirm`).addEventListener('click', () => {
        resolve(inputEl.value);
        _closeModal(overlay);
      });

      // キャンセルボタン
      document.getElementById(`${modalId}-cancel`).addEventListener('click', () => {
        resolve(null);
        _closeModal(overlay);
      });

      // キーハンドラ
      modalEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          document.getElementById(`${modalId}-confirm`).click();
        } else if (e.key === 'Escape') {
          resolve(null);
          _closeModal(overlay);
        }
      });

      // フォーカス設定
      setTimeout(() => inputEl.focus(), 10);
    });
  }

  /**
   * 確認プロンプトモーダル
   * @param {string} message - メッセージ
   * @param {object} options - オプション
   * @returns {Promise<boolean>} true: OK, false: キャンセル
   */
  async function confirm(message, options = {}) {
    return new Promise((resolve) => {
      const modalId = 'modal-confirm-' + Date.now();
      const modalContent = `
        <h3>${options.title || '確認'}</h3>
        <p style="margin-bottom:16px;line-height:1.6">${escHtml(message)}</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="${modalId}-cancel">キャンセル</button>
          <button class="btn btn-primary ${options.danger ? 'btn-danger' : ''}" id="${modalId}-confirm">
            ${options.confirmText || 'OK'}
          </button>
        </div>
      `;

      const modalEl = _createModal(modalContent, options);
      _showModal(modalEl);

      const overlay = modalEl.parentElement;
      const confirmBtn = document.getElementById(`${modalId}-confirm`);

      // 確定ボタン
      confirmBtn.addEventListener('click', () => {
        resolve(true);
        _closeModal(overlay);
      });

      // キャンセルボタン
      document.getElementById(`${modalId}-cancel`).addEventListener('click', () => {
        resolve(false);
        _closeModal(overlay);
      });

      // キーハンドラ（Enterで確定、Escapeでキャンセル）
      modalEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirmBtn.click();
        } else if (e.key === 'Escape') {
          resolve(false);
          _closeModal(overlay);
        }
      });

      // 確定ボタンにフォーカス
      setTimeout(() => confirmBtn.focus(), 10);
    });
  }

  /**
   * 選択プロンプトモーダル（セレクトボックス付き）
   * @param {string} title - タイトル
   * @param {string} message - メッセージ
   * @param {Array} items - 選択肢 [{value, label}]
   * @param {object} options - オプション
   * @returns {Promise<string|null>} 選択したvalue（キャンセル時はnull）
   */
  async function select(title, message, items, options = {}) {
    return new Promise((resolve) => {
      const modalId = 'modal-select-' + Date.now();
      const modalContent = `
        <h3>${escHtml(title)}</h3>
        ${message ? `<p style="margin-bottom:12px;color:var(--color-text-muted)">${escHtml(message)}</p>` : ''}
        <div class="form-group" style="margin-bottom:16px">
          <select id="${modalId}-select" class="form-control" size="${options.large ? 8 : 5}">
            ${items.map(item => `<option value="${escHtml(item.value)}">${escHtml(item.label)}</option>`).join('')}
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="${modalId}-cancel">キャンセル</button>
          <button class="btn btn-primary" id="${modalId}-confirm">選択</button>
        </div>
      `;

      const modalEl = _createModal(modalContent, { large: options.large });
      _showModal(modalEl);

      const overlay = modalEl.parentElement;
      const selectEl = document.getElementById(`${modalId}-select`);
      const confirmBtn = document.getElementById(`${modalId}-confirm`);

      // 確定ボタン
      confirmBtn.addEventListener('click', () => {
        resolve(selectEl.value);
        _closeModal(overlay);
      });

      // キャンセルボタン
      document.getElementById(`${modalId}-cancel`).addEventListener('click', () => {
        resolve(null);
        _closeModal(overlay);
      });

      // ダブルクリックで即決定
      selectEl.addEventListener('dblclick', () => {
        resolve(selectEl.value);
        _closeModal(overlay);
      });

      // キーハンドラ
      modalEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          confirmBtn.click();
        } else if (e.key === 'Escape') {
          resolve(null);
          _closeModal(overlay);
        }
      });

      // selectにフォーカス
      setTimeout(() => selectEl.focus(), 10);
    });
  }

  /**
   * フォーム入力モーダル（複数フィールド）
   * @param {string} title - タイトル
   * @param {Array} fields - フィールド定義 [{name, label, type, value, options}]
   * @param {object} options - オプション
   * @param {string} options.confirmText - 確定ボタンのテキスト（デフォルト: '追加'）
   * @param {Array} options.extraButtons - 追加ボタン [{id, label, className, onClick}]
   * @returns {Promise<object|null>} 入力値オブジェクト（キャンセル時はnull）
   */
  async function form(title, fields, options = {}) {
    return new Promise((resolve) => {
      const modalId = 'modal-form-' + Date.now();

      const fieldHtml = fields.map(field => {
        const labelHtml = `<label style="font-size:12px;font-weight:600;color:var(--color-text-muted)">${escHtml(field.label)}</label>`;
        let inputHtml = '';

        if (field.type === 'select') {
          const defaultVal = field.value !== undefined && field.value !== null ? String(field.value) : '';
          inputHtml = `
            <select id="${modalId}-${field.name}" class="form-control" style="margin-bottom:12px">
              ${field.options.map(opt => `<option value="${escHtml(opt.value)}"${String(opt.value) === defaultVal ? ' selected' : ''}>${escHtml(opt.label)}</option>`).join('')}
            </select>
          `;
        } else if (field.type === 'textarea') {
          inputHtml = `
            <textarea id="${modalId}-${field.name}" class="form-control" rows="4" style="margin-bottom:12px">${escHtml(field.value || '')}</textarea>
          `;
        } else {
          inputHtml = `
            <input type="${field.type || 'text'}" id="${modalId}-${field.name}" class="form-control" value="${escHtml(field.value || '')}" style="margin-bottom:12px" />
          `;
        }

        return `<div class="form-group">${labelHtml}${inputHtml}</div>`;
      }).join('');

      const modalContent = `
        <h3>${escHtml(title)}</h3>
        ${options.message ? `<p style="margin-bottom:12px;color:var(--color-text-muted)">${escHtml(options.message)}</p>` : ''}
        ${fieldHtml}
        <div class="modal-actions">
          <button class="btn btn-secondary" id="${modalId}-cancel">キャンセル</button>
          ${options.extraButtons ? options.extraButtons.map(btn =>
            `<button class="btn ${btn.className || 'btn-secondary'}" id="${modalId}-${btn.id}">${escHtml(btn.label)}</button>`
          ).join('') : ''}
          <button class="btn btn-primary" id="${modalId}-confirm">${escHtml(options.confirmText || '追加')}</button>
        </div>
      `;

      const modalEl = _createModal(modalContent, { large: options.large });
      _showModal(modalEl);

      const overlay = modalEl.parentElement;
      const confirmBtn = document.getElementById(`${modalId}-confirm`);

      // 追加ボタン（もしあれば）
      if (options.extraButtons) {
        options.extraButtons.forEach(btn => {
          const btnEl = document.getElementById(`${modalId}-${btn.id}`);
          if (btnEl && btn.onClick) {
            btnEl.addEventListener('click', () => {
              const result = {};
              fields.forEach(field => {
                const el = document.getElementById(`${modalId}-${field.name}`);
                if (el) {
                  result[field.name] = el.value;
                }
              });
              btn.onClick(result, overlay, resolve, _closeModal);
            });
          }
        });
      }

      // 確定ボタン
      confirmBtn.addEventListener('click', () => {
        const result = {};
        fields.forEach(field => {
          const el = document.getElementById(`${modalId}-${field.name}`);
          if (el) {
            result[field.name] = el.value;
          }
        });
        resolve(result);
        _closeModal(overlay);
      });

      // キャンセルボタン
      document.getElementById(`${modalId}-cancel`).addEventListener('click', () => {
        resolve(null);
        _closeModal(overlay);
      });

      // キーハンドラ
      modalEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          // textarea 以外の入力フィールドで Enter が押された場合は確定
          if (e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
            e.preventDefault();
            confirmBtn.click();
          }
        } else if (e.key === 'Escape') {
          resolve(null);
          _closeModal(overlay);
        }
      });

      // 最初の入力欄にフォーカス（なければ確定ボタンにフォーカス）
      const firstInput = modalEl.querySelector('input:not([type="hidden"]), textarea, select');
      setTimeout(() => {
        if (firstInput) {
          firstInput.focus();
        } else {
          confirmBtn.focus();
        }
      }, 10);
    });
  }

  return {
    prompt,
    confirm,
    select,
    form,
  };
})();
