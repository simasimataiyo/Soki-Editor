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
            : `<span class="thumb-placeholder">${SVG_IMAGE_SM}</span>`}
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
        </div>

        <!-- 図表情報セクション -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="mat-info">
            <span class="chevron">${_sectionCollapsed['mat-info'] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
            <h3>図表情報</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['mat-info'] ? ' collapsed' : ''}">
            <div class="form-group" style="margin-bottom:10px">
              <label>名前</label>
              <input type="text" class="form-control" id="mat-name" value="${escHtml(mat.name)}" />
            </div>
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
            : `<span class="preview-placeholder">${SVG_IMAGE_LG}</span>`}
        </div>

        <!-- 設定セクション -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="mat-settings">
            <span class="chevron">${_sectionCollapsed['mat-settings'] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
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
        
      </div>
    `;

    // 折りたたみイベント
    pane.querySelectorAll('.collapsible-header').forEach(header => {
      header.addEventListener('click', () => {
        const key = header.dataset.section;
        _sectionCollapsed[key] = !_sectionCollapsed[key];
        const chevron = header.querySelector('.chevron');
        const body = header.nextElementSibling;
        chevron.innerHTML = _sectionCollapsed[key] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN;
        body.classList.toggle('collapsed');
      });
    });

    document.getElementById('btn-delete-material').addEventListener('click', () => _deleteMaterial(mat));
    document.getElementById('btn-upload-material').addEventListener('click', () => _uploadFile(mat));

    // サムネイル表示エリアへのドラッグ&ドロップ
    const previewEl = pane.querySelector('.material-preview');
    if (previewEl) {
      previewEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        previewEl.classList.add('drag-over');
      });
      previewEl.addEventListener('dragleave', () => {
        previewEl.classList.remove('drag-over');
      });
      previewEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        previewEl.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (!file) return;
        const project = window.appState.getProject();
        const formData = new FormData();
        formData.append('file', file);
        try {
          const res = await fetch(`/api/projects/${project.id}/materials/${mat.id}/upload`, {
            method: 'POST', body: formData,
          });
          if (!res.ok) { showToast('アップロード失敗', 'error'); return; }
          const updated = await res.json();
          const idx = project.materials.findIndex(m => m.id === mat.id);
          if (idx >= 0) project.materials[idx] = updated;
          _renderList();
          _renderDetail(mat.id);
          showToast('アップロード完了', 'success');
        } catch (_) {
          showToast('アップロードに失敗しました', 'error');
        }
      });
    }

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

    // 名前フィールドの即時反映（ソースタブのtitleフィールドと同パターン）
    const nameEl = document.getElementById('mat-name');
    if (nameEl) {
      let nameTimer;
      nameEl.addEventListener('input', () => {
        clearTimeout(nameTimer);
        nameTimer = setTimeout(() => {
          mat.name = nameEl.value;
          _renderList();
          const h2 = pane.querySelector('.detail-title-bar h2');
          if (h2) h2.textContent = mat.name;
        }, 300);
      });
    }
  }

  async function _updateFigureCaptionsInSections(mat) {
    const project = window.appState.getProject();
    if (!project) return;
    const newCaption = mat.caption || mat.name;
    const figPattern = new RegExp(`!\\[[^\\]]*\\]\\(([^"]*"${mat.id}")\\)`, 'g');

    for (const sec of project.sections) {
      if (!sec.content) continue;
      const updated = sec.content.replace(figPattern, `![${newCaption}]($1)`);
      if (updated !== sec.content) {
        sec.content = updated;
        try {
          await ApiClient.put(`/api/projects/${project.id}/sections/${sec.id}`, { content: updated });
        } catch (_) {}
        const contentEl = document.querySelector(`[data-field="content"][data-sec-id="${sec.id}"]`);
        if (contentEl) contentEl.innerText = updated;
      }
    }
  }

  async function _saveMaterial(mat) {
    const project = window.appState.getProject();
    const body = {
      name: document.getElementById('mat-name')?.value || mat.name,
      type: document.getElementById('mat-type')?.value || mat.type,
      caption: document.getElementById('mat-caption')?.value || mat.caption,
    };
    try {
      const updated = await ApiClient.put(`/api/projects/${project.id}/materials/${mat.id}`, body);
      const idx = project.materials.findIndex(m => m.id === mat.id);
      if (idx >= 0) project.materials[idx] = updated;
      _renderList();
      _updateFigureCaptionsInSections(updated);
    } catch (_) {}
  }

  async function _deleteMaterial(mat) {
    if (!(await Modal.confirm(`「${mat.name}」を削除しますか？`))) return;
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

  function reset() {
    _project = null;
    _activeId = null;
    _sectionCollapsed = {};
  }

  return { render, bindEvents, reset };
})();
