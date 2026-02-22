/**
 * MaterialTab — マテリアル管理 UI（タスク 13）
 */

const MaterialTab = (() => {
  let _project = null;
  let _activeId = null;

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
      li.className = 'thumbnail-item' + (mat.id === _activeId ? ' active' : '');
      li.dataset.id = mat.id;
      const imgSrc = mat.thumbnail_path
        ? `/api/files?path=${encodeURIComponent(mat.thumbnail_path)}&project_id=${_project.id}`
        : '';
      li.innerHTML = `
        ${imgSrc ? `<img src="${imgSrc}" alt="thumbnail" />` : '<div style="height:80px;background:#eee;border-radius:3px"></div>'}
        <div class="thumb-caption">${escHtml(mat.name)}</div>
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
      <div class="source-form">
        ${imgSrc ? `<img src="${imgSrc}" style="max-width:200px;border-radius:6px;margin-bottom:10px" />` : ''}
        <div class="form-group">
          <label>名前</label>
          <input type="text" class="form-control" id="mat-name" value="${escHtml(mat.name)}" />
        </div>
        <div class="form-group">
          <label>種別</label>
          <select class="form-control" id="mat-type">
            <option value="figure" ${mat.type==='figure'?'selected':''}>図</option>
            <option value="table" ${mat.type==='table'?'selected':''}>表</option>
          </select>
        </div>
        <div class="form-group">
          <label>キャプション</label>
          <input type="text" class="form-control" id="mat-caption" value="${escHtml(mat.caption)}" />
        </div>
        <div class="source-actions">
          <button class="btn btn-sm btn-secondary" id="btn-upload-material">ファイル読み込み</button>
          <button class="btn btn-sm btn-primary" id="btn-save-material">保存</button>
          <button class="btn btn-sm btn-danger" id="btn-delete-material">削除</button>
        </div>
        <div style="font-size:11px;color:var(--color-text-muted);margin-top:4px">ID: ${mat.id}</div>
      </div>
    `;

    document.getElementById('btn-save-material').addEventListener('click', () => _saveMaterial(mat));
    document.getElementById('btn-delete-material').addEventListener('click', () => _deleteMaterial(mat));
    document.getElementById('btn-upload-material').addEventListener('click', () => _uploadFile(mat));
  }

  async function _saveMaterial(mat) {
    const project = window.appState.getProject();
    const body = {
      name: document.getElementById('mat-name').value,
      type: document.getElementById('mat-type').value,
      caption: document.getElementById('mat-caption').value,
    };
    try {
      const updated = await ApiClient.put(`/api/projects/${project.id}/materials/${mat.id}`, body);
      const idx = project.materials.findIndex(m => m.id === mat.id);
      if (idx >= 0) project.materials[idx] = updated;
      showToast('保存しました', 'success');
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
