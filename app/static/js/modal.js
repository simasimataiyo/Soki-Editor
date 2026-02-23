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

    // Enterキーで最初のボタンをクリック
    const firstButton = modalEl.querySelector('button:not([disabled])');
    if (firstButton) {
      firstButton.focus();
      const handler = (e) => {
        if (e.key === 'Enter') firstButton.click();
      };
      modalEl.addEventListener('keydown', handler);
    }

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

      // フォーカス設定
      setTimeout(() => inputEl.focus(), 10);

      // Enterキーで確定
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          document.getElementById(`${modalId}-confirm`).click();
        }
      });

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

      // Escキーでキャンセル
      modalEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          resolve(null);
          _closeModal(overlay);
        }
      });
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

      // 確定ボタン
      document.getElementById(`${modalId}-confirm`).addEventListener('click', () => {
        resolve(true);
        _closeModal(overlay);
      });

      // キャンセルボタン
      document.getElementById(`${modalId}-cancel`).addEventListener('click', () => {
        resolve(false);
        _closeModal(overlay);
      });

      // Escキーでキャンセル
      modalEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          resolve(false);
          _closeModal(overlay);
        }
      });
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

      // 確定ボタン
      document.getElementById(`${modalId}-confirm`).addEventListener('click', () => {
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

      // Escキーでキャンセル
      modalEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          resolve(null);
          _closeModal(overlay);
        }
      });
    });
  }

  /**
   * フォーム入力モーダル（複数フィールド）
   * @param {string} title - タイトル
   * @param {Array} fields - フィールド定義 [{name, label, type, value, options}]
   * @param {object} options - オプション
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
          <button class="btn btn-primary" id="${modalId}-confirm">追加</button>
        </div>
      `;

      const modalEl = _createModal(modalContent, { large: options.large });
      _showModal(modalEl);

      const overlay = modalEl.parentElement;

      // 最初の入力欄にフォーカス
      const firstInput = modalEl.querySelector('input, textarea, select');
      if (firstInput) {
        setTimeout(() => firstInput.focus(), 10);

        // Enterキーで確定（textarea除く）
        if (firstInput.tagName !== 'TEXTAREA') {
          firstInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              document.getElementById(`${modalId}-confirm`).click();
            }
          });
        }
      }

      // 確定ボタン
      document.getElementById(`${modalId}-confirm`).addEventListener('click', () => {
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

      // Escキーでキャンセル
      modalEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          resolve(null);
          _closeModal(overlay);
        }
      });
    });
  }

  return {
    prompt,
    confirm,
    select,
    form,
  };
})();
