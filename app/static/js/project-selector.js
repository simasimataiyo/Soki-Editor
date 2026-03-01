/**
 * ProjectSelector — プロジェクト選択画面の実装（タスク 10.4）
 */

const ProjectSelector = (() => {
  // ディレクトリブラウザの状態
  let _fbResolve = null;  // Promise resolve for file browser modal
  let _fbCurrentDir = '';

  // ブラウザモードの FileHandle（showSaveFilePicker 用）
  let _pendingSaveHandle = null;

  // showOpenFilePicker で開いたファイルの FileHandle（上書き保存用）
  let _openFileHandle = null;

  async function init() {
    await _loadRecentProjects();
    _bindEvents();
  }

  async function _loadRecentProjects() {
    try {
      const recents = await ApiClient.get('/api/projects/recent');
      const grid = document.getElementById('project-card-grid');
      grid.innerHTML = '';
      if (recents.length === 0) {
        grid.innerHTML = '<p style="color:var(--color-text-muted);font-size:13px">プロジェクトがありません</p>';
        return;
      }
      recents.forEach(meta => {
        const card = document.createElement('div');
        card.className = 'project-card';

        // 日付表示: updated_at があればフォーマット、なければ file_path のファイル名
        let dateText = '';
        if (meta.updated_at) {
          try {
            dateText = new Date(meta.updated_at).toLocaleDateString('ja-JP');
          } catch (_) {
            dateText = meta.updated_at;
          }
        } else if (meta.file_path) {
          dateText = meta.file_path.split(/[\\/]/).pop() || meta.file_path;
        }

        card.innerHTML = `
          <div class="project-card-name">${escHtml(meta.name)}</div>
          <div class="project-card-date">${escHtml(dateText)}</div>
        `;
        card.addEventListener('click', () => _openRecentProject(meta.file_path));
        grid.appendChild(card);
      });
    } catch (_) {
      const grid = document.getElementById('project-card-grid');
      if (grid) grid.innerHTML = '<p style="color:var(--color-text-muted);font-size:13px">プロジェクトがありません</p>';
    }
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

    // ディレクトリブラウザのイベント
    document.getElementById('btn-fb-up').addEventListener('click', _fbGoUp);
    document.getElementById('btn-fb-cancel').addEventListener('click', _fbCancel);
    document.getElementById('btn-fb-select').addEventListener('click', _fbConfirm);
  }

  function _showNewProjectModal() {
    document.getElementById('new-project-name').value = '';
    document.getElementById('new-project-path').value = '';
    _pendingSaveHandle = null;
    document.getElementById('modal-new-project').style.display = 'flex';
  }

  function _hideNewProjectModal() {
    document.getElementById('modal-new-project').style.display = 'none';
  }

  async function _selectJsonPath() {
    // 1. pywebview ネイティブダイアログを試行
    try {
      const result = await ApiClient.saveFileDialog('新しいプロジェクト.json');
      if (result && result.path) {
        document.getElementById('new-project-path').value = result.path;
        return;
      }
    } catch (_) {
      // ネイティブダイアログが使えない場合はフォールバック
    }

    const name = document.getElementById('new-project-name').value.trim() || 'project';

    // 2. ブラウザモード: showSaveFilePicker（Chrome/Edge 対応）
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name + '.json',
          types: [{
            description: 'Soki Project (.json)',
            accept: { 'application/json': ['.json'] },
          }],
        });
        _pendingSaveHandle = handle;
        // サーバー側パスはファイル名ベースで自動生成
        const chosenName = handle.name.replace(/\.json$/i, '') || name;
        const res = await ApiClient.get(`/api/projects/suggest-path?name=${encodeURIComponent(chosenName)}`);
        if (res && res.path) {
          document.getElementById('new-project-path').value = res.path;
        }
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // ユーザーがキャンセル
      }
    }

    // 3. フォールバック: ディレクトリブラウザ
    const filename = name + '.json';
    const selectedPath = await _openFileBrowser(filename);
    if (selectedPath) {
      document.getElementById('new-project-path').value = selectedPath;
    }
  }

  // ─── ディレクトリブラウザ ─────────────────────────────────

  /**
   * ディレクトリブラウザモーダルを開き、ユーザーが選択したパスを返す。
   * キャンセル時は null を返す。
   */
  function _openFileBrowser(defaultFilename) {
    return new Promise((resolve) => {
      _fbResolve = resolve;
      document.getElementById('fb-filename').value = defaultFilename || 'project.json';
      document.getElementById('modal-file-browser').style.display = 'flex';
      // ホームディレクトリから開始
      _fbNavigate('');
    });
  }

  async function _fbNavigate(dir) {
    const listEl = document.getElementById('fb-list');
    const pathEl = document.getElementById('fb-current-path');

    listEl.innerHTML = '<div style="padding:12px;color:var(--color-text-muted);font-size:13px">読み込み中...</div>';

    try {
      const data = await ApiClient.get(`/api/filesystem/browse?dir=${encodeURIComponent(dir)}`);
      _fbCurrentDir = data.current;
      pathEl.textContent = data.current;

      listEl.innerHTML = '';

      if (data.dirs.length === 0 && data.files.length === 0) {
        listEl.innerHTML = '<div style="padding:12px;color:var(--color-text-muted);font-size:13px">空のフォルダです</div>';
        return;
      }

      // ディレクトリ
      data.dirs.forEach(d => {
        const item = document.createElement('div');
        item.className = 'file-browser-item is-dir';
        item.innerHTML = `<span class="file-browser-icon">&#128193;</span><span>${escHtml(d.name)}</span>`;
        item.addEventListener('click', () => _fbNavigate(d.path));
        listEl.appendChild(item);
      });

      // .json ファイル
      data.files.forEach(f => {
        const item = document.createElement('div');
        item.className = 'file-browser-item is-file';
        item.innerHTML = `<span class="file-browser-icon">&#128196;</span><span>${escHtml(f.name)}</span>`;
        item.addEventListener('click', () => {
          document.getElementById('fb-filename').value = f.name;
        });
        listEl.appendChild(item);
      });
    } catch (_) {
      listEl.innerHTML = '<div style="padding:12px;color:var(--color-danger);font-size:13px">ディレクトリを読み込めませんでした</div>';
    }
  }

  function _fbGoUp() {
    _fbNavigate(_fbCurrentDir.replace(/[\\/][^\\/]+$/, '') || _fbCurrentDir);
  }

  function _fbCancel() {
    document.getElementById('modal-file-browser').style.display = 'none';
    if (_fbResolve) { _fbResolve(null); _fbResolve = null; }
  }

  function _fbConfirm() {
    const filename = document.getElementById('fb-filename').value.trim();
    if (!filename) { showToast('ファイル名を入力してください', 'error'); return; }

    // パス区切り文字を判定（Windows: \, その他: /）
    const sep = _fbCurrentDir.includes('\\') ? '\\' : '/';
    const fullPath = _fbCurrentDir + sep + filename;

    document.getElementById('modal-file-browser').style.display = 'none';
    if (_fbResolve) { _fbResolve(fullPath); _fbResolve = null; }
  }

  // ─── プロジェクト作成・オープン ────────────────────────────

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

      // showSaveFilePicker で取得した FileHandle があれば、プロジェクト JSON を書き込む
      if (_pendingSaveHandle) {
        try {
          const projectData = await ApiClient.get(`/api/projects/${project.id}`);
          const writable = await _pendingSaveHandle.createWritable();
          await writable.write(JSON.stringify(projectData, null, 2));
          await writable.close();
        } catch (e) {
          console.warn('FileHandle への書き込みに失敗:', e);
        }
        _pendingSaveHandle = null;
      }

      AppShell.enterEditor(project);
    } catch (_) {}
  }

  async function _openProjectFromFile() {
    // 1. pywebview ネイティブダイアログを試行（元のパスで直接開ける）
    try {
      const result = await ApiClient.openFileDialog([['Soki Project', '*.json'], ['JSON ファイル', '*.json']]);
      if (result && result.path) {
        const project = await ApiClient.post('/api/projects/open', { json_file_path: result.path });
        AppShell.enterEditor(project);
        return;
      }
    } catch (_) {
      // ネイティブダイアログが使えない場合はフォールバック
    }

    // 2. File System Access API（showOpenFilePicker）を試行
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'Soki Project (.json)', accept: { 'application/json': ['.json'] } }],
          multiple: false,
        });
        const file = await handle.getFile();
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/projects/open-upload', { method: 'POST', body: formData });
        if (!res.ok) { const d = await res.json(); showToast(d.detail || 'エラー', 'error'); return; }
        const project = await res.json();
        // 保存時に元のファイルへ書き戻せるよう FileHandle を保持
        _openFileHandle = handle;
        AppShell.enterEditor(project);
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // ユーザーがキャンセル
      }
    }

    // 3. フォールバック: 通常の input[type=file]（元パスへの書き戻し不可）
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

  /** showOpenFilePicker で開いたファイルの FileHandle を返す（Ctrl+S 書き戻し用）。 */
  function getOpenFileHandle() { return _openFileHandle; }

  /** プロジェクト切り替え時に FileHandle をクリアする。 */
  function clearOpenFileHandle() { _openFileHandle = null; }

  return { init, getOpenFileHandle, clearOpenFileHandle };
})();
