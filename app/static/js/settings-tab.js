/**
 * SettingsTab — グローバル LLM 設定 UI
 */

const SettingsTab = (() => {
  function applyLeftPanelWidth(px) {
    document.documentElement.style.setProperty('--left-panel-w', px + 'px');
  }

  function applyHistoryPanelWidth(px) {
    document.documentElement.style.setProperty('--history-panel-w', px + 'px');
  }

  function applyOutlinePanelWidth(px) {
    document.documentElement.style.setProperty('--outline-panel-w', px + 'px');
  }

  async function render(project) {
    // プロジェクト名フィールドの更新
    const nameEl = document.getElementById('settings-project-name');
    if (nameEl) {
      nameEl.value = project ? (project.name || '') : '';
    }

    try {
      const s = await ApiClient.get('/api/settings');
      document.getElementById('settings-api-key').value = s.api_key || '';
      document.getElementById('settings-endpoint').value = s.endpoint_url || '';
      document.getElementById('settings-model').value = s.model || 'gpt-4o';
      document.getElementById('settings-pdf-dpi').value = s.pdf_page_dpi ?? 96;
      document.getElementById('settings-review-max-comments').value = s.review_max_comments ?? 0;
      const autoEl = document.getElementById('settings-auto-process-on-drop');
      if (autoEl) autoEl.checked = s.auto_process_on_drop ?? true;
      applyLeftPanelWidth(s.left_panel_width ?? 280);
      applyHistoryPanelWidth(s.history_panel_width ?? 280);
      applyOutlinePanelWidth(s.outline_panel_width ?? 280);
    } catch (_) {}
  }

  function bindEvents() {
    // プロジェクト名フォーム
    document.getElementById('project-settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const project = StateManager.getProject();
      if (!project) {
        showToast('プロジェクトが開かれていません', 'error');
        return;
      }
      const newName = document.getElementById('settings-project-name').value.trim();
      if (!newName) {
        showToast('プロジェクト名を入力してください', 'error');
        return;
      }
      try {
        await ApiClient.put(`/api/projects/${project.id}/name`, { name: newName });
        project.name = newName;
        // トップバーの表示名を更新
        const display = document.getElementById('project-name-display');
        if (display) display.textContent = newName;
        showToast('プロジェクト名を保存しました', 'success');
      } catch (_) {
        showToast('プロジェクト名の保存に失敗しました', 'error');
      }
    });

    // LLM設定フォーム
    document.getElementById('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const settings = {
        api_key: document.getElementById('settings-api-key').value.trim(),
        endpoint_url: document.getElementById('settings-endpoint').value.trim() || null,
        model: document.getElementById('settings-model').value.trim() || 'gpt-4o',
        pdf_page_dpi: parseInt(document.getElementById('settings-pdf-dpi').value, 10) || 96,
        review_max_comments: parseInt(document.getElementById('settings-review-max-comments').value, 10) || 0,
        auto_process_on_drop: document.getElementById('settings-auto-process-on-drop')?.checked ?? true,
      };

      try {
        await ApiClient.put('/api/settings', settings);
        showToast('設定を保存しました', 'success');
      } catch (_) {
        showToast('設定の保存に失敗しました', 'error');
      }
    });
  }

  return { render, bindEvents, applyLeftPanelWidth, applyHistoryPanelWidth, applyOutlinePanelWidth };
})();
