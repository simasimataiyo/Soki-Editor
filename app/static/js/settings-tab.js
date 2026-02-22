/**
 * SettingsTab — LLM 設定 UI（タスク 15）
 */

const SettingsTab = (() => {
  function render(project) {
    if (!project) return;
    const s = project.settings;
    document.getElementById('settings-api-key').value = s.api_key || '';
    document.getElementById('settings-endpoint').value = s.endpoint_url || '';
    document.getElementById('settings-model').value = s.model || 'gpt-4o';
  }

  function bindEvents() {
    document.getElementById('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const project = window.appState.getProject();
      if (!project) return;

      const settings = {
        api_key: document.getElementById('settings-api-key').value.trim(),
        endpoint_url: document.getElementById('settings-endpoint').value.trim() || null,
        model: document.getElementById('settings-model').value.trim() || 'gpt-4o',
      };

      try {
        const updated = await ApiClient.put(
          `/api/projects/${project.id}/settings`,
          settings
        );
        project.settings = updated;
        showToast('設定を保存しました', 'success');
      } catch (_) {}
    });
  }

  return { render, bindEvents };
})();
