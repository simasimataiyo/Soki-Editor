/**
 * AppShell — タブ切り替え・チャット機能・アプリ起動（タスク 10.1, 16）
 */

// ─── ユーティリティ ────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * トーストを表示する
 * @param {string} message
 * @param {string} type - 'info' | 'success' | 'error'
 * @param {{persistent?: boolean, spinner?: boolean}} options
 * @returns {HTMLElement} トースト要素
 */
function showToast(message, type = 'info', options = {}) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  if (options.spinner) {
    toast.innerHTML = `<span class="toast-spinner"></span><span>${escHtml(message)}</span>`;
  } else {
    toast.textContent = message;
  }
  container.appendChild(toast);
  if (!options.persistent) {
    setTimeout(() => toast.remove(), 3000);
  }
  return toast;
}

/** persistentトーストを消去する */
function dismissToast(toastEl) {
  if (toastEl && toastEl.parentElement) toastEl.remove();
}

// ─── グローバル SVG アイコン定数 ───────────────────────────────

// コラプス用シェブロン（12×12）
const SVG_CHEVRON_RIGHT = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,3 11,8 6,13"/></svg>`;
const SVG_CHEVRON_DOWN = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 8,11 13,6"/></svg>`;

// セクショントグル（14×14）
const SVG_TOGGLE_RIGHT = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,3 11,8 6,13"/></svg>`;
const SVG_TOGGLE_DOWN = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 8,11 13,6"/></svg>`;

// セクション操作アイコン（14×14）
const SVG_ADD_CHILD = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg>`;
const SVG_ARROW_UP = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,10 8,5 13,10"/></svg>`;
const SVG_ARROW_DOWN = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 8,11 13,6"/></svg>`;
const SVG_EDIT = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-8 8H3v-3l8-8z"/></svg>`;
const SVG_DELETE = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,4 14,4"/><path d="M5,4V3h6v1"/><path d="M3,4l1,9h8l1-9"/></svg>`;

// 編集ペンアイコン（16×16, 24×24 viewBox）
const SVG_EDIT_PEN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

// 文書アイコン
const SVG_DOCUMENT = `<svg class="item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

// チャット送信・停止アイコン（16×16）
const SVG_SEND = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="13" x2="8" y2="3"/><polyline points="4,7 8,3 12,7"/></svg>`;
const SVG_STOP = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>`;

// チャット履歴コピーアイコン（14×14）
const SVG_COPY = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>`;

// チャット履歴削除アイコン（14×14）
const SVG_TRASH = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,4 14,4"/><path d="M5,4V3h6v1"/><path d="M3,4l1,9h8l1-9"/></svg>`;

// 画像プレースホルダアイコン
const SVG_IMAGE_SM = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
const SVG_IMAGE_LG = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;

// ─── AppShell ─────────────────────────────────────────────

const AppShell = (() => {
  const TAB_MODULES = {
    edit: EditTab,
    source: SourceTab,
    material: MaterialTab,
    rule: RuleTab,
    settings: SettingsTab,
  };

  let _currentSseCtrl = null;
  let _currentScope = 'all';
  let _chatSelectionPreview = null; // チャット入力フォーカス前にキャプチャした選択テキスト

  function init() {
    // タブ切り替え
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => switchTab(item.dataset.tab));
    });

    // プロジェクト選択に戻る（トップバー内の btn-back）
    document.getElementById('btn-back').addEventListener('click', () => {
      // SSE 接続を切断
      if (typeof WatchSSEClient !== 'undefined') WatchSSEClient.disconnect();
      _resetAllTabs();
      UndoRedoManager.clear();
      _showScreen('project-selector');
      window.appState.setState({ project: null });
      ProjectSelector.init();
    });

    // オートコンプリートを先にアタッチ（Enterキーハンドラより先に登録して stopImmediatePropagation が効くようにする）
    AutocompletePopup.attachAll(['chat-input']);

    // チャット送信（Edit タブ）- 共通モジュールを使用
    ChatBarCommon.init('chat-input', 'btn-chat-send', 'edit', {
      onSend: _sendChat,
    });

    // バブルプロンプトからの送信
    document.addEventListener('bubble-prompt-send', (e) => {
      _sendChat(e.detail);
    });

    // バブルプロンプトのエラー通知
    document.addEventListener('bubble-prompt-error', (e) => {
      showToast(e.detail, 'error');
    });

    // チャット入力欄のリサイズハンドルを初期化
    if (window.initResizeHandle) {
      window.initResizeHandle('chat-resize-handle', 'chat-input');
    }

    // チャット入力欄にフォーカスする前にエディタ内選択テキストをキャプチャしてインジケーター表示
    const _chatInput = document.getElementById('chat-input');
    if (_chatInput) {
      _chatInput.addEventListener('mousedown', () => {
        const sel = window.getSelection();
        const anchor = sel?.anchorNode?.parentElement;
        const inEditor = anchor?.closest('#tiptap-editor-mount .ProseMirror, [data-field="content"], [data-field="summary"]');
        const txt = (inEditor && sel.toString().trim()) ? sel.toString().trim() : null;
        _chatSelectionPreview = txt;
        _updateChatSelectionBadge();
      });
      _chatInput.addEventListener('blur', () => {
        _chatSelectionPreview = null;
        _updateChatSelectionBadge();
      });
    }

    // グローバル設定を読み込んでCSS変数を反映
    ApiClient.get('/api/settings').then(s => {
      if (s.left_panel_width) {
        SettingsTab.applyLeftPanelWidth(s.left_panel_width);
      }
      if (s.history_panel_width) {
        SettingsTab.applyHistoryPanelWidth(s.history_panel_width);
      }
      if (s.outline_panel_width) {
        SettingsTab.applyOutlinePanelWidth(s.outline_panel_width);
      }
    }).catch(() => {});

    // 3カラムパネルリサイズを初期化
    _initPanelResizers();

    // 履歴パネルトグルボタン（トップバー）
    document.getElementById('btn-toggle-history')?.addEventListener('click', () => {
      _toggleHistoryPanel();
    });

    // Sourceパネル インポート/エクスポートボタン
    document.getElementById('btn-source-import')?.addEventListener('click', () => SourceTab.importCsv());
    document.getElementById('btn-source-export')?.addEventListener('click', () => SourceTab.exportCsv());

    // Ruleパネル インポート/エクスポートボタン
    document.getElementById('btn-rule-import')?.addEventListener('click', () => RuleTab.importCsv());
    document.getElementById('btn-rule-export')?.addEventListener('click', () => RuleTab.exportCsv());

    // パブリックなMarkdownエクスポートボタン
    document.getElementById('btn-export-md')?.addEventListener('click', async () => {
      const project = window.appState.getProject();
      if (!project) return;
      try {
        const mdText = await ApiClient.getText(`/api/projects/${project.id}/export`);
        const dialog = await ApiClient.saveFileDialog(`${project.name}.md`);
        if (!dialog || !dialog.path) return;
        const writeResult = await ApiClient.writeFile(dialog.path, mdText);
        if (writeResult.ok) {
          showToast('エクスポート完了', 'success');
        } else {
          showToast('ファイル保存に失敗しました', 'error');
        }
      } catch (e) {
        showToast('エクスポートに失敗しました', 'error');
      }
    });

    // チャットコピーボタンのイベントデリゲーション（SVG子要素クリック対応でclosestを使用）
    document.getElementById('chat-history-panel-messages')?.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.chat-copy-btn');
      if (copyBtn) {
        const text = copyBtn.dataset.copyText
          || copyBtn.closest('.chat-history-msg').querySelector('.chat-history-msg-content').textContent;
        const chatInput = document.getElementById('chat-input');
        if (chatInput) {
          chatInput.value = chatInput.value ? chatInput.value + '\n' + text : text;
          chatInput.dispatchEvent(new Event('input', { bubbles: true }));
          showToast('チャット入力に追加しました', 'success');
        }
      }
    });

    // チャット履歴削除ボタン
    document.getElementById('btn-clear-history')?.addEventListener('click', async () => {
      const project = window.appState.getProject();
      if (!project) return;
      const confirmed = await Modal.confirm('チャット履歴をすべて削除しますか？', { danger: true, confirmText: '削除' });
      if (!confirmed) return;
      try {
        await ApiClient.post(`/api/projects/${project.id}/chat-history/new-scope`);
        showToast('チャット履歴を削除しました', 'success');
        _refreshHistoryPanel();
      } catch (_) {
        showToast('履歴の削除に失敗しました', 'error');
      }
    });

    // 各タブのイベント
    EditTab.bindEvents();
    SourceTab.bindEvents();
    MaterialTab.bindEvents();
    RuleTab.bindEvents();
    SettingsTab.bindEvents();

    // ルール左パネルの新規追加ボタン
    document.getElementById('btn-add-rule-from-panel').addEventListener('click', () => {
      RuleTab.addRuleFromPanel();
    });

    // statechange 購読
    document.addEventListener('statechange', (e) => {
      const { project, activeTab } = e.detail;
      if (project) _refreshCurrentTab(activeTab, project);
    });

    // 初期画面
    _showScreen('project-selector');
    ProjectSelector.init();
  }

  function switchTab(tab) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-item[data-tab="${tab}"]`)?.classList.add('active');
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-${tab}`)?.classList.add('active');

    window.appState.setActiveTab(tab);
    const project = window.appState.getProject();
    if (project && TAB_MODULES[tab]) {
      TAB_MODULES[tab].render(project);
    }

    _renderTopBarActions(tab);

    // Editタブ以外では文字数表示・履歴トグルボタンを非表示
    const charCountEl = document.getElementById('char-count-display');
    if (charCountEl && tab !== 'edit') charCountEl.style.display = 'none';
    const historyToggleBtn = document.getElementById('btn-toggle-history');
    if (historyToggleBtn) {
      historyToggleBtn.style.display = tab === 'edit' ? '' : 'none';
      if (tab === 'edit') historyToggleBtn.classList.toggle('active', _historyPanelOpen);
    }
  }

  function _resetAllTabs() {
    window.appState.resetSelections();
    EditTab.reset();
    SourceTab.reset();
    MaterialTab.reset();
    RuleTab.reset();
  }

  function enterEditor(project) {
    _resetAllTabs();
    _currentScope = 'all';
    // プロジェクト切り替え時にアンドゥ/リドゥスタックをリセット（別プロジェクトの履歴が混入するバグ修正）
    UndoRedoManager.clear();
    // 前のプロジェクトの FileHandle をクリア
    if (typeof ProjectSelector !== 'undefined') ProjectSelector.clearOpenFileHandle();
    window.appState.setProject(project);
    document.getElementById('project-name-display').textContent = project.name || '';
    _showScreen('editor-screen');
    switchTab('edit');
    _refreshHistoryPanel();
    // ファイル監視開始 + SSE 接続
    if (typeof WatchSSEClient !== 'undefined') {
      ApiClient.post(`/api/projects/${project.id}/start-watching`).catch(() => {});
      WatchSSEClient.connect(project.id);
    }
    // 起動時ファイル同期（非同期、完了後 SSE 経由でタブが更新される）
    if (typeof WatchSSEClient !== 'undefined') {
      ApiClient.post(`/api/projects/${project.id}/sync-files`).catch(() => {});
    }
  }

  function setCurrentScope(scope) {
    _currentScope = scope;
  }

  function _showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    document.getElementById(screenId)?.classList.add('active');
  }

  function _refreshCurrentTab(tab, project) {
    if (TAB_MODULES[tab]) TAB_MODULES[tab].render(project);
  }

  // ─── トップバーアクションボタン ──────────────────────

  function _renderTopBarActions(tab) {
    const container = document.getElementById('top-bar-actions');
    container.innerHTML = '';
    const project = window.appState.getProject();

    const tabDefs = {
      edit: [],
      source: [],
      material: [],
      rule: [],
      settings: [],
    };

    (tabDefs[tab] || []).forEach(({ id, label, handler }) => {
      const btn = document.createElement('button');
      btn.className = 'btn-topbar-link btn-sm';
      btn.id = id;
      btn.textContent = label;
      btn.addEventListener('click', handler);
      container.appendChild(btn);
    });
  }

  // ─── チャット機能 ──────────────────────────────────────

  function _updateChatSelectionBadge() {
    const badge = document.getElementById('chat-selection-badge');
    if (!badge) return;
    if (_chatSelectionPreview) {
      const charCount = _chatSelectionPreview.replace(/\s/g, '').length;
      badge.textContent = '選択中: ' + charCount.toLocaleString() + ' 文字をコンテキストに含む';
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  async function _sendChat(parsed) {
    const project = window.appState.getProject();
    if (!project) return;
    if (_currentSseCtrl) _currentSseCtrl.abort();

    // 不明コマンドのエラー表示（コマンドパース済み）
    if (parsed.error) {
      showToast(parsed.error, 'error');
      return;
    }

    // 選択テキストをキャプチャ（バブルプロンプトからは事前キャプチャ済みの値を使う）
    const _preCapture = parsed._capturedSelectedText;
    delete parsed._capturedSelectedText;
    const _sel = window.getSelection();
    const _selAnchor = _sel?.anchorNode?.parentElement;
    const _isInEditor = _selAnchor?.closest('#tiptap-editor-mount .ProseMirror, [data-field="content"], [data-field="summary"]');
    const _selectedText = _preCapture !== undefined
      ? (_preCapture || null)
      : ((_isInEditor && _sel.toString().trim()) ? _sel.toString().trim() : null);

    // /clear コマンド: LLM を呼ばずに新スコープを作成して終了
    if (parsed.command && parsed.command.name === 'clear') {
      ChatBarCommon.clear('chat-input');
      const btn = document.getElementById('btn-chat-send');
      btn.disabled = true;
      try {
        await ApiClient.post(`/api/projects/${project.id}/chat-history/new-scope`);
        showToast('チャット履歴をクリアしました', 'success');
        _refreshHistoryPanel();
      } catch (error) {
        showToast('履歴のクリアに失敗しました', 'error');
      } finally {
        btn.disabled = false;
      }
      return;
    }

    // 破壊的操作の確認ダイアログ
    if (parsed.command && parsed.command.isDangerous) {
      const confirmed = await Modal.confirm(
        '既存のセクション構造をすべて削除して再生成します。よろしいですか？',
        { danger: true, confirmText: '実行' }
      );
      if (!confirmed) return;
    }

    ChatBarCommon.clear('chat-input');
    const btn = document.getElementById('btn-chat-send');

    // 送信時にチャット履歴パネルを自動オープン
    if (!_historyPanelOpen) {
      _historyPanelOpen = true;
      const sidePanel = document.getElementById('chat-history-side');
      if (sidePanel) sidePanel.classList.remove('collapsed');
      const topBtn = document.getElementById('btn-toggle-history');
      if (topBtn) topBtn.classList.add('active');
    }

    // /structure-section コマンドの場合、選択中のセクションを対象にする
    let contextScope = _currentScope;
    if (parsed.command && parsed.command.name === 'structure-section') {
      const selectedSectionId = window.appState.getSelectedSectionId();
      if (selectedSectionId) {
        contextScope = selectedSectionId;
      }
    }

    // 選択セクション情報を取得
    const _selectedSectionId = window.appState.getSelectedSectionId();
    const _selectedSectionTitle = (() => {
      if (!_selectedSectionId) return null;
      const proj = window.appState.getProject();
      if (!proj) return null;
      const sec = proj.sections.find(s => s.id === _selectedSectionId);
      return sec ? sec.title : null;
    })();

    // リクエストボディ構築
    const body = {
      context_scope: contextScope,
    };

    if (parsed.command) {
      body.user_message = parsed.freeText || `/${parsed.command.name}`.trim();
      body.command = parsed.command.name;
      body.command_args = [];
    } else {
      body.user_message = parsed.freeText || '';
    }

    if (parsed.refs.length > 0) {
      body.explicit_refs = parsed.refs.map(r => r.id);
      // ソース/マテリアル名を解決する
      const _proj = window.appState.getProject();
      body.ref_names = parsed.refs.map(r => {
        if (!_proj) return r.id;
        if (r.type === 'source') {
          const src = (_proj.sources || []).find(s => s.id === r.id);
          return src ? src.name : r.id;
        } else if (r.type === 'material') {
          const mat = (_proj.materials || []).find(m => m.id === r.id);
          return mat ? mat.name : r.id;
        }
        return r.id;
      });
    }

    if (_selectedText) {
      body.selected_text = _selectedText;
    }

    if (_selectedSectionId) {
      body.selected_section_id = _selectedSectionId;
      body.selected_section_title = _selectedSectionTitle;
    }

    // ユーザーメッセージ（またはコマンド）を履歴パネルに即時表示
    const userDisplayContent = parsed.command
      ? `/${parsed.command.name}${parsed.freeText ? ' ' + parsed.freeText : ''}`
      : body.user_message;
    _appendMessageToHistoryPanel({
      role: parsed.command ? 'command' : 'user',
      content: userDisplayContent,
      timestamp: new Date().toISOString(),
      selected_section_id: _selectedSectionId,
      selected_section_title: _selectedSectionTitle,
      explicit_refs: body.explicit_refs || [],
      ref_names: body.ref_names || [],
      prompt_text: userDisplayContent || null,
      command_name: parsed.command ? parsed.command.name : null,
    });

    // ローディングスピナーを表示
    _showHistoryPanelLoading();

    // 送信ボタンを「停止」ボタンに切り替え
    let _streamingAssistantEl = null; // ストリーミング中のアシスタントメッセージ要素

    function setStopMode() {
      btn.innerHTML = SVG_STOP;
      btn.title = '停止';
      btn.classList.add('btn-stop');
      btn.onclick = () => {
        if (_currentSseCtrl) {
          _currentSseCtrl.abort();
          _currentSseCtrl = null;
        }
        _restoreEditability();
        _hideHistoryPanelLoading();
        // ストリーミング中断時: 空のアシスタントメッセージを削除
        if (_streamingAssistantEl && !_streamingAssistantEl.querySelector('.chat-history-msg-content')?.textContent) {
          _streamingAssistantEl.remove();
        }
        resetSendMode();
      };
    }

    function resetSendMode() {
      btn.innerHTML = SVG_SEND;
      btn.title = '送信';
      btn.classList.remove('btn-stop');
      btn.onclick = null;
    }

    setStopMode();

    // コマンド実行時: Tiptapエディタをロックして編集を無効化
    if (parsed.command) {
      if (window.TiptapEditor) window.TiptapEditor.setEditable(false);
    }

    function _restoreEditability() {
      if (window.TiptapEditor) window.TiptapEditor.setEditable(true);
    }

    const isCommand = !!parsed.command;
    const _changeLog = [];
    const _commandLlmChunks = [];  // コマンド実行時のLLMテキストを蓄積

    function _buildCommandSummaryText(changeLog) {
      if (!changeLog || changeLog.length === 0) return '完了';
      const created = changeLog.filter(c => c.type === 'created');
      const updated = changeLog.filter(c => c.type === 'updated');
      const renamed = changeLog.filter(c => c.type === 'title_changed');
      const deleted = changeLog.filter(c => c.type === 'deleted');
      const parts = [];
      if (created.length) parts.push(`${created.length}件作成: ${created.slice(0, 3).map(c => `「${c.title}」`).join('、')}`);
      if (updated.length) parts.push(`${updated.length}件更新: ${[...new Set(updated.map(c => c.title))].slice(0, 3).map(t => `「${t}」`).join('、')}`);
      if (renamed.length) parts.push(`${renamed.length}件リネーム: ${renamed.slice(0, 2).map(c => `「${c.oldTitle}」→「${c.newTitle}」`).join('、')}`);
      if (deleted.length) parts.push(`${deleted.length}件削除`);
      return parts.join(' / ') || '完了';
    }

    _currentSseCtrl = ApiClient.openSSE(
      `/api/projects/${project.id}/chat`,
      body,
      {
        onChunk: (text) => {
          if (isCommand) {
            // コマンド時: テキストを蓄積するがリアルタイム表示はしない
            _commandLlmChunks.push(text);
            return;
          }
          if (!_streamingAssistantEl) {
            // 初回チャンク: アシスタントメッセージ要素を作成
            _streamingAssistantEl = _appendMessageToHistoryPanel({
              role: 'assistant',
              content: '',
              timestamp: new Date().toISOString(),
            });
          }
          const contentEl = _streamingAssistantEl.querySelector('.chat-history-msg-content');
          contentEl.textContent += text;
          const container = document.getElementById('chat-history-panel-messages');
          container.scrollTop = container.scrollHeight;
        },
        onReviewResult: (comments) => {
          // レビュー結果をカード形式で表示
          _streamingAssistantEl = _appendReviewResultToHistoryPanel(comments);
        },
        onToolCall: async (tool, args) => {
          await _applyToolCall(project, tool, args, _changeLog);
        },
        onDone: () => {
          _restoreEditability();
          _hideHistoryPanelLoading();
          resetSendMode();
          // LLM実行後にセクション選択を解除する
          if (window.EditTab && window.EditTab.clearSectionSelection) {
            window.EditTab.clearSectionSelection();
          }
          // コマンド実行: 要約をバックエンドに保存してからパネルをリフレッシュ
          const isReviewCommand = isCommand && parsed.command.name.startsWith('review');
          if (isCommand && !isReviewCommand) {
            const llmText = _commandLlmChunks.join('').trim();
            const summaryText = llmText || _buildCommandSummaryText(_changeLog);
            _addSummaryToHistory(project, summaryText)
              .then(() => _refreshHistoryPanel());
          } else {
            // 通常チャットとreviewコマンド: バックエンドに保存済みなのでパネルをリフレッシュ
            _refreshHistoryPanel();
          }
        },
        onError: (msg) => {
          _restoreEditability();
          _hideHistoryPanelLoading();
          resetSendMode();
          showToast(`チャットエラー: ${msg}`, 'error');
        },
      }
    );
  }

  /**
   * sections配列のorderを親ごとに0から振り直す
   * LLMがorderを間違えても自動的に修正するための安全策
   */
  function fixSectionOrder(sections) {
    const groups = {};  // parent_key → sections 配列

    // parent_key ごとにグループ化（parent_keyがない場合はルートとしてnullに統一）
    for (const sec of sections) {
      const parent = sec.parent_key ?? null;
      if (!groups[parent]) {
        groups[parent] = [];
      }
      groups[parent].push(sec);
    }

    // 各グループ内で元のorderに従ってソートし、0から振り直す
    const fixed = [];
    for (const parentKey in groups) {
      const group = groups[parentKey];
      group.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      for (let i = 0; i < group.length; i++) {
        fixed.push({ ...group[i], order: i });
      }
    }
    return fixed;
  }

  /**
   * project.contentをバックエンドから再取得してローカルを更新し、EditTabを再描画する
   */
  async function _refreshProjectContent(project) {
    try {
      const result = await ApiClient.get(`/api/projects/${project.id}/content`);
      project.content = result.content;
    } catch (_) { }
    EditTab.render(project);
  }

  async function _applyToolCall(project, tool, args, changeLog = null) {
    try {
      if (tool === 'update_section') {
        const { section_id, content } = args;
        const sec = project.sections.find(s => s.id === section_id);
        if (!sec) return;

        if (changeLog) changeLog.push({ type: 'updated', title: sec.title });

        // 新アーキテクチャ: PATCH /content/sections/{id} でproject.content内の本文を更新
        const result = await ApiClient.patch(
          `/api/projects/${project.id}/content/sections/${section_id}`,
          { content }
        );
        project.content = result.content;
        if (window.TiptapEditor) window.TiptapEditor.setContentFromMarkdown(project.content);

      } else if (tool === 'update_multiple_sections') {
        const { updates } = args;
        for (const update of updates) {
          const { section_id, content } = update;
          const sec = project.sections.find(s => s.id === section_id);
          if (!sec) continue;

          if (changeLog) changeLog.push({ type: 'updated', title: sec.title });
          const result = await ApiClient.patch(
            `/api/projects/${project.id}/content/sections/${section_id}`,
            { content }
          );
          project.content = result.content;
        }
        // 全更新後に一度だけTiptapを更新
        if (window.TiptapEditor) window.TiptapEditor.setContentFromMarkdown(project.content);

      } else if (tool === 'create_section') {
        const { title, summary = '', parent_id = null } = args;
        const sec = await ApiClient.post(`/api/projects/${project.id}/sections`, {
          title, summary, parent_id,
        });
        project.sections.push(sec);
        if (changeLog) changeLog.push({ type: 'created', title: sec.title });
        // バックエンドがproject.contentにスケルトンを追記するため再取得
        await _refreshProjectContent(project);

        UndoRedoManager.push({
          do: async () => { },
          undo: async () => {
            await ApiClient.delete(`/api/projects/${project.id}/sections/${sec.id}`);
            project.sections = project.sections.filter(s => s.id !== sec.id);
            await _refreshProjectContent(project);
          },
        });

      } else if (tool === 'update_section_summary') {
        const { section_id, summary } = args;
        const sec = project.sections.find(s => s.id === section_id);
        if (!sec) return;
        await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { summary });
        sec.summary = summary;
        // summaryはTiptap内に表示しないため、DOM更新不要

      } else if (tool === 'delete_section') {
        const { section_id } = args;
        const secToDelete = project.sections.find(s => s.id === section_id);
        if (changeLog && secToDelete) changeLog.push({ type: 'deleted', title: secToDelete.title });
        await ApiClient.delete(`/api/projects/${project.id}/sections/${section_id}`);
        project.sections = project.sections.filter(s => s.id !== section_id);
        // バックエンドがproject.contentからブロックを除去するため再取得
        await _refreshProjectContent(project);

      } else if (tool === 'update_section_title') {
        const { section_id, title } = args;
        const sec = project.sections.find(s => s.id === section_id);
        if (!sec) return;
        const oldTitle = sec.title;
        if (changeLog) changeLog.push({ type: 'title_changed', oldTitle, newTitle: title });
        await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { title });
        sec.title = title;
        // バックエンドがproject.content内の見出しタイトルを更新するため再取得
        await _refreshProjectContent(project);

        UndoRedoManager.push({
          do: async () => {
            await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { title });
            sec.title = title;
            await _refreshProjectContent(project);
          },
          undo: async () => {
            await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { title: oldTitle });
            sec.title = oldTitle;
            await _refreshProjectContent(project);
          },
        });

      } else if (tool === 'move_section') {
        const { section_id, parent_id = null, order } = args;
        const sec = project.sections.find(s => s.id === section_id);
        if (!sec) return;
        const oldParentId = sec.parent_id;
        const oldOrder = sec.order;
        await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { parent_id, order });
        sec.parent_id = parent_id;
        sec.order = order;
        EditTab.render(project);

        UndoRedoManager.push({
          do: async () => {
            await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { parent_id, order });
            sec.parent_id = parent_id;
            sec.order = order;
            EditTab.render(project);
          },
          undo: async () => {
            await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { parent_id: oldParentId, order: oldOrder });
            sec.parent_id = oldParentId;
            sec.order = oldOrder;
            EditTab.render(project);
          },
        });

      } else if (tool === 'create_sections_under_parent') {
        const { parent_section_id = null, sections: newSections } = args;
        const fixedSections = fixSectionOrder(newSections);

        // 既存の子セクションのmaxOrderを取得
        const existingChildren = project.sections.filter(s => s.parent_id === parent_section_id);
        const baseOrder = existingChildren.length > 0
          ? Math.max(...existingChildren.map(s => s.order ?? 0)) + 1
          : 0;

        // key → 実際の section_id のマッピング
        const keyToId = {};

        // 階層順にソート（親を先に作成）
        const sorted = [...fixedSections].sort((a, b) => {
          const aLevel = a.parent_key ? a.parent_key.split('-').length : 0;
          const bLevel = b.parent_key ? b.parent_key.split('-').length : 0;
          if (aLevel !== bLevel) return aLevel - bLevel;
          return (a.order ?? 0) - (b.order ?? 0);
        });

        for (const item of sorted) {
          let resolvedParentId;
          if (item.parent_key) {
            resolvedParentId = keyToId[item.parent_key] ?? parent_section_id;
          } else {
            resolvedParentId = parent_section_id;
          }

          const created = await ApiClient.post(`/api/projects/${project.id}/sections`, {
            title: item.title,
            summary: item.summary ?? '',
            parent_id: resolvedParentId,
            order: item.parent_key ? (item.order ?? 0) : (baseOrder + (item.order ?? 0)),
          });
          keyToId[item.key] = created.id;
          project.sections.push(created);
          if (changeLog) changeLog.push({ type: 'created', title: created.title });
        }

        // バックエンドがproject.contentにスケルトンを追記するため再取得
        await _refreshProjectContent(project);

      } else if (tool === 'set_document_structure' || tool === 'create_document_structure') {
        const { sections: newSections } = args;
        const isReplace = tool === 'set_document_structure';

        // LLMがorderを間違えても自動修正（親ごとに0から振り直す）
        const fixedSections = fixSectionOrder(newSections);

        if (isReplace) {
          // 削除前にスナップショットを取得してログに記録
          if (changeLog) {
            for (const sec of project.sections) {
              changeLog.push({ type: 'deleted', title: sec.title });
            }
          }
          for (const sec of [...project.sections]) {
            await ApiClient.delete(`/api/projects/${project.id}/sections/${sec.id}`);
          }
          project.sections = [];
        }

        // key → 実際の section_id のマッピング（親参照解決に使用）
        const keyToId = {};

        // 階層順にソート：ルートから下位へ（親を先に作成するため）
        // key のハイフンの数で階層レベルを判定し、同レベル内では order でソート
        const sorted = [...fixedSections].sort((a, b) => {
          const aLevel = a.parent_key ? a.parent_key.split('-').length : 0;
          const bLevel = b.parent_key ? b.parent_key.split('-').length : 0;
          if (aLevel !== bLevel) return aLevel - bLevel;
          return (a.order ?? 0) - (b.order ?? 0);
        });

        for (const item of sorted) {
          const parentId = item.parent_key ? (keyToId[item.parent_key] ?? null) : null;
          const created = await ApiClient.post(`/api/projects/${project.id}/sections`, {
            title: item.title,
            summary: item.summary ?? '',
            parent_id: parentId,
            order: item.order ?? 0,
          });
          keyToId[item.key] = created.id;
          project.sections.push(created);
          if (changeLog) changeLog.push({ type: 'created', title: created.title });
        }

        // バックエンドがproject.contentを構築するため再取得
        await _refreshProjectContent(project);
      }
    } catch (e) {
      showToast(`ツールコール適用エラー: ${e.message}`, 'error');
    }
  }

  // ─── 3カラムパネルリサイズ ─────────────────────

  /**
   * アウトライン ↔ エディタ、エディタ ↔ チャット履歴のドラッグリサイズを初期化する
   */
  function _initPanelResizers() {
    const style = getComputedStyle(document.documentElement);
    const pxVal = (v) => parseInt(style.getPropertyValue(v)) || undefined;

    // アウトライン ↔ エディタ境界
    _setupHorizResizer(
      document.getElementById('outline-resizer'),
      document.getElementById('outline-panel'),
      'right',
      pxVal('--outline-panel-min-w'), pxVal('--outline-panel-max-w'),
      false,
      (px) => {
        SettingsTab.applyOutlinePanelWidth(px);
        ApiClient.patch('/api/settings', { outline_panel_width: px }).catch(() => {});
      }
    );

    // エディタ ↔ チャット履歴境界（ドラッグでリサイズ）
    _setupHorizResizer(
      document.getElementById('history-resizer'),
      document.getElementById('chat-history-side'),
      'left',
      pxVal('--history-panel-min-w'), pxVal('--history-panel-max-w'),
      (px) => {
        SettingsTab.applyHistoryPanelWidth(px);
        ApiClient.patch('/api/settings', { history_panel_width: px }).catch(() => {});
      }
    );

    const saveLeftPanelWidth = (px) => {
      SettingsTab.applyLeftPanelWidth(px);
      ApiClient.patch('/api/settings', { left_panel_width: px }).catch(() => {});
    };

    // Source タブ左パネル
    _setupHorizResizer(
      document.getElementById('source-resizer'),
      document.getElementById('source-panel'),
      'right',
      pxVal('--left-panel-min-w'), pxVal('--left-panel-max-w'),
      false, saveLeftPanelWidth
    );

    // Material タブ左パネル
    _setupHorizResizer(
      document.getElementById('material-resizer'),
      document.getElementById('material-panel'),
      'right',
      pxVal('--left-panel-min-w'), pxVal('--left-panel-max-w'),
      false, saveLeftPanelWidth
    );

    // Rule タブ左パネル
    _setupHorizResizer(
      document.getElementById('rule-resizer'),
      document.getElementById('rule-panel'),
      'right',
      pxVal('--left-panel-min-w'), pxVal('--left-panel-max-w'),
      false, saveLeftPanelWidth
    );
  }

  /**
   * 水平リサイザーをセットアップする
   * @param {HTMLElement} resizer - ドラッグハンドル要素
   * @param {HTMLElement} panel - リサイズ対象パネル
   * @param {'right'|'left'} side - どちら側のパネルか
   * @param {number} minW - 最小幅
   * @param {number} maxW - 最大幅
   * @param {boolean} isHistory - チャット履歴パネル（折りたたみ対応）
   * @param {function(number):void} [onSaveWidth] - ドラッグ完了時に幅(px)を受け取るコールバック
   */
  function _setupHorizResizer(resizer, panel, side, minW, maxW, onSaveWidth = null) {
    if (!resizer || !panel) return;

    let startX = 0;
    let startW = 0;
    let isDragging = false;
    let clickThreshold = 5; // ドラッグと判定するピクセル数

    resizer.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      isDragging = false;

      const onMove = (e) => {
        const dx = e.clientX - startX;
        if (!isDragging && Math.abs(dx) > clickThreshold) {
          isDragging = true;
          resizer.classList.add('dragging');
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'col-resize';
        }
        if (!isDragging) return;

        let newW;
        if (side === 'right') {
          newW = startW + dx;
        } else {
          newW = startW - dx;
        }
        newW = Math.max(minW, Math.min(maxW, newW));

        panel.style.width = newW + 'px';
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        resizer.classList.remove('dragging');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';

        // ドラッグ完了時に幅を保存
        if (isDragging && onSaveWidth) {
          onSaveWidth(parseInt(panel.style.width, 10));
        }

      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  // ─── チャット履歴右パネル ─────────────────────

  let _historyPanelOpen = true;

  /**
   * メッセージのメタ情報HTML（セクション・ソース・プロンプト）を生成する
   */
  function _buildMsgMetaHtml(msg) {
    const parts = [];
    if (msg.selected_section_title) {
      parts.push(`<span class="chat-history-msg-meta-item">📄 ${escHtml(msg.selected_section_title)}</span>`);
    } else if (msg.selected_section_id) {
      parts.push(`<span class="chat-history-msg-meta-item">📄 ${escHtml(msg.selected_section_id)}</span>`);
    }
    const refs = msg.ref_names || msg.explicit_refs || [];
    if (refs.length > 0) {
      parts.push(`<span class="chat-history-msg-meta-item">🔗 ${refs.map(n => escHtml(n)).join('、')}</span>`);
    }
    if (parts.length === 0) return '';
    return `<div class="chat-history-msg-meta">${parts.join('')}</div>`;
  }

  /**
   * 履歴パネルにメッセージ要素を直接追加して DOM 要素を返す
   * @param {{role: string, content: string, timestamp: string}} msg
   * @returns {HTMLElement} 追加されたメッセージ要素
   */
  function _appendMessageToHistoryPanel(msg) {
    const container = document.getElementById('chat-history-panel-messages');
    // プレースホルダーを削除
    const placeholder = container.querySelector('.chat-history-placeholder');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = `chat-history-msg ${msg.role}`;
    div.innerHTML = _buildHistoryMsgHtml(msg);

    // ローディングスピナーがあればその前に挿入、なければ末尾に追加
    const loadingEl = container.querySelector('.chat-history-loading');
    if (loadingEl) {
      container.insertBefore(div, loadingEl);
    } else {
      container.appendChild(div);
    }
    container.scrollTop = container.scrollHeight;
    return div;
  }

  /**
   * レビュー結果コメント配列を履歴パネルにカード形式で追加する
   * @param {Array<{section: string, problem: string, suggestion: string}>} comments
   * @returns {HTMLElement} 追加されたメッセージ要素
   */
  function _appendReviewResultToHistoryPanel(comments) {
    const container = document.getElementById('chat-history-panel-messages');
    const placeholder = container.querySelector('.chat-history-placeholder');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = 'chat-history-msg assistant';
    div.innerHTML = _buildReviewResultHtml(comments);

    const loadingEl = container.querySelector('.chat-history-loading');
    if (loadingEl) {
      container.insertBefore(div, loadingEl);
    } else {
      container.appendChild(div);
    }
    container.scrollTop = container.scrollHeight;
    return div;
  }

  /**
   * レビュー結果HTMLを生成する
   * @param {Array<{section: string, problem: string, suggestion: string}>} comments
   * @param {string} [timeStr] - 表示用タイムスタンプ文字列（省略時は現在時刻）
   */
  function _buildReviewResultHtml(comments, timeStr) {
    if (!timeStr) timeStr = new Date().toLocaleString('ja-JP');
    const headerHtml = `
      <div class="chat-history-msg-header">
        <div class="chat-history-msg-role assistant"><span>🤖 AI</span></div>
      </div>
      <div class="chat-history-msg-label">レビュー結果</div>
    `;

    if (!comments || comments.length === 0) {
      return headerHtml + `
        <div class="review-result-empty">問題点は見つかりませんでした。</div>
        <div class="chat-history-msg-time">${timeStr}</div>
      `;
    }

    const cardsHtml = comments.map((c) => {
      const copyText = [
        c.section ? `【${c.section}】` : '',
        c.problem ? `問題点: ${c.problem}` : '',
        c.suggestion ? `改善案: ${c.suggestion}` : '',
      ].filter(Boolean).join('\n');

      return `
        <div class="review-comment-card">
          <div class="review-comment-card-header">
            ${c.section ? `<span class="review-comment-section">${escHtml(c.section)}</span>` : ''}
            <button class="btn-icon chat-copy-btn review-copy-btn" title="プロンプト入力にコピー" data-copy-text="${escHtml(copyText)}">${SVG_COPY} <span>プロンプトにコピー</span></button>
          </div>
          ${c.problem ? `<div class="review-comment-problem"><span class="review-comment-label">問題点</span>${escHtml(c.problem)}</div>` : ''}
          ${c.suggestion ? `<div class="review-comment-suggestion"><span class="review-comment-label">改善案</span>${escHtml(c.suggestion)}</div>` : ''}
        </div>
      `;
    }).join('');

    return headerHtml + `
      <div class="review-result-list">${cardsHtml}</div>
      <div class="chat-history-msg-time">${timeStr}</div>
    `;
  }

  /**
   * メッセージオブジェクトからHTML文字列を生成する
   */
  function _buildHistoryMsgHtml(msg) {
    const copyText = msg.prompt_text || msg.content || '';
    const copyBtn = `<button class="btn-icon chat-copy-btn" title="チャット入力にコピー" data-copy-text="${escHtml(copyText)}">${SVG_COPY}</button>`;
    const timeStr = new Date(msg.timestamp).toLocaleString('ja-JP');
    const metaHtml = _buildMsgMetaHtml(msg);

    if (msg.role === 'command') {
      return `
        <div class="chat-history-msg-header">
          <div class="chat-history-msg-role command"><span>⚡ コマンド</span></div>
          ${copyBtn}
        </div>
        <div class="chat-history-msg-content">${escHtml(msg.content)}</div>
        ${metaHtml}
        <div class="chat-history-msg-time">${timeStr}</div>
      `;
    } else if (msg.role === 'user') {
      return `
        <div class="chat-history-msg-header">
          <div class="chat-history-msg-role user"><span>👤 あなた</span></div>
          ${copyBtn}
        </div>
        <div class="chat-history-msg-content">${escHtml(msg.content)}</div>
        ${metaHtml}
        <div class="chat-history-msg-time">${timeStr}</div>
      `;
    } else {
      // レビュー結果コメントがある場合はカード形式で表示
      if (msg.review_comments && msg.review_comments.length > 0) {
        return _buildReviewResultHtml(msg.review_comments, timeStr);
      }
      return `
        <div class="chat-history-msg-header">
          <div class="chat-history-msg-role assistant"><span>🤖 AI</span></div>
          ${copyBtn}
        </div>
        <div class="chat-history-msg-content">${escHtml(msg.content)}</div>
        <div class="chat-history-msg-time">${timeStr}</div>
      `;
    }
  }

  /** 履歴パネルのローディングスピナーを表示する */
  function _showHistoryPanelLoading() {
    const container = document.getElementById('chat-history-panel-messages');
    if (container.querySelector('.chat-history-loading')) return;
    const el = document.createElement('div');
    el.className = 'chat-history-loading';
    el.innerHTML = '<span class="section-spinner"></span>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  /** 履歴パネルのローディングスピナーを非表示にする */
  function _hideHistoryPanelLoading() {
    const container = document.getElementById('chat-history-panel-messages');
    container.querySelector('.chat-history-loading')?.remove();
  }

  /**
   * コマンド実行後の要約メッセージをチャット履歴に追加する
   * @param {object} project
   * @param {string} summaryText - 追加するメッセージ
   */
  async function _addSummaryToHistory(project, summaryText) {
    try {
      await ApiClient.post(`/api/projects/${project.id}/chat-history/add-message`, {
        scope: 'all',
        role: 'assistant',
        content: summaryText,
      });
    } catch (_) { }
  }

  async function _toggleHistoryPanel() {
    const sidePanel = document.getElementById('chat-history-side');
    const project = window.appState.getProject();
    if (!project) return;

    _historyPanelOpen = !_historyPanelOpen;
    const topBtn = document.getElementById('btn-toggle-history');
    if (_historyPanelOpen) {
      sidePanel.classList.remove('collapsed');
      if (topBtn) topBtn.classList.add('active');
      // ストリーミング中でなければ最新履歴を取得して描画
      if (!_currentSseCtrl) {
        await _refreshHistoryPanel();
      }
    } else {
      sidePanel.classList.add('collapsed');
      if (topBtn) topBtn.classList.remove('active');
    }
  }

  async function _refreshHistoryPanel() {
    const project = window.appState.getProject();
    if (!project) return;

    try {
      const msgs = await ApiClient.get(`/api/projects/${project.id}/chat-history`);
      const tabsEl = document.getElementById('chat-history-panel-tabs');
      if (tabsEl) Object.assign(tabsEl.style, { display: 'none' });

      _renderHistoryMessages(msgs);
    } catch (e) {
      document.getElementById('chat-history-panel-messages').innerHTML =
        '<p class="chat-history-placeholder">履歴の取得に失敗しました</p>';
    }
  }

  function _renderHistoryMessages(msgs) {
    const container = document.getElementById('chat-history-panel-messages');

    if (!msgs || msgs.length === 0) {
      container.innerHTML = '<p class="chat-history-placeholder">メッセージがありません</p>';
      return;
    }

    container.innerHTML = '';
    msgs.forEach(msg => {
      const div = document.createElement('div');
      div.className = `chat-history-msg ${msg.role}`;
      div.innerHTML = _buildHistoryMsgHtml(msg);
      container.appendChild(div);
    });

    container.scrollTop = container.scrollHeight;
  }

  return { init, switchTab, enterEditor, setCurrentScope };
})();

// ─── エントリーポイント ──────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  AppShell.init();
});
