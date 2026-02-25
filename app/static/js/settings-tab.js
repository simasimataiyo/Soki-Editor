/**
 * SettingsTab — グローバル LLM 設定 UI
 */

const SettingsTab = (() => {
  async function render(_project) {
    try {
      const s = await ApiClient.get('/api/settings');
      document.getElementById('settings-api-key').value = s.api_key || '';
      document.getElementById('settings-endpoint').value = s.endpoint_url || '';
      document.getElementById('settings-model').value = s.model || 'gpt-4o';
      document.getElementById('settings-pdf-dpi').value = s.pdf_page_dpi ?? 96;
    } catch (_) {}
  }

  function bindEvents() {
    document.getElementById('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const settings = {
        api_key: document.getElementById('settings-api-key').value.trim(),
        endpoint_url: document.getElementById('settings-endpoint').value.trim() || null,
        model: document.getElementById('settings-model').value.trim() || 'gpt-4o',
        pdf_page_dpi: parseInt(document.getElementById('settings-pdf-dpi').value, 10) || 96,
      };

      try {
        await ApiClient.put('/api/settings', settings);
        showToast('設定を保存しました', 'success');
      } catch (_) {
        showToast('設定の保存に失敗しました', 'error');
      }
    });
  }

  return { render, bindEvents };
})();
