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

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
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

    // チャット送信（Edit タブ）
    document.getElementById('btn-chat-send').addEventListener('click', _sendChat);
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendChat(); }
    });

    // チャット入力欄リサイズハンドル
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

    // チャット入力欄とレビュー入力欄のリサイズハンドルを初期化
    initResizeHandle('chat-resize-handle', 'chat-input');
    initResizeHandle('review-resize-handle', 'review-prompt');

    // チャット履歴
    document.getElementById('btn-chat-history').addEventListener('click', _showChatHistory);
    document.getElementById('btn-close-history').addEventListener('click', () => {
      document.getElementById('modal-chat-history').style.display = 'none';
    });
    document.getElementById('btn-clear-history').addEventListener('click', _clearChatHistory);

    // 各タブのイベント
    EditTab.bindEvents();
    SourceTab.bindEvents();
    MaterialTab.bindEvents();
    RuleTab.bindEvents();
    ReviewTab.bindEvents();
    SettingsTab.bindEvents();

    // ルール左パネルの新規追加ボタン
    document.getElementById('btn-add-rule-from-panel').addEventListener('click', () => {
      RuleTab.addCategory();
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
    window.appState.setProject(project);
    document.getElementById('project-name-display').textContent = project.name || '';
    _showScreen('editor-screen');
    switchTab('edit');
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
        { id: 'btn-add-category-top', label: 'セクション追加', handler: () => RuleTab.addCategory() },
      ],
      review: [
        { id: 'btn-export-top', label: 'エクスポート', handler: async () => {
          if (!project) return;
          try {
            const res = await fetch(`/api/projects/${project.id}/export`);
            if (!res.ok) { showToast('エクスポートに失敗しました', 'error'); return; }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${project.name}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('エクスポート完了', 'success');
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

  async function _sendChat() {
    const project = window.appState.getProject();
    if (!project) return;
    if (_currentSseCtrl) _currentSseCtrl.abort();

    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message) return;

    const scope = document.getElementById('chat-scope').value;
    const useFullSources = document.getElementById('chat-full-sources').checked;

    input.value = '';
    const btn = document.getElementById('btn-chat-send');
    btn.disabled = true;

    // チャット応答表示用コンテナ（チャットバー上部に追加）
    const chatBar = document.getElementById('chat-bar');
    const responseEl = document.createElement('div');
    responseEl.style.cssText = 'padding:8px 12px;background:var(--color-primary-pale);border-radius:6px;font-size:13px;line-height:1.6;white-space:pre-wrap';
    chatBar.insertBefore(responseEl, chatBar.firstChild);

    _currentSseCtrl = ApiClient.openSSE(
      `/api/projects/${project.id}/chat`,
      { user_message: message, context_scope: scope, use_full_sources: useFullSources },
      {
        onChunk: (text) => {
          responseEl.textContent += text;
        },
        onToolCall: async (tool, args) => {
          await _applyToolCall(project, tool, args);
        },
        onDone: () => {
          btn.disabled = false;
          setTimeout(() => responseEl.remove(), 10000);
        },
        onError: (msg) => {
          btn.disabled = false;
          showToast(`チャットエラー: ${msg}`, 'error');
          responseEl.remove();
        },
      }
    );
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
      }
    } catch (e) {
      showToast(`ツールコール適用エラー: ${e.message}`, 'error');
    }
  }

  // ─── チャット履歴 ─────────────────────────────────────

  async function _showChatHistory() {
    const project = window.appState.getProject();
    if (!project) return;
    const scope = document.getElementById('chat-scope').value;
    const history = await ApiClient.get(
      `/api/projects/${project.id}/chat-history?scope=${encodeURIComponent(scope)}`
    );
    const container = document.getElementById('chat-history-content');
    container.innerHTML = '';
    if (!history.length) {
      container.innerHTML = '<p style="color:var(--color-text-muted)">履歴がありません</p>';
    } else {
      history.forEach(msg => {
        const div = document.createElement('div');
        div.className = `history-msg ${msg.role}`;
        div.textContent = msg.content;
        container.appendChild(div);
      });
    }
    document.getElementById('modal-chat-history').style.display = 'flex';
  }

  async function _clearChatHistory() {
    const project = window.appState.getProject();
    if (!project) return;
    const scope = document.getElementById('chat-scope').value;
    await ApiClient.delete(
      `/api/projects/${project.id}/chat-history?scope=${encodeURIComponent(scope)}`
    );
    document.getElementById('modal-chat-history').style.display = 'none';
    showToast('履歴を削除しました', 'success');
  }

  return { init, switchTab, enterEditor };
})();

// ─── エントリーポイント ──────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  AppShell.init();
});
