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
const SVG_CHEVRON_DOWN  = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 8,11 13,6"/></svg>`;

// セクショントグル（14×14）
const SVG_TOGGLE_RIGHT = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,3 11,8 6,13"/></svg>`;
const SVG_TOGGLE_DOWN  = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 8,11 13,6"/></svg>`;

// セクション操作アイコン（14×14）
const SVG_ADD_CHILD = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg>`;
const SVG_ARROW_UP  = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,10 8,5 13,10"/></svg>`;
const SVG_ARROW_DOWN = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 8,11 13,6"/></svg>`;
const SVG_EDIT      = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-8 8H3v-3l8-8z"/></svg>`;
const SVG_DELETE    = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,4 14,4"/><path d="M5,4V3h6v1"/><path d="M3,4l1,9h8l1-9"/></svg>`;

// 編集ペンアイコン（16×16, 24×24 viewBox）
const SVG_EDIT_PEN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

// 文書アイコン
const SVG_DOCUMENT = `<svg class="item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

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
    review: ReviewTab,
    settings: SettingsTab,
  };

  let _currentSseCtrl = null;
  let _currentScope = 'all';

  function init() {
    // タブ切り替え
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => switchTab(item.dataset.tab));
    });

    // プロジェクト選択に戻る（トップバー内の btn-back）
    document.getElementById('btn-back').addEventListener('click', () => {
      _resetAllTabs();
      _showScreen('project-selector');
      window.appState.setState({ project: null });
      ProjectSelector.init();
    });

    // チャット送信（Edit タブ）- 共通モジュールを使用
    ChatBarCommon.init('chat-input', 'btn-chat-send', 'edit', {
      onSend: _sendChat,
    });

    // チャット入力欄とレビュー入力欄のリサイズハンドルを初期化
    if (window.initResizeHandle) {
      window.initResizeHandle('chat-resize-handle', 'chat-input');
      window.initResizeHandle('review-resize-handle', 'review-prompt');
    }

    // チャット履歴
    document.getElementById('btn-chat-history').addEventListener('click', _showChatHistory);
    document.getElementById('btn-close-history').addEventListener('click', () => {
      document.getElementById('modal-chat-history').style.display = 'none';
    });

    // 各タブのイベント
    EditTab.bindEvents();
    SourceTab.bindEvents();
    MaterialTab.bindEvents();
    RuleTab.bindEvents();
    ReviewTab.bindEvents();
    SettingsTab.bindEvents();

    // ルール左パネルの新規追加ボタン
    document.getElementById('btn-add-rule-from-panel').addEventListener('click', () => {
      RuleTab.addRuleFromPanel();
    });

    // @ オートコンプリートポップアップの初期化
    AutocompletePopup.attachAll(['chat-input', 'review-prompt']);

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
  }

  function _resetAllTabs() {
    window.appState.resetSelections();
    EditTab.reset();
    SourceTab.reset();
    MaterialTab.reset();
    RuleTab.reset();
    ReviewTab.reset();
  }

  function enterEditor(project) {
    _resetAllTabs();
    _currentScope = 'all';
    window.appState.setProject(project);
    document.getElementById('project-name-display').textContent = project.name || '';
    _showScreen('editor-screen');
    switchTab('edit');
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
      source: [
        { id: 'btn-source-import-top', label: 'インポート', handler: () => SourceTab.importCsv() },
        { id: 'btn-source-export-top', label: 'エクスポート', handler: () => SourceTab.exportCsv() },
      ],
      material: [],
      rule: [
        { id: 'btn-rule-import-top', label: 'インポート', handler: () => RuleTab.importCsv() },
        { id: 'btn-rule-export-top', label: 'エクスポート', handler: () => RuleTab.exportCsv() },
      ],
      review: [
        { id: 'btn-export-top', label: 'エクスポート', handler: async () => {
          if (!project) return;
          try {
            const res = await fetch(`/api/projects/${project.id}/export`);
            if (!res.ok) { showToast('エクスポートに失敗しました', 'error'); return; }
            const mdText = await res.text();
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
        }},
      ],
      settings: [],
    };

    (tabDefs[tab] || []).forEach(({ id, label, handler }) => {
      const btn = document.createElement('button');
      btn.className = 'btn-topbar-link';
      btn.id = id;
      btn.textContent = label;
      btn.addEventListener('click', handler);
      container.appendChild(btn);
    });
  }

  // ─── チャット機能 ──────────────────────────────────────

  async function _sendChat(parsed) {
    const project = window.appState.getProject();
    if (!project) return;
    if (_currentSseCtrl) _currentSseCtrl.abort();

    // 不明コマンドのエラー表示（コマンドパース済み）
    if (parsed.error) {
      showToast(parsed.error, 'error');
      return;
    }

    // /clear コマンド: LLM を呼ばずに新スコープを作成して終了
    if (parsed.command && parsed.command.name === 'clear') {
      ChatBarCommon.clear('chat-input');
      const btn = document.getElementById('btn-chat-send');
      btn.disabled = true;
      try {
        const result = await ApiClient.post(
          `/api/projects/${project.id}/chat-history/new-scope`
        );
        _currentScope = result.new_scope;
        showToast(`新しいスコープ「${result.new_scope}」を作成しました`, 'success');
      } catch (error) {
        showToast('スコープの作成に失敗しました', 'error');
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
    btn.disabled = true;

    // /structure-section コマンドの場合、選択中のセクションを対象にする
    let contextScope = _currentScope;
    if (parsed.command && parsed.command.name === 'structure-section') {
      const selectedSectionId = window.appState.getSelectedSectionId();
      if (selectedSectionId) {
        contextScope = selectedSectionId;
      }
    }

    // リクエストボディ構築
    const body = {
      context_scope: contextScope,
    };

    if (parsed.command) {
      // コマンドモード: ユーザーメッセージにフリーテキスト（追加指示）を渡す
      // 引数は廃止されたので、command_args は常に空配列
      body.user_message = parsed.freeText || `/${parsed.command.name}`.trim();
      body.command = parsed.command.name;
      body.command_args = []; // 引数は廃止
    } else {
      // 通常チャットモード
      body.user_message = parsed.freeText || '';
    }

    // @参照がある場合はIDリストを追加
    if (parsed.refs.length > 0) {
      body.explicit_refs = parsed.refs.map(r => r.id);
    }

    // チャット応答表示用コンテナ（チャットバー上部に追加）
    const chatBar = document.getElementById('chat-bar');
    const responseEl = document.createElement('div');
    responseEl.className = 'llm-response-area';
    chatBar.insertBefore(responseEl, chatBar.firstChild);

    // LLM実行中のスピナー表示
    let isStreaming = false;
    let isHovering = false;
    let hoverTimer = null;

    function startLoading() {
      responseEl.innerHTML = '<div class="pdf-analysis-spinner"></div>';
    }

    function stopLoading() {
      if (isStreaming) {
        // ストリーミング中はスピナーを削除して文字を表示
        responseEl.innerHTML = '';
      } else {
        // ツール実行完了など
        responseEl.textContent = '完了!';
      }
    }

    function scheduleAutoClose() {
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (!isHovering && !isStreaming) {
          responseEl.remove();
        }
      }, 3000); // カーソルが外れて3秒後に閉じる
    }

    function clearAutoClose() {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    }

    // マウスイベントで自動クローズを制御
    responseEl.addEventListener('mouseenter', () => {
      isHovering = true;
      clearAutoClose();
    });

    responseEl.addEventListener('mouseleave', () => {
      isHovering = false;
      if (!isStreaming) {
        scheduleAutoClose();
      }
    });

    // アニメーション開始
    startLoading();

    _currentSseCtrl = ApiClient.openSSE(
      `/api/projects/${project.id}/chat`,
      body,
      {
        onChunk: (text) => {
          if (!isStreaming) {
            // 初回のみスピナーを消去
            responseEl.innerHTML = '';
            isStreaming = true;
          }
          responseEl.textContent += text;
          // ストリーム中は常に最下部へスクロール
          responseEl.scrollTop = responseEl.scrollHeight;
        },
        onToolCall: async (tool, args) => {
          isStreaming = false;
          stopLoading();
          await _applyToolCall(project, tool, args);
        },
        onDone: () => {
          isStreaming = false;
          if (responseEl.textContent.trim() === '' || responseEl.textContent === '完了!') {
            // テキストがない場合は「完了!」表示
            stopLoading();
          }
          btn.disabled = false;
          // ホバーしていない場合は自動クローズをスケジュール
          if (!isHovering) {
            scheduleAutoClose();
          }
        },
        onError: (msg) => {
          isStreaming = false;
          stopLoading();
          btn.disabled = false;
          showToast(`チャットエラー: ${msg}`, 'error');
          responseEl.remove();
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

  async function _applyToolCall(project, tool, args) {
    try {
      if (tool === 'update_section') {
        const { section_id, content } = args;
        const sec = project.sections.find(s => s.id === section_id);
        if (!sec) return;

        const oldContent = sec.content;
        await ApiClient.put(
          `/api/projects/${project.id}/sections/${section_id}`,
          { content }
        );
        sec.content = content;

        const contentEl = document.querySelector(`[data-sec-id="${section_id}"][data-field="content"]`);
        if (contentEl) contentEl.innerText = content;

        UndoRedoManager.push({
          do: async () => {
            await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { content });
            sec.content = content;
            if (contentEl) contentEl.innerText = content;
          },
          undo: async () => {
            await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { content: oldContent });
            sec.content = oldContent;
            if (contentEl) contentEl.innerText = oldContent;
          },
        });

      } else if (tool === 'create_section') {
        const { title, summary = '', content = '', parent_id = null } = args;
        const sec = await ApiClient.post(`/api/projects/${project.id}/sections`, {
          title, summary, content, parent_id,
        });
        project.sections.push(sec);
        EditTab.render(project);

        UndoRedoManager.push({
          do: async () => {},
          undo: async () => {
            await ApiClient.delete(`/api/projects/${project.id}/sections/${sec.id}`);
            project.sections = project.sections.filter(s => s.id !== sec.id);
            EditTab.render(project);
          },
        });

      } else if (tool === 'update_section_summary') {
        const { section_id, summary } = args;
        const sec = project.sections.find(s => s.id === section_id);
        if (!sec) return;
        await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { summary });
        sec.summary = summary;
        const summaryEl = document.querySelector(`[data-sec-id="${section_id}"][data-field="summary"]`);
        if (summaryEl) summaryEl.innerText = summary;

      } else if (tool === 'delete_section') {
        const { section_id } = args;
        await ApiClient.delete(`/api/projects/${project.id}/sections/${section_id}`);
        project.sections = project.sections.filter(s => s.id !== section_id);
        EditTab.render(project);

      } else if (tool === 'update_section_title') {
        const { section_id, title } = args;
        const sec = project.sections.find(s => s.id === section_id);
        if (!sec) return;
        const oldTitle = sec.title;
        await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { title });
        sec.title = title;
        EditTab.render(project);

        UndoRedoManager.push({
          do: async () => {
            await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { title });
            sec.title = title;
            EditTab.render(project);
          },
          undo: async () => {
            await ApiClient.put(`/api/projects/${project.id}/sections/${section_id}`, { title: oldTitle });
            sec.title = oldTitle;
            EditTab.render(project);
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

      } else if (tool === 'set_document_structure' || tool === 'create_document_structure') {
        const { sections: newSections } = args;
        const isReplace = tool === 'set_document_structure';

        // LLMがorderを間違えても自動修正（親ごとに0から振り直す）
        const fixedSections = fixSectionOrder(newSections);

        if (isReplace) {
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
            content: '',
            parent_id: parentId,
            order: item.order ?? 0,
          });
          keyToId[item.key] = created.id;
          project.sections.push(created);
        }

        EditTab.render(project);
      }
    } catch (e) {
      showToast(`ツールコール適用エラー: ${e.message}`, 'error');
    }
  }

  // ─── チャット履歴 ─────────────────────────────────────

  let _selectedHistoryScope = null;  // 履歴モーダルで選択中のスコープ

  async function _showChatHistory() {
    const project = window.appState.getProject();
    if (!project) return;

    const allScopes = await ApiClient.get(
      `/api/projects/${project.id}/chat-history/all-scopes`
    );

    const scopesList = document.getElementById('chat-history-scopes-list');
    const messagesList = document.getElementById('chat-history-messages-list');

    // 左ペイン: スコープ一覧を描画
    _renderScopeList(scopesList, allScopes);

    // 右ペイン: 初期状態を設定
    messagesList.innerHTML = '<p class="chat-history-placeholder">左ペインからスコープを選択してください</p>';

    document.getElementById('modal-chat-history').style.display = 'flex';
  }

  function _renderScopeList(container, allScopes) {
    container.innerHTML = '';

    const scopeKeys = Object.keys(allScopes);
    if (!scopeKeys.length) {
      container.innerHTML = '<p style="color:var(--color-text-muted);padding:12px;text-align:center">履歴がありません</p>';
      return;
    }

    // スコープを名称順に表示（all を先頭, scope-N を番号順に）
    const sorted = scopeKeys.sort((a, b) => {
      if (a === 'all') return -1;
      if (b === 'all') return 1;
      const na = parseInt(a.split('-')[1]) || 0;
      const nb = parseInt(b.split('-')[1]) || 0;
      return na - nb;
    });

    sorted.forEach(scopeKey => {
      const msgs = allScopes[scopeKey];
      const isCurrent = scopeKey === _currentScope;
      const scopeLabel = scopeKey === 'all'
        ? '全セクション (骨子)'
        : `スコープ ${scopeKey.split('-')[1]}`;

      const item = document.createElement('div');
      item.className = 'chat-history-scope-item' + (isCurrent ? ' current' : '');
      item.dataset.scope = scopeKey;
      item.innerHTML = `
        <span class="chat-history-scope-name">${escHtml(scopeLabel)}</span>
        ${isCurrent ? '<span class="chat-history-scope-current-badge">現在</span>' : ''}
        <div class="chat-history-scope-actions">
          ${!isCurrent ? `<button class="chat-history-scope-btn btn-switch" title="切り替え">↗</button>` : ''}
          <button class="chat-history-scope-btn btn-delete" title="削除">✕</button>
        </div>
      `;

      // クリックでチャット一覧を表示
      item.addEventListener('click', (e) => {
        if (!e.target.closest('.chat-history-scope-btn')) {
          _showMessagesForScope(scopeKey, allScopes[scopeKey]);
          document.querySelectorAll('.chat-history-scope-item').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
        }
      });

      // 切り替えボタン
      const switchBtn = item.querySelector('.btn-switch');
      if (switchBtn) {
        switchBtn.addEventListener('click', async () => {
          _currentScope = scopeKey;
          document.getElementById('modal-chat-history').style.display = 'none';
          showToast(`スコープを「${scopeLabel}」に切り替えました`, 'success');
        });
      }

      // 削除ボタン
      const deleteBtn = item.querySelector('.btn-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          const confirmed = await Modal.confirm(`「${scopeLabel}」の履歴を削除しますか？`);
          if (confirmed) {
            const project = window.appState.getProject();
            await ApiClient.delete(`/api/projects/${project.id}/chat-history/${scopeKey}`);
            // 再読み込み
            const updatedScopes = await ApiClient.get(
              `/api/projects/${project.id}/chat-history/all-scopes`
            );
            _renderScopeList(container, updatedScopes);
            // 削除したスコープが選択されていたらクリア
            if (_selectedHistoryScope === scopeKey) {
              document.getElementById('chat-history-messages-list').innerHTML =
                '<p class="chat-history-placeholder">スコープが削除されました</p>';
              _selectedHistoryScope = null;
            }
            showToast(`「${scopeLabel}」を削除しました`, 'success');
          }
        });
      }

      container.appendChild(item);
    });
  }

  function _showMessagesForScope(scopeKey, msgs) {
    _selectedHistoryScope = scopeKey;
    const container = document.getElementById('chat-history-messages-list');

    if (!msgs || msgs.length === 0) {
      container.innerHTML = '<p class="chat-history-placeholder">メッセージがありません</p>';
      return;
    }

    container.innerHTML = '';
    msgs.forEach(msg => {
      const div = document.createElement('div');
      div.className = `chat-history-msg ${msg.role}`;

      if (msg.role === 'command') {
        div.innerHTML = `
          <div class="chat-history-msg-role command">
            <span>⚡ コマンド</span>
          </div>
          <div class="chat-history-msg-content">${escHtml(msg.content)}</div>
          <div class="chat-history-msg-time">${new Date(msg.timestamp).toLocaleString('ja-JP')}</div>
        `;
      } else {
        const roleLabel = msg.role === 'user' ? 'あなた' : 'AI';
        const roleIcon = msg.role === 'user' ? '👤' : '🤖';
        div.innerHTML = `
          <div class="chat-history-msg-role ${msg.role}">
            <span>${roleIcon} ${roleLabel}</span>
          </div>
          <div class="chat-history-msg-content">${escHtml(msg.content)}</div>
          <div class="chat-history-msg-time">${new Date(msg.timestamp).toLocaleString('ja-JP')}</div>
        `;
      }
      container.appendChild(div);
    });

    // 最新メッセージまでスクロール
    container.scrollTop = container.scrollHeight;
  }

  return { init, switchTab, enterEditor, setCurrentScope };
})();

// ─── エントリーポイント ──────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  AppShell.init();
});
