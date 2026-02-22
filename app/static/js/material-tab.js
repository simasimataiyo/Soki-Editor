/**
 * MaterialTab — マテリアル管理 UI（タスク 13）
 */

const MaterialTab = (() => {
  let _project = null;
  let _activeId = null;
  let _sectionCollapsed = {};

  function render(project) {
    _project = project;
    _renderList();
    if (_activeId) _renderDetail(_activeId);
    else document.getElementById('material-detail').innerHTML =
      '<p class="placeholder-text">マテリアルを選択してください</p>';
  }

  function _renderList() {
    const list = document.getElementById('material-list');
    list.innerHTML = '';
    _project.materials.forEach(mat => {
      const li = document.createElement('li');
      li.className = 'material-card' + (mat.id === _activeId ? ' active' : '');
      li.dataset.id = mat.id;
      const imgSrc = mat.thumbnail_path
        ? `/api/files?path=${encodeURIComponent(mat.thumbnail_path)}&project_id=${_project.id}`
        : '';
      li.innerHTML = `
        <div class="material-card-info">
          <div class="material-card-name">${escHtml(mat.name)}</div>
          <div class="material-card-desc">${escHtml(mat.caption || '')}</div>
        </div>
        <div class="material-card-thumb">
          ${imgSrc
            ? `<img src="${imgSrc}" alt="thumbnail" />`
            : '<span class="thumb-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></span>'}
        </div>
      `;
      li.addEventListener('click', () => {
        _activeId = mat.id;
        window.appState.setState({ activeMaterialId: mat.id });
        _renderList();
        _renderDetail(mat.id);
      });
      list.appendChild(li);
    });
  }

  function _renderDetail(matId) {
    const mat = _project.materials.find(m => m.id === matId);
    if (!mat) return;
    const pane = document.getElementById('material-detail');
    const imgSrc = mat.thumbnail_path
      ? `/api/files?path=${encodeURIComponent(mat.thumbnail_path)}&project_id=${_project.id}`
      : '';

    pane.innerHTML = `
      <div class="source-detail-scroll">
        <!-- タイトルバー -->
        <div class="detail-title-bar">
          <h2>${escHtml(mat.name)}</h2>
          <button class="btn-icon-edit" id="btn-edit-material-name" title="名前を編集">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>

        <!-- 設定セクション -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="mat-settings">
            <span class="chevron${_sectionCollapsed['mat-settings'] ? ' collapsed' : ''}">&#x2304;</span>
            <h3>設定</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['mat-settings'] ? ' collapsed' : ''}">
            <div class="form-group" style="margin-bottom:12px">
              <label>ID</label>
              <input type="text" class="form-control" value="${escHtml(mat.id)}" readonly />
            </div>
            <div style="display:flex;justify-content:flex-end">
              <button class="btn btn-danger btn-sm" id="btn-delete-material">削除</button>
            </div>
          </div>
        </div>

        <!-- 図表情報セクション -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="mat-info">
            <span class="chevron${_sectionCollapsed['mat-info'] ? ' collapsed' : ''}">&#x2304;</span>
            <h3>図表情報</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['mat-info'] ? ' collapsed' : ''}">
            <div class="form-group" style="margin-bottom:10px;max-width:200px">
              <label>種類</label>
              <select class="form-control" id="mat-type">
                <option value="figure" ${mat.type==='figure'?'selected':''}>図</option>
                <option value="table" ${mat.type==='table'?'selected':''}>表</option>
              </select>
            </div>
            <div class="form-group" style="margin-bottom:10px">
              <label>キャプション</label>
              <input type="text" class="form-control" id="mat-caption" value="${escHtml(mat.caption)}" />
            </div>
            <div class="form-group" style="margin-bottom:10px">
              <label>ファイルパス</label>
              <input type="text" class="form-control" value="${escHtml(mat.file_path || '')}" readonly />
            </div>
            <div class="source-actions" style="margin-bottom:12px">
              <button class="btn btn-secondary btn-sm" id="btn-upload-material">ファイル読み込み</button>
            </div>
          </div>
        </div>

        <!-- 画像プレビュー -->
        <div class="material-preview">
          ${imgSrc
            ? `<img src="${imgSrc}" alt="preview" />`
            : '<span class="preview-placeholder"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></span>'}
        </div>
      </div>
    `;

    // 折りたたみイベント
    pane.querySelectorAll('.collapsible-header').forEach(header => {
      header.addEventListener('click', () => {
        const key = header.dataset.section;
        _sectionCollapsed[key] = !_sectionCollapsed[key];
        const chevron = header.querySelector('.chevron');
        const body = header.nextElementSibling;
        chevron.classList.toggle('collapsed');
        body.classList.toggle('collapsed');
      });
    });

    // 名前編集
    document.getElementById('btn-edit-material-name').addEventListener('click', () => {
      const newName = prompt('マテリアル名:', mat.name);
      if (newName && newName !== mat.name) {
        mat.name = newName;
        _renderDetail(mat.id);
        _renderList();
      }
    });

    document.getElementById('btn-delete-material').addEventListener('click', () => _deleteMaterial(mat));
    document.getElementById('btn-upload-material').addEventListener('click', () => _uploadFile(mat));

    // 自動保存
    let saveTimer;
    const autoSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => _saveMaterial(mat), 1000);
    };
    pane.querySelectorAll('input:not([readonly]), select').forEach(el => {
      el.addEventListener('input', autoSave);
      el.addEventListener('change', autoSave);
    });
  }

  async function _saveMaterial(mat) {
    const project = window.appState.getProject();
    const body = {
      name: mat.name,
      type: document.getElementById('mat-type')?.value || mat.type,
      caption: document.getElementById('mat-caption')?.value || mat.caption,
    };
    try {
      const updated = await ApiClient.put(`/api/projects/${project.id}/materials/${mat.id}`, body);
      const idx = project.materials.findIndex(m => m.id === mat.id);
      if (idx >= 0) project.materials[idx] = updated;
      _renderList();
    } catch (_) {}
  }

  async function _deleteMaterial(mat) {
    if (!confirm(`「${mat.name}」を削除しますか？`)) return;
    const project = window.appState.getProject();
    try {
      await ApiClient.delete(`/api/projects/${project.id}/materials/${mat.id}`);
      project.materials = project.materials.filter(m => m.id !== mat.id);
      _activeId = null;
      render(project);
    } catch (_) {}
  }

  async function _uploadFile(mat) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.pdf';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const project = window.appState.getProject();
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch(`/api/projects/${project.id}/materials/${mat.id}/upload`, {
          method: 'POST', body: formData,
        });
        const updated = await res.json();
        const idx = project.materials.findIndex(m => m.id === mat.id);
        if (idx >= 0) project.materials[idx] = updated;
        _renderList();
        _renderDetail(mat.id);
        showToast('アップロード完了', 'success');
      } catch (_) {}
    };
    input.click();
  }

  function bindEvents() {
    document.getElementById('btn-add-material').addEventListener('click', async () => {
      const project = window.appState.getProject();
      if (!project) return;
      const mat = await ApiClient.post(`/api/projects/${project.id}/materials`);
      project.materials.push(mat);
      _activeId = mat.id;
      render(project);
    });
  }

  return { render, bindEvents };
})();
