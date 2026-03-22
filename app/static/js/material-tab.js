import { ApiClient } from './api-client.js';
import { showToast } from './toast.js';
import { appState } from './state-manager.js';
import { Modal } from './modal.js';
import { escHtml } from './dom-utils.js';
import { SVG_CHEVRON_RIGHT, SVG_CHEVRON_DOWN, SVG_IMAGE_SM, SVG_IMAGE_LG, SVG_DELETE } from './svg-icons.js';
import { marked } from './tiptap-bundle.js';

/**
 * MaterialTab — マテリアル管理 UI（タスク 13）
 */

export const MaterialTab = (() => {
  const DEFAULT_MATERIAL_NAME = '新しいマテリアル';
  const _APP_TOKEN = ApiClient.getAppToken();
  let _tiptapEditor = null;

  function _authFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (_APP_TOKEN) headers.set('X-App-Token', _APP_TOKEN);
    return fetch(url, { ...options, headers });
  }

  function _withApiToken(url) {
    if (!_APP_TOKEN) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}app_token=${encodeURIComponent(_APP_TOKEN)}`;
  }

  let _project = null;
  let _activeId = null;
  let _sectionCollapsed = {};

  // 左パネルカテゴリグループの折りたたみ状態
  let _groupCollapsed = {};

  // 検索フィルター文字列
  let _searchFilter = '';

  // DnD 状態
  let _materialDragState = null; // { draggedId, targetId, position, draggedGroupType }
  let _isDraggingItem = false;

  // 保存タイマー（モジュールレベル、一元管理）
  let _pendingSaveTimer = null;
  let _pendingSaveId = null;
  let _nameTimer = null;

  const MAT_TYPE_LABELS = { figure: '図', table: '表' };
  const MAT_TYPES_ORDER = ['figure', 'table'];

  /** デバウンス保存をスケジュール */
  function _scheduleSave(matId) {
    if (_pendingSaveTimer) clearTimeout(_pendingSaveTimer);
    _pendingSaveId = matId;
    _pendingSaveTimer = setTimeout(() => {
      _pendingSaveTimer = null;
      _pendingSaveId = null;
      _saveMaterial(matId);
    }, 2000);
  }

  /** 保留中の保存を即時フラッシュ（DOM切替前に呼ぶこと） */
  function _flushPendingSave() {
    if (_pendingSaveTimer) {
      clearTimeout(_pendingSaveTimer);
      _pendingSaveTimer = null;
      const id = _pendingSaveId;
      _pendingSaveId = null;
      if (id) _saveMaterial(id);
    }
  }

  function render(project) {
    _flushPendingSave();
    _project = project;
    _renderList();
    if (_activeId) _renderDetail(_activeId);
    else document.getElementById('material-detail').innerHTML =
      '<p class="placeholder-text">マテリアルを選択してください</p>';
  }

  function _renderList() {
    const list = document.getElementById('material-list');
    list.innerHTML = '';

    const filter = _searchFilter.toLowerCase();
    const materials = filter
      ? _project.materials.filter(m =>
          (m.name || '').toLowerCase().includes(filter) ||
          (m.caption || '').toLowerCase().includes(filter)
        )
      : _project.materials;

    // カテゴリ別にグループ化
    const groups = { figure: [], table: [] };
    materials.forEach(m => {
      (groups[m.type] || groups['figure']).push(m);
    });

    MAT_TYPES_ORDER.forEach(type => {
      const items = groups[type];
      if (items.length === 0) return;

      // グループヘッダー li
      const headerLi = document.createElement('li');
      headerLi.className = 'material-group-header';
      headerLi.dataset.groupType = type;
      const isCollapsed = !!_groupCollapsed[type];
      headerLi.innerHTML = `
        <span class="chevron">${isCollapsed ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
        <span class="group-label">${MAT_TYPE_LABELS[type]}</span>
        <span class="group-count">${items.length}</span>
      `;
      headerLi.addEventListener('click', () => {
        _groupCollapsed[type] = !_groupCollapsed[type];
        _renderList();
      });
      list.appendChild(headerLi);

      if (!isCollapsed) {
        items.forEach(mat => {
          const li = _createMaterialListItem(mat, type);
          list.appendChild(li);
        });
      }
    });
  }

  function _createMaterialListItem(mat, groupType) {
    const li = document.createElement('li');
    li.className = 'material-list-item';
    if (mat.id === _activeId) li.classList.add('active');
    li.dataset.id = mat.id;
    li.dataset.groupType = groupType;
    li.draggable = true;

    const imgSrc = mat.thumbnail_path
      ? _withApiToken(`/api/files?path=${encodeURIComponent(mat.thumbnail_path)}&project_id=${_project.id}`)
      : '';
    li.innerHTML = `
      <span class="material-drag-handle" title="ドラッグして並べ替え">⠿</span>
      <div class="material-list-thumb">
        ${imgSrc
          ? `<img src="${imgSrc}" alt="thumbnail" />`
          : `<span class="thumb-placeholder">${SVG_IMAGE_SM}</span>`}
      </div>
      <div class="material-list-text">
        <div class="material-list-name">${escHtml(mat.name)}</div>
        <div class="material-list-desc">${escHtml(mat.caption || '')}</div>
      </div>
      <button class="btn-icon item-delete-btn" title="削除">${SVG_DELETE}</button>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.material-drag-handle')) return;
      _flushPendingSave();
      _activeId = mat.id;
      appState.setState({ activeMaterialId: mat.id });
      _renderList();
      _renderDetail(mat.id);
    });

    li.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      _editMaterialName(mat);
    });

    li.querySelector('.item-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      _deleteMaterial(mat);
    });

    _bindMaterialItemDnD(li, mat, groupType);
    return li;
  }

  function _bindMaterialItemDnD(li, mat, groupType) {
    li.addEventListener('dragstart', (e) => {
      _isDraggingItem = true;
      _materialDragState = { draggedId: mat.id, targetId: null, position: null, draggedGroupType: groupType };
      li.classList.add('material-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', mat.id);
    });

    li.addEventListener('dragend', () => {
      _isDraggingItem = false;
      li.classList.remove('material-dragging');
      document.querySelectorAll('#material-list li').forEach(el => {
        el.classList.remove('material-drag-over-before', 'material-drag-over-after');
      });
      _materialDragState = null;
    });

    li.addEventListener('dragover', (e) => {
      if (!_materialDragState) return;
      if (_materialDragState.draggedId === mat.id) return;
      if (_materialDragState.draggedGroupType !== groupType) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.preventDefault();

      const rect = li.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const position = y < rect.height / 2 ? 'before' : 'after';

      document.querySelectorAll('#material-list li').forEach(el => {
        el.classList.remove('material-drag-over-before', 'material-drag-over-after');
      });
      li.classList.add(`material-drag-over-${position}`);
      _materialDragState.targetId = mat.id;
      _materialDragState.position = position;
    });

    li.addEventListener('dragleave', (e) => {
      const rect = li.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top  || e.clientY > rect.bottom) {
        li.classList.remove('material-drag-over-before', 'material-drag-over-after');
      }
    });

    li.addEventListener('drop', async (e) => {
      if (!_materialDragState || !_materialDragState.targetId) return;
      if (_materialDragState.draggedGroupType !== groupType) return;
      e.preventDefault();
      e.stopPropagation();

      const { draggedId, targetId, position } = _materialDragState;
      if (draggedId === targetId) return;

      await _handleMaterialReorder(draggedId, targetId, position);
    });
  }

  async function _handleMaterialReorder(draggedId, targetId, position) {
    const project = appState.getProject();
    const materials = [...project.materials];
    const fromIdx = materials.findIndex(m => m.id === draggedId);
    const toIdx   = materials.findIndex(m => m.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const [dragged] = materials.splice(fromIdx, 1);
    const newToIdx = materials.findIndex(m => m.id === targetId);
    const insertAt = position === 'before' ? newToIdx : newToIdx + 1;
    materials.splice(insertAt, 0, dragged);

    project.materials = materials;
    _renderList();

    try {
      await ApiClient.post(
        `/api/projects/${project.id}/materials/reorder`,
        { ordered_ids: materials.map(m => m.id) }
      );
    } catch (_) {
      showToast('並べ替えに失敗しました', 'error');
      const orig = await ApiClient.get(`/api/projects/${project.id}`);
      project.materials = orig.materials;
      _renderList();
    }
  }

  function _renderDetail(matId) {
    const mat = _project.materials.find(m => m.id === matId);
    if (!mat) return;
    const pane = document.getElementById('material-detail');
    const imgSrc = mat.thumbnail_path
      ? _withApiToken(`/api/files?path=${encodeURIComponent(mat.thumbnail_path)}&project_id=${_project.id}`)
      : '';

    pane.innerHTML = `
      <div class="pane-drag-overlay">
        <span class="pane-drag-overlay-text">ファイルをドラッグアンドドロップ...</span>
      </div>
      
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
            ${mat.type !== 'table' ? `
            <div class="form-group" style="margin-bottom:10px">
              <label>ファイルパス</label>
              <input type="text" class="form-control" value="${escHtml(mat.file_path || '')}" readonly />
            </div>
            <div class="source-actions" style="margin-bottom:12px">
              <button class="btn btn-secondary btn-sm" id="btn-upload-material">ファイル読み込み</button>
            </div>
            ` : ''}
          </div>
        </div>

        ${mat.type === 'table' ? `
        <!-- 表Markdown編集 -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="mat-table">
            <span class="chevron">${_sectionCollapsed['mat-table'] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
            <h3>表データ (Markdown)</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['mat-table'] ? ' collapsed' : ''}">
            <div class="form-group" style="margin-bottom:8px">
              <textarea class="form-control" id="mat-table-content" rows="6" placeholder="| 列1 | 列2 |\n|-----|-----|\n| 値1 | 値2 |">${escHtml(mat.table_content || '')}</textarea>
            </div>
            <div class="table-preview" id="mat-table-preview"></div>
          </div>
        </div>
        ` : `
        <!-- 画像プレビュー -->
        <div class="material-preview">
          ${imgSrc
            ? `<img src="${imgSrc}" alt="preview" />`
            : `<span class="preview-placeholder">${SVG_IMAGE_LG}</span>`}
        </div>
        `}

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
    document.getElementById('btn-upload-material')?.addEventListener('click', () => _uploadFile(mat));

    // ─── ペイン全体ドラッグ&ドロップ ───────────────────────────
    const overlay = pane.querySelector('.pane-drag-overlay');

    function _syncOverlay() {
      const r = pane.getBoundingClientRect();
      overlay.style.top    = r.top    + 'px';
      overlay.style.left   = r.left   + 'px';
      overlay.style.width  = r.width  + 'px';
      overlay.style.height = r.height + 'px';
    }

    async function _handleFileDrop(file) {
      if (!file.type.startsWith('image/')) {
        showToast('画像ファイル（jpg, png, bmp など）のみ対応しています', 'error');
        return;
      }
      const project = appState.getProject();
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await _authFetch(`/api/projects/${project.id}/materials/${mat.id}/upload`, {
          method: 'POST', body: formData,
        });
        if (!res.ok) { showToast('アップロード失敗', 'error'); return; }
        let updated = await res.json();
        if (updated.name === DEFAULT_MATERIAL_NAME) {
          const newName = file.name.replace(/\.[^.]+$/, '');
          if (newName) {
            try {
              updated = await ApiClient.put(
                `/api/projects/${project.id}/materials/${updated.id}`,
                { name: newName }
              );
            } catch (_) {}
          }
        }
        const idx = project.materials.findIndex(m => m.id === mat.id);
        if (idx >= 0) project.materials[idx] = updated;
        _renderList();
        _renderDetail(mat.id);
        showToast('アップロード完了', 'success');
      } catch (_) {
        showToast('アップロードに失敗しました', 'error');
      }
    }

    pane.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      _syncOverlay();
      pane.classList.add('pane-drag-active');
    });

    overlay.addEventListener('dragleave', (e) => {
      if (overlay.contains(e.relatedTarget)) return;
      pane.classList.remove('pane-drag-active');
    });
    overlay.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    overlay.addEventListener('drop', async (e) => {
      e.preventDefault();
      pane.classList.remove('pane-drag-active');
      const file = e.dataTransfer.files[0];
      if (file) await _handleFileDrop(file);
    });

    // 表Markdownプレビュー
    const tableContentEl = document.getElementById('mat-table-content');
    const tablePreviewEl = document.getElementById('mat-table-preview');
    if (tableContentEl && tablePreviewEl) {
      const updateTablePreview = () => {
        const md = tableContentEl.value;
        tablePreviewEl.innerHTML = marked.parse(md);
      };
      updateTablePreview();
      tableContentEl.addEventListener('input', updateTablePreview);
    }

    // typeセレクトを即時反映（UIを切り替えてから保存）
    const typeEl = document.getElementById('mat-type');
    if (typeEl) {
      typeEl.addEventListener('change', () => {
        const project = appState.getProject();
        const currentMat = project.materials.find(m => m.id === mat.id);
        if (currentMat) {
          currentMat.type = typeEl.value;
          _saveMaterial(mat.id);
          _renderDetail(mat.id);
        }
      });
    }

    // 自動保存
    pane.querySelectorAll('input:not([readonly]), textarea').forEach(el => {
      el.addEventListener('input', () => _scheduleSave(mat.id));
      el.addEventListener('change', () => _scheduleSave(mat.id));
    });

    // 名前フィールドの即時反映（常に最新のプロジェクトからマテリアルを参照）
    const nameEl = document.getElementById('mat-name');
    if (nameEl) {
      nameEl.addEventListener('input', () => {
        clearTimeout(_nameTimer);
        _nameTimer = setTimeout(() => {
          // 常に最新のプロジェクトからマテリアルを参照
          const project = appState.getProject();
          const currentMat = project.materials.find(m => m.id === mat.id);
          if (currentMat) {
            currentMat.name = nameEl.value;
            _renderList();
            const h2 = pane.querySelector('.detail-title-bar h2');
            if (h2) h2.textContent = currentMat.name;
          }
        }, 300);
      });
    }
  }

  async function _updateFigureCaptionsInSections(mat) {
    const project = appState.getProject();
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

  async function _saveMaterial(matId) {
    const project = appState.getProject();
    // マテリアルIDで常に最新を参照
    const mat = project.materials.find(m => m.id === matId);
    if (!mat) return;

    const body = {
      name: document.getElementById('mat-name')?.value || mat.name,
      type: document.getElementById('mat-type')?.value || mat.type,
      caption: document.getElementById('mat-caption')?.value || mat.caption,
      table_content: document.getElementById('mat-table-content')?.value ?? mat.table_content,
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
    const project = appState.getProject();
    try {
      await ApiClient.delete(`/api/projects/${project.id}/materials/${mat.id}`);
      project.materials = project.materials.filter(m => m.id !== mat.id);
      _activeId = null;
      render(project);
      // バックエンドで更新された content を取得してTiptapに反映
      try {
        const result = await ApiClient.get(`/api/projects/${project.id}/content`);
        project.content = result.content;
        if (_tiptapEditor) _tiptapEditor.setContentFromMarkdown(project.content);
      } catch (_) {}
    } catch (_) {}
  }

  async function _editMaterialName(mat) {
    const result = await Modal.form('マテリアル編集', [
      { name: 'name', label: '名前', type: 'text', value: mat.name }
    ], {
      confirmText: '保存',
      extraButtons: [
        {
          id: 'delete',
          label: '削除',
          className: 'btn-danger',
          onClick: async (_formData, overlay, resolve, closeModal) => {
            await _deleteMaterial(mat);
            resolve(null);
            closeModal(overlay);
          },
        },
      ],
    });
    if (result === null) return;

    const newName = result.name.trim();
    if (!newName || newName === mat.name) return;

    const project = appState.getProject();
    try {
      const updated = await ApiClient.put(
        `/api/projects/${project.id}/materials/${mat.id}`,
        { name: newName }
      );
      mat.name = newName;
      const idx = project.materials.findIndex(m => m.id === mat.id);
      if (idx >= 0) project.materials[idx] = updated;
      _renderList();
      if (_activeId === mat.id) {
        const h2 = document.querySelector('.detail-title-bar h2');
        if (h2) h2.textContent = mat.name;
      }
    } catch (_) {}
  }

  async function _uploadFile(mat) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const project = appState.getProject();
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await _authFetch(`/api/projects/${project.id}/materials/${mat.id}/upload`, {
          method: 'POST', body: formData,
        });
        let updated = await res.json();
        if (updated.name === DEFAULT_MATERIAL_NAME) {
          const newName = file.name.replace(/\.[^.]+$/, '');
          if (newName) {
            try {
              updated = await ApiClient.put(
                `/api/projects/${project.id}/materials/${updated.id}`,
                { name: newName }
              );
            } catch (_) {}
          }
        }
        const idx = project.materials.findIndex(m => m.id === mat.id);
        if (idx >= 0) project.materials[idx] = updated;
        _renderList();
        _renderDetail(mat.id);
        showToast('アップロード完了', 'success');
      } catch (_) {}
    };
    input.click();
  }

  function bindEvents({ tiptapEditor } = {}) {
    _tiptapEditor = tiptapEditor || null;
    document.getElementById('btn-add-material').addEventListener('click', async () => {
      const project = appState.getProject();
      if (!project) return;
      const mat = await ApiClient.post(`/api/projects/${project.id}/materials`);
      project.materials.push(mat);
      _activeId = mat.id;
      render(project);
    });

    // 検索フィルター
    const searchEl = document.getElementById('material-search');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        _searchFilter = searchEl.value;
        _renderList();
      });
    }
  }

  function reset() {
    if (_pendingSaveTimer) { clearTimeout(_pendingSaveTimer); _pendingSaveTimer = null; _pendingSaveId = null; }
    _project = null;
    _activeId = null;
    _sectionCollapsed = {};
    _groupCollapsed = {};
    _searchFilter = '';
    _materialDragState = null;
    _isDraggingItem = false;
  }

  return { render, bindEvents, reset };
})();

