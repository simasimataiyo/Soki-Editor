/**
 * Modal — 共通モーダルシステム
 * ブラウザのprompt/confirmをモーダルで代替
 * モーダルが既に開いている場合は「次ページ」として表示し、「← 戻る」で前のページへ戻る
 */

const Modal = (() => {
  // ─── シングルトン状態 ─────────────────────────────────────

  let _overlayEl = null;
  let _modalEl = null;
  const _pageStack = [];   // [{renderFn, resolve}]
  let _keydownHandler = null;

  // ─── プライベート関数 ─────────────────────────────────────

  function _ensureOverlay() {
    if (_overlayEl) return;
    _overlayEl = document.createElement('div');
    _overlayEl.className = 'modal-overlay';
    _overlayEl.style.display = 'flex';
    _modalEl = document.createElement('div');
    _modalEl.className = 'modal';
    _overlayEl.appendChild(_modalEl);
    document.body.appendChild(_overlayEl);
  }

  /**
   * 新しいページをスタックに積んでレンダリング
   * @param {function} renderFn - (modalEl) => void
   * @param {function} resolve  - Promise の resolve
   * @param {object}   options  - { large }
   */
  function _pushPage(renderFn, resolve, options = {}) {
    _ensureOverlay();
    if (options.large) {
      _modalEl.classList.add('modal-lg');
    }
    _pageStack.push({ renderFn, resolve });
    _renderCurrentPage();
  }

  function _renderCurrentPage() {
    if (!_modalEl || _pageStack.length === 0) return;
    const { renderFn } = _pageStack[_pageStack.length - 1];
    const hasBack = _pageStack.length > 1;

    _modalEl.innerHTML = '';
    if (_keydownHandler) {
      document.removeEventListener('keydown', _keydownHandler);
      _keydownHandler = null;
    }

    if (hasBack) {
      const backBtn = document.createElement('button');
      backBtn.className = 'btn btn-tertiary btn-sm modal-back-btn';
      backBtn.textContent = '← 戻る';
      backBtn.addEventListener('click', () => _goBack());
      _modalEl.appendChild(backBtn);
    }

    renderFn(_modalEl);

    // Escape キーハンドラ
    _keydownHandler = (e) => {
      if (e.key === 'Escape') _goBack();
    };
    document.addEventListener('keydown', _keydownHandler);
  }

  /** 現在のページを閉じ（resolve(null)）前のページへ戻る。スタックが1以下なら全閉鎖 */
  function _goBack() {
    if (_pageStack.length <= 1) {
      _closeAll();
      return;
    }
    const popped = _pageStack.pop();
    if (popped.resolve) popped.resolve(null);
    _renderCurrentPage();
  }

  /** 現在のページを確定して閉じる（resolveは呼び出し元が行う） */
  function _closeAll() {
    if (_keydownHandler) {
      document.removeEventListener('keydown', _keydownHandler);
      _keydownHandler = null;
    }
    if (_overlayEl) {
      _overlayEl.remove();
      _overlayEl = null;
      _modalEl = null;
    }
    // 残存ページの resolve を null で解決
    while (_pageStack.length > 0) {
      const page = _pageStack.pop();
      if (page.resolve) page.resolve(null);
    }
  }

  // ─── 公開API ─────────────────────────────────────────────

  /**
   * テキスト入力プロンプトモーダル
   */
  async function prompt(title, message, defaultValue = '', options = {}) {
    return new Promise((resolve) => {
      const modalId = 'modal-prompt-' + Date.now();

      function renderFn(modal) {
        modal.insertAdjacentHTML('beforeend', `
          <h3>${escHtml(title)}</h3>
          ${message ? `<p style="margin-bottom:12px;color:var(--color-text-muted)">${escHtml(message)}</p>` : ''}
          <div class="form-group" style="margin-bottom:16px">
            <input type="text" id="${modalId}-input" class="form-control" value="${escHtml(defaultValue)}" autofocus />
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary" id="${modalId}-cancel">キャンセル</button>
            <button class="btn btn-primary" id="${modalId}-confirm">OK</button>
          </div>
        `);

        const inputEl = document.getElementById(`${modalId}-input`);
        const confirmBtn = document.getElementById(`${modalId}-confirm`);

        confirmBtn.addEventListener('click', () => {
          const val = inputEl.value;
          resolve(val);
          _closeAll();
        });

        document.getElementById(`${modalId}-cancel`).addEventListener('click', () => {
          resolve(null);
          _goBack();
        });

        confirmBtn.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); }
        });
        inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); }
        });

        setTimeout(() => inputEl.focus(), 10);
      }

      _pushPage(renderFn, resolve, options);
    });
  }

  /**
   * 確認プロンプトモーダル
   */
  async function confirm(message, options = {}) {
    return new Promise((resolve) => {
      const modalId = 'modal-confirm-' + Date.now();

      function renderFn(modal) {
        modal.insertAdjacentHTML('beforeend', `
          <h3>${options.title || '確認'}</h3>
          <p style="margin-bottom:16px;line-height:1.6">${escHtml(message)}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" id="${modalId}-cancel">キャンセル</button>
            <button class="btn btn-primary ${options.danger ? 'btn-danger' : ''}" id="${modalId}-confirm">
              ${options.confirmText || 'OK'}
            </button>
          </div>
        `);

        const confirmBtn = document.getElementById(`${modalId}-confirm`);

        confirmBtn.addEventListener('click', () => {
          resolve(true);
          _closeAll();
        });

        document.getElementById(`${modalId}-cancel`).addEventListener('click', () => {
          resolve(false);
          _goBack();
        });

        confirmBtn.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); }
        });

        setTimeout(() => confirmBtn.focus(), 10);
      }

      _pushPage(renderFn, resolve, options);
    });
  }

  /**
   * 選択プロンプトモーダル（セレクトボックス付き）
   */
  async function select(title, message, items, options = {}) {
    return new Promise((resolve) => {
      const modalId = 'modal-select-' + Date.now();

      function renderFn(modal) {
        modal.insertAdjacentHTML('beforeend', `
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
        `);

        const selectEl = document.getElementById(`${modalId}-select`);
        const confirmBtn = document.getElementById(`${modalId}-confirm`);

        confirmBtn.addEventListener('click', () => {
          resolve(selectEl.value);
          _closeAll();
        });

        document.getElementById(`${modalId}-cancel`).addEventListener('click', () => {
          resolve(null);
          _goBack();
        });

        selectEl.addEventListener('dblclick', () => {
          resolve(selectEl.value);
          _closeAll();
        });

        confirmBtn.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); }
        });

        setTimeout(() => selectEl.focus(), 10);
      }

      _pushPage(renderFn, resolve, { large: options.large });
    });
  }

  /**
   * フォーム入力モーダル（複数フィールド）
   */
  async function form(title, fields, options = {}) {
    return new Promise((resolve) => {
      const modalId = 'modal-form-' + Date.now();

      function renderFn(modal) {
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

        modal.insertAdjacentHTML('beforeend', `
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
        `);

        const confirmBtn = document.getElementById(`${modalId}-confirm`);

        function _getFormValues() {
          const result = {};
          fields.forEach(field => {
            const el = document.getElementById(`${modalId}-${field.name}`);
            if (el) result[field.name] = el.value;
          });
          return result;
        }

        // 追加ボタン（もしあれば）
        if (options.extraButtons) {
          options.extraButtons.forEach(btn => {
            const btnEl = document.getElementById(`${modalId}-${btn.id}`);
            if (btnEl && btn.onClick) {
              btnEl.addEventListener('click', () => {
                btn.onClick(_getFormValues(), null, resolve, _goBack);
              });
            }
          });
        }

        // 確定ボタン
        confirmBtn.addEventListener('click', () => {
          resolve(_getFormValues());
          _closeAll();
        });

        // キャンセルボタン
        document.getElementById(`${modalId}-cancel`).addEventListener('click', () => {
          resolve(null);
          _goBack();
        });

        // キーハンドラ
        modal.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            if (e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
              e.preventDefault();
              confirmBtn.click();
            }
          }
        });

        // 最初の入力欄にフォーカス
        const firstInput = modal.querySelector('input:not([type="hidden"]), textarea, select');
        setTimeout(() => {
          if (firstInput) firstInput.focus();
          else confirmBtn.focus();
        }, 10);
      }

      _pushPage(renderFn, resolve, { large: options.large });
    });
  }

  return {
    prompt,
    confirm,
    select,
    form,
  };
})();
