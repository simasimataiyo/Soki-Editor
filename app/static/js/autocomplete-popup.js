import { appState } from './state-manager.js';
import { CommandParser } from './command-parser.js';
import { escHtml } from './dom-utils.js';

/**
 * AutocompletePopup — @ 入力時のソース・マテリアル補完 & / コマンドヒント
 */

export const AutocompletePopup = (() => {
  let _popup = null;
  let _textarea = null;
  let _items = [];
  let _filteredItems = [];
  let _selectedIndex = 0;
  let _triggerPos = -1;
  let _mode = null; // 'ref' | 'command'
  const SCROLL_DELAY_MS = 3000;
  const SCROLL_STEP_PX = 2;
  const SCROLL_INTERVAL_MS = 30;
  const _labelScrollTimeouts = new Map();
  const _labelScrollIntervals = new Map();

  /**
   * 複数のテキストエリアにバインドする（共有ポップアップ）
   * @param {string[]} textareaIds
   */
  function attachAll(textareaIds) {
    textareaIds.forEach(id => {
      const textarea = document.getElementById(id);
      if (!textarea) return;

      textarea.addEventListener('input', () => {
        _textarea = textarea;
        _onInput();
      });
      textarea.addEventListener('keydown', (e) => {
        if (_textarea !== textarea) return;
        _onKeydown(e);
      });
      textarea.addEventListener('blur', () => {
        if (_textarea === textarea) {
          setTimeout(_hide, 200);
        }
      });
    });
  }

  function _onInput() {
    if (!_textarea) return;

    const val = _textarea.value;
    const pos = _textarea.selectionStart;
    const before = val.substring(0, pos);

    // --- コマンドヒント: テキスト先頭が "/" の場合 ---
    if (before.match(/^\/\S*$/) && !before.includes(' ')) {
      _mode = 'command';
      _triggerPos = 0;
      const query = before.substring(1); // '/' を除く
      _refreshCommandItems();
      _filterCommandItems(query);
      _show();
      return;
    }

    // --- @参照: 最後の "@" を検出 ---
    const atIdx = before.lastIndexOf('@');

    if (atIdx === -1) {
      _hide();
      return;
    }

    // @ の前がスペースか行頭でなければ無視
    if (atIdx > 0 && !/[\s\n]/.test(before[atIdx - 1])) {
      _hide();
      return;
    }

    // @ からカーソルまでのクエリを取得
    const query = before.substring(atIdx + 1);

    // クエリにスペースや改行があればポップアップ閉じる
    if (/[\s\n]/.test(query)) {
      _hide();
      return;
    }

    _mode = 'ref';
    _triggerPos = atIdx;
    _refreshRefItems();
    _filterRefItems(query);
    _show();
  }

  function _onKeydown(e) {
    if (!_popup || _popup.style.display === 'none') return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _selectedIndex = Math.min(_selectedIndex + 1, _filteredItems.length - 1);
      _renderItems();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _selectedIndex = Math.max(_selectedIndex - 1, 0);
      _renderItems();
    } else if (e.key === 'Tab' || (e.key === 'Enter' && _filteredItems.length > 0)) {
      // Tab または Enter で補完確定（送信との競合防止のため他のハンドラも止める）
      e.preventDefault();
      e.stopImmediatePropagation();
      _confirmSelection(_selectedIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      _hide();
    }
  }

  // ─── @参照アイテム ────────────────────────────────────

  function _refreshRefItems() {
    const project = appState.getProject();
    if (!project) { _items = []; return; }

    _items = [
      ...(project.sources || []).map(s => ({
        type: 'source',
        id: s.id,
        label: s.bibliography?.title || s.name || s.id,
        insertText: `@source:${s.id}`,
      })),
      ...(project.materials || []).map(m => ({
        type: 'material',
        id: m.id,
        label: m.name || m.id,
        insertText: `@material:${m.id}`,
      })),
    ];
  }

  function _filterRefItems(query) {
    const q = query.toLowerCase();
    if (!q) {
      _filteredItems = _items.slice(0, 20);
    } else {
      _filteredItems = _items.filter(item =>
        item.id.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q) ||
        item.type.toLowerCase().includes(q)
      ).slice(0, 20);
    }
    _selectedIndex = 0;
  }

  // ─── コマンドヒントアイテム ─────────────────────────────

  function _refreshCommandItems() {
    // 現在のタブに応じてコマンドリストを取得
    const activeTab = appState.getState().activeTab || 'edit';
    const tab = (activeTab === 'review') ? 'review' : 'edit';
    const commands = CommandParser.getAvailableCommands(tab);

    _items = commands.map(cmd => ({
      type: 'command',
      id: cmd.name,
      label: cmd.description,
      insertText: cmd.name + ' ',
      knownArgs: cmd.knownArgs || [],
    }));
  }

  function _filterCommandItems(query) {
    const q = query.toLowerCase();
    if (!q) {
      _filteredItems = _items;
    } else {
      _filteredItems = _items.filter(item =>
        item.id.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q)
      );
    }
    _selectedIndex = 0;
  }

  // ─── 共通UI ──────────────────────────────────────────

  function _show() {
    if (_filteredItems.length === 0) { _hide(); return; }
    if (!_popup) _createPopup();

    _clearLabelScrolls();
    _renderItems();
    _attachLabelScrolls();

    // テキストエリアの上に配置
    const rect = _textarea.getBoundingClientRect();
    _popup.style.left = rect.left + 'px';
    _popup.style.width = Math.max(280, rect.width * 0.6) + 'px';
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    const showBelow = spaceBelow > spaceAbove || spaceAbove < 160;
    if (showBelow) {
      _popup.style.top = rect.bottom + 4 + 'px';
      _popup.style.bottom = 'auto';
    } else {
      _popup.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      _popup.style.top = 'auto';
    }
    _popup.style.display = 'block';
  }

  function _hide() {
    if (_popup) {
      _popup.style.display = 'none';
      _popup.querySelectorAll('.ac-label').forEach(label => { label.scrollLeft = 0; });
    }
    _clearLabelScrolls();
    _triggerPos = -1;
    _mode = null;
  }

  function _createPopup() {
    _popup = document.createElement('div');
    _popup.className = 'autocomplete-popup';
    _popup.style.display = 'none';
    document.body.appendChild(_popup);
  }

  function _clearLabelScrolls() {
    _labelScrollTimeouts.forEach(id => clearTimeout(id));
    _labelScrollIntervals.forEach(id => clearInterval(id));
    _labelScrollTimeouts.clear();
    _labelScrollIntervals.clear();
  }

  function _scheduleLabelScroll(label) {
    const maxScroll = label.scrollWidth - label.clientWidth;
    if (maxScroll <= 0) return;
    const timerId = setTimeout(() => {
      const intervalId = setInterval(() => {
        const next = Math.min(label.scrollLeft + SCROLL_STEP_PX, maxScroll);
        label.scrollLeft = next;
        if (next >= maxScroll) {
          clearInterval(intervalId);
          _labelScrollIntervals.delete(label);
          label.scrollLeft = 0;
          _labelScrollTimeouts.set(label, setTimeout(() => _scheduleLabelScroll(label), SCROLL_DELAY_MS));
        }
      }, SCROLL_INTERVAL_MS);
      _labelScrollIntervals.set(label, intervalId);
    }, SCROLL_DELAY_MS);
    _labelScrollTimeouts.set(label, timerId);
  }

  function _attachLabelScrolls() {
    if (!_popup) return;
    _popup.querySelectorAll('.ac-label').forEach(label => {
      label.scrollLeft = 0;
      _scheduleLabelScroll(label);
    });
  }

  function _renderItems() {
    if (!_popup) return;

    if (_mode === 'command') {
      _popup.innerHTML = _filteredItems.map((item, i) => {
        const argsHint = item.knownArgs && item.knownArgs.length > 0
          ? `<span class="ac-id">[${item.knownArgs.join(' | ')}]</span>`
          : '';
        return `
          <div class="ac-item${i === _selectedIndex ? ' selected' : ''}" data-index="${i}">
            <span class="cmd-hint-name">${escHtml(item.id)}</span>
            <span class="ac-label">${escHtml(item.label)}</span>
            ${argsHint}
          </div>
        `;
      }).join('');
    } else {
      _popup.innerHTML = _filteredItems.map((item, i) => `
        <div class="ac-item${i === _selectedIndex ? ' selected' : ''}" data-index="${i}">
          <span class="ac-type ${item.type}">${item.type === 'source' ? 'S' : 'M'}</span>
          <span class="ac-label">${escHtml(item.label)}</span>
          <span class="ac-id">${escHtml(item.id)}</span>
        </div>
      `).join('');
    }

    // クリックハンドラ
    _popup.querySelectorAll('.ac-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        _confirmSelection(parseInt(el.dataset.index));
      });
    });

    // 選択中アイテムをスクロールに表示
    const selectedEl = _popup.querySelector('.ac-item.selected');
    if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
  }

  function _confirmSelection(index) {
    const item = _filteredItems[index];
    if (!item || !_textarea) return;

    const val = _textarea.value;
    const before = val.substring(0, _triggerPos);
    const after = val.substring(_textarea.selectionStart);

    _textarea.value = before + item.insertText + after;
    const newPos = before.length + item.insertText.length;
    _textarea.setSelectionRange(newPos, newPos);
    _textarea.focus();
    _hide();

    // input イベントを発火
    _textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function isOpen() {
    return !!(_popup && _popup.style.display !== 'none');
  }

  return { attachAll, isOpen };
})();
