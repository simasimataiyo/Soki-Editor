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
      _showScreen('project-selector');
      window.appState.setState({ project: null });
      ProjectSelector.init();
    });

    // チャット送信（Edit タブ）
    document.getElementById('btn-chat-send').addEventListener('click', _sendChat);
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendChat(); }
    });

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

  function enterEditor(project) {
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
      edit: [
        { id: 'btn-insert-ref', label: '文献挿入', handler: () => EditTab.insertRef() },
        { id: 'btn-insert-fig', label: '図表挿入', handler: () => EditTab.insertFig() },
        { id: 'btn-add-section-top', label: 'セクション追加', handler: () => EditTab.addChapter() },
      ],
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
        { id: 'btn-export-top', label: 'エクスポート', handler: () => {
          if (project) window.location.href = `/api/projects/${project.id}/export`;
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
    responseEl.style.cssText = 'padding:8px 12px;background:#f0f4ff;border-radius:6px;font-size:13px;line-height:1.6;white-space:pre-wrap';
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
