/**
 * ProjectSelector — プロジェクト選択画面の実装（タスク 10.4）
 */

const ProjectSelector = (() => {
  async function init() {
    await _loadRecentProjects();
    _bindEvents();
  }

  async function _loadRecentProjects() {
    try {
      const recents = await ApiClient.get('/api/projects/recent');
      const list = document.getElementById('recent-list');
      list.innerHTML = '';
      if (recents.length === 0) {
        list.innerHTML = '<li style="color:var(--color-text-muted);font-size:13px">最近使用したプロジェクトはありません</li>';
        return;
      }
      recents.forEach(meta => {
        const li = document.createElement('li');
        li.innerHTML = `
          <div class="recent-name">${escHtml(meta.name)}</div>
          <div class="recent-path">${escHtml(meta.file_path)}</div>
        `;
        li.addEventListener('click', () => _openRecentProject(meta.file_path));
        list.appendChild(li);
      });
    } catch (_) {}
  }

  async function _openRecentProject(filePath) {
    try {
      const project = await ApiClient.post('/api/projects/open', { json_file_path: filePath });
      AppShell.enterEditor(project);
    } catch (e) {
      showToast('プロジェクトを開けませんでした', 'error');
    }
  }

  function _bindEvents() {
    document.getElementById('btn-new-project').addEventListener('click', _showNewProjectModal);
    document.getElementById('btn-open-project').addEventListener('click', _openProjectFromFile);
    document.getElementById('btn-cancel-new-project').addEventListener('click', _hideNewProjectModal);
    document.getElementById('btn-confirm-new-project').addEventListener('click', _confirmNewProject);
    document.getElementById('btn-select-json-path').addEventListener('click', _selectJsonPath);
  }

  function _showNewProjectModal() {
    document.getElementById('new-project-name').value = '';
    document.getElementById('new-project-path').value = '';
    document.getElementById('modal-new-project').style.display = 'flex';
  }

  function _hideNewProjectModal() {
    document.getElementById('modal-new-project').style.display = 'none';
  }

  async function _selectJsonPath() {
    const result = await ApiClient.saveFileDialog('新しいプロジェクト.json');
    if (result && result.path) {
      document.getElementById('new-project-path').value = result.path;
    } else {
      // ブラウザモード: サーバーからデフォルトパスを取得して入力欄に設定する
      const name = document.getElementById('new-project-name').value.trim() || 'project';
      try {
        const res = await ApiClient.get(`/api/projects/suggest-path?name=${encodeURIComponent(name)}`);
        if (res && res.path) {
          document.getElementById('new-project-path').value = res.path;
        }
      } catch (_) {}
    }
  }

  async function _confirmNewProject() {
    const name = document.getElementById('new-project-name').value.trim();
    const path = document.getElementById('new-project-path').value.trim();
    if (!name) { showToast('プロジェクト名を入力してください', 'error'); return; }
    if (!path) { showToast('保存先を選択してください', 'error'); return; }

    try {
      const project = await ApiClient.post('/api/projects', {
        name,
        json_file_path: path,
        data_dir: null,
      });
      _hideNewProjectModal();
      AppShell.enterEditor(project);
    } catch (_) {}
  }

  async function _openProjectFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch('/api/projects/open-upload', { method: 'POST', body: formData });
        if (!res.ok) { const d = await res.json(); showToast(d.detail || 'エラー', 'error'); return; }
        const project = await res.json();
        AppShell.enterEditor(project);
      } catch (_) {
        showToast('プロジェクトを開けませんでした', 'error');
      }
    };
    input.click();
  }

  return { init };
})();
