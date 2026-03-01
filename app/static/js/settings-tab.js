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

  async function render(_project) {
    try {
      const s = await ApiClient.get('/api/settings');
      document.getElementById('settings-api-key').value = s.api_key || '';
      document.getElementById('settings-endpoint').value = s.endpoint_url || '';
      document.getElementById('settings-model').value = s.model || 'gpt-4o';
      document.getElementById('settings-pdf-dpi').value = s.pdf_page_dpi ?? 96;
      document.getElementById('settings-left-panel-width').value = s.left_panel_width ?? 280;
      applyLeftPanelWidth(s.left_panel_width ?? 280);
      applyHistoryPanelWidth(s.history_panel_width ?? 280);
      applyOutlinePanelWidth(s.outline_panel_width ?? 280);
    } catch (_) {}
  }

  function bindEvents() {
    document.getElementById('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const leftPanelWidth = parseInt(document.getElementById('settings-left-panel-width').value, 10) || 280;
      const settings = {
        api_key: document.getElementById('settings-api-key').value.trim(),
        endpoint_url: document.getElementById('settings-endpoint').value.trim() || null,
        model: document.getElementById('settings-model').value.trim() || 'gpt-4o',
        pdf_page_dpi: parseInt(document.getElementById('settings-pdf-dpi').value, 10) || 96,
        left_panel_width: leftPanelWidth,
      };

      try {
        await ApiClient.put('/api/settings', settings);
        applyLeftPanelWidth(leftPanelWidth);
        showToast('設定を保存しました', 'success');
      } catch (_) {
        showToast('設定の保存に失敗しました', 'error');
      }
    });
  }

  return { render, bindEvents, applyLeftPanelWidth, applyHistoryPanelWidth, applyOutlinePanelWidth };
})();
