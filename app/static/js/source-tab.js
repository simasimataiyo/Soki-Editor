/**
 * SourceTab — ソース管理 UI（タスク 12）
 */

const SourceTab = (() => {
  let _project = null;
  let _activeId = null;

  const BIB_TYPE_LABELS = {
    paper: '論文', book: '図書', book_chapter: '図書の一部', web: 'Web'
  };

  // 折りたたみ状態
  let _sectionCollapsed = {};

  /** 表示用タイトル: 文献情報のタイトル → name のフォールバック */
  function _displayTitle(src) {
    return src.bibliography?.title || src.name;
  }

  function render(project) {
    _project = project;
    _renderList();
    if (_activeId) _renderDetail(_activeId);
    else document.getElementById('source-detail').innerHTML =
      '<p class="placeholder-text">ソースを選択してください</p>';
  }

  function _renderList() {
    const list = document.getElementById('source-list');
    list.innerHTML = '';
    _project.sources.forEach(src => {
      const li = document.createElement('li');
      li.dataset.id = src.id;
      if (src.id === _activeId) li.classList.add('active');
      li.innerHTML = `
        ${SVG_DOCUMENT}
        <span class="item-name">${escHtml(_displayTitle(src))}</span>
      `;
      li.addEventListener('click', () => {
        _activeId = src.id;
        window.appState.setState({ activeSourceId: src.id });
        _renderList();
        _renderDetail(src.id);
      });
      list.appendChild(li);
    });
  }

  function _renderDetail(sourceId) {
    const src = _project.sources.find(s => s.id === sourceId);
    if (!src) return;
    const pane = document.getElementById('source-detail');
    const b = src.bibliography;

    pane.innerHTML = `
      <div class="source-detail-scroll">
        <!-- タイトルバー -->
        <div class="detail-title-bar">
          <h2>${escHtml(_displayTitle(src))}</h2>
        </div>

        <!-- 文献情報セクション -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="bibliography">
            <span class="chevron">${_sectionCollapsed['bibliography'] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
            <h3>文献情報</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['bibliography'] ? ' collapsed' : ''}">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div class="form-group" style="flex:1;max-width:200px">
                <label>種類</label>
                <select class="form-control" id="src-bib-type">
                  ${Object.entries(BIB_TYPE_LABELS).map(([v, l]) =>
                    `<option value="${v}" ${b.type===v?'selected':''}>${l}</option>`
                  ).join('')}
                </select>
              </div>
              <div class="toggle-group">
                <label>参考文献リストに掲載</label>
                <label class="toggle-switch">
                  <input type="checkbox" id="src-include" ${b.include_in_references?'checked':''} />
                  <span class="slider"></span>
                </label>
              </div>
            </div>
            <div id="bib-fields"></div>
          </div>
        </div>

        <!-- 要約セクション -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="summary">
            <span class="chevron">${_sectionCollapsed['summary'] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
            <h3>要約</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['summary'] ? ' collapsed' : ''}">
            <textarea class="form-control" id="src-summary" rows="5">${escHtml(src.summary)}</textarea>
            <div class="source-actions" style="margin-top:8px">
              <button class="btn btn-secondary btn-sm" id="btn-summarize">ソースから要約生成</button>
            </div>
          </div>
        </div>

        <!-- 内容セクション -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="content">
            <span class="chevron">${_sectionCollapsed['content'] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
            <h3>内容</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['content'] ? ' collapsed' : ''}">
            <div class="form-group" style="margin-bottom:12px">
              <label>全文</label>
              <textarea class="form-control" id="src-full-text" rows="10">${escHtml(src.full_text)}</textarea>
            </div>
            <div class="form-group" style="margin-bottom:12px">
              <label>ファイルパス</label>
              <input type="text" class="form-control" id="src-file-path" value="${escHtml(src.file_path || '')}" readonly />
            </div>
            <div class="source-actions">
              <button class="btn btn-secondary btn-sm" id="btn-analyze-image">画像解析</button>
              <button class="btn btn-secondary btn-sm" id="btn-read-file">ファイル読み込み</button>
            </div>
          </div>
        </div>

        <!-- 設定セクション -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="settings">
            <span class="chevron">${_sectionCollapsed['settings'] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
            <h3>設定</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['settings'] ? ' collapsed' : ''}">
            <div class="form-group" style="margin-bottom:12px">
              <label>ID</label>
              <input type="text" class="form-control" id="src-id-display" value="${escHtml(src.id)}" readonly />
            </div>
            <div style="display:flex;justify-content:flex-end">
              <button class="btn btn-danger btn-sm" id="btn-delete-source">ソース削除</button>
            </div>
          </div>
        </div>

      </div>
    `;

    _renderBibFields(b.type);

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

    document.getElementById('src-bib-type').addEventListener('change', (e) => {
      _renderBibFields(e.target.value);
    });

    document.getElementById('btn-delete-source').addEventListener('click', () => _deleteSource(src));
    document.getElementById('btn-read-file').addEventListener('click', () => _readFile(src));
    document.getElementById('btn-analyze-image').addEventListener('click', () => _analyzeImage(src));
    document.getElementById('btn-summarize').addEventListener('click', () => _summarize(src));

    // 内容テキストエリアへのドラッグ&ドロップ
    const fullTextEl = document.getElementById('src-full-text');
    if (fullTextEl) {
      fullTextEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        fullTextEl.classList.add('drag-over');
      });
      fullTextEl.addEventListener('dragleave', () => {
        fullTextEl.classList.remove('drag-over');
      });
      fullTextEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        fullTextEl.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (!file) return;
        const project = window.appState.getProject();
        const formData = new FormData();
        formData.append('file', file);
        try {
          const res = await fetch(
            `/api/projects/${project.id}/sources/${src.id}/read-file-upload`,
            { method: 'POST', body: formData }
          );
          if (!res.ok) { showToast('読み込み失敗', 'error'); return; }
          const updated = await res.json();
          const idx = project.sources.findIndex(s => s.id === src.id);
          if (idx >= 0) project.sources[idx] = updated;
          _renderDetail(src.id);
          showToast('ファイルを読み込みました', 'success');
        } catch (_) {
          showToast('ファイル読み込みに失敗しました', 'error');
        }
      });
    }

    // 自動保存（デバウンス）
    let saveTimer;
    const autoSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => _saveSource(src), 1000);
    };
    pane.querySelectorAll('input:not([readonly]), textarea, select').forEach(el => {
      el.addEventListener('input', autoSave);
      el.addEventListener('change', autoSave);
    });
  }

  function _renderBibFields(type) {
    const container = document.getElementById('bib-fields');
    if (!container) return;
    const src = _project.sources.find(s => s.id === _activeId);
    const b = src?.bibliography || {};
    const fieldSets = {
      paper: ['title', 'author', 'journal', 'volume|issue', 'pages|year', 'other'],
      book: ['title', 'author', 'year', 'publisher', 'publication_place', 'other'],
      book_chapter: ['title', 'author', 'year', 'publisher', 'editor', 'pages', 'other'],
      web: ['title', 'author', 'url', 'site_name', 'accessed_date', 'other'],
    };
    const labels = {
      title:'タイトル', author:'著者', journal:'掲載誌', volume:'巻数', issue:'号数',
      pages:'ページ', year:'出版年', publisher:'出版社', publication_place:'出版地',
      editor:'編者', url:'URL', site_name:'サイト名', accessed_date:'参照日', other:'その他',
    };

    const fields = fieldSets[type] || [];
    container.innerHTML = fields.map(f => {
      if (f.includes('|')) {
        // 2カラム
        const [f1, f2] = f.split('|');
        return `
          <div class="field-row" style="margin-bottom:10px">
            <div class="form-group">
              <label>${labels[f1] || f1}</label>
              <input type="text" class="form-control bib-field" data-field="${f1}" value="${escHtml(b[f1] || '')}" />
            </div>
            <div class="form-group">
              <label>${labels[f2] || f2}</label>
              <input type="text" class="form-control bib-field" data-field="${f2}" value="${escHtml(b[f2] || '')}" />
            </div>
          </div>
        `;
      }
      return `
        <div class="form-group" style="margin-bottom:10px">
          <label>${labels[f] || f}</label>
          <input type="text" class="form-control bib-field" data-field="${f}" value="${escHtml(b[f] || '')}" />
        </div>
      `;
    }).join('');

    // 新しいフィールドにも自動保存をバインド
    container.querySelectorAll('.bib-field').forEach(el => {
      let timer;
      el.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => _saveSource(src), 1000);
        // タイトル変更時はリスト・詳細ヘッダーを即時更新
        if (el.dataset.field === 'title') {
          src.bibliography.title = el.value;
          _renderList();
          const h2 = document.querySelector('.detail-title-bar h2');
          if (h2) h2.textContent = _displayTitle(src);
        }
      });
    });
  }

  async function _saveSource(src) {
    const project = window.appState.getProject();
    const bibType = document.getElementById('src-bib-type')?.value || src.bibliography.type;
    const bibFields = {};
    document.querySelectorAll('.bib-field').forEach(el => {
      bibFields[el.dataset.field] = el.value;
    });

    // 文献情報のタイトルをソース名に同期
    if (bibFields.title) {
      src.name = bibFields.title;
    }
    const body = {
      name: src.name,
      full_text: document.getElementById('src-full-text')?.value || '',
      summary: document.getElementById('src-summary')?.value || '',
      bibliography: {
        ...src.bibliography,
        type: bibType,
        include_in_references: document.getElementById('src-include')?.checked || false,
        ...bibFields,
      },
    };

    try {
      const updated = await ApiClient.put(`/api/projects/${project.id}/sources/${src.id}`, body);
      const idx = project.sources.findIndex(s => s.id === src.id);
      if (idx >= 0) project.sources[idx] = updated;
    } catch (_) {}
  }

  async function _deleteSource(src) {
    if (!(await Modal.confirm(`「${_displayTitle(src)}」を削除しますか？`))) return;
    const project = window.appState.getProject();
    try {
      await ApiClient.delete(`/api/projects/${project.id}/sources/${src.id}`);
      project.sources = project.sources.filter(s => s.id !== src.id);
      _activeId = null;
      render(project);
    } catch (_) {}
  }

  async function _readFile(src) {
    const project = window.appState.getProject();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.md,.pdf,.csv,.docx,.xlsx,.pptx';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch(`/api/projects/${project.id}/sources/${src.id}/read-file-upload`, {
          method: 'POST', body: formData,
        });
        if (!res.ok) { const d = await res.json(); showToast(d.detail || 'エラー', 'error'); return; }
        const updated = await res.json();
        const idx = project.sources.findIndex(s => s.id === src.id);
        if (idx >= 0) project.sources[idx] = updated;
        _renderDetail(src.id);
        showToast('ファイルを読み込みました', 'success');
      } catch (_) {
        showToast('ファイル読み込みに失敗しました', 'error');
      }
    };
    input.click();
  }

  async function _analyzeImage(src) {
    const project = window.appState.getProject();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.jpg,.jpeg,.pdf';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      // PDFの場合はページ選択フローへ
      if (file.name.toLowerCase().endsWith('.pdf')) {
        await _analyzePdfWithPageSelection(src, file);
        return;
      }
      showToast('画像解析中...', 'success');
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch(`/api/projects/${project.id}/sources/${src.id}/analyze-image-upload`, {
          method: 'POST', body: formData,
        });
        if (!res.ok) { const d = await res.json(); showToast(d.detail || 'エラー', 'error'); return; }
        const updated = await res.json();
        const idx = project.sources.findIndex(s => s.id === src.id);
        if (idx >= 0) project.sources[idx] = updated;
        _renderDetail(src.id);
        showToast('画像解析完了', 'success');
      } catch (_) {
        showToast('画像解析に失敗しました', 'error');
      }
    };
    input.click();
  }

  async function _analyzePdfWithPageSelection(src, file) {
    const project = window.appState.getProject();
    showToast('PDFを読み込み中...', 'success');

    // Step 1: サムネイル取得
    const formData1 = new FormData();
    formData1.append('file', file);
    let thumbnails;
    try {
      const res = await fetch(
        `/api/projects/${project.id}/sources/${src.id}/pdf-thumbnails`,
        { method: 'POST', body: formData1 }
      );
      if (!res.ok) { showToast('PDF読み込み失敗', 'error'); return; }
      const data = await res.json();
      thumbnails = data.thumbnails;
    } catch (_) {
      showToast('PDF読み込みに失敗しました', 'error');
      return;
    }
    if (!thumbnails || thumbnails.length === 0) { showToast('ページが見つかりません', 'error'); return; }

    // Step 2: ページ選択モーダル表示
    const selectedPages = await _showPdfPageModal(thumbnails);
    if (selectedPages === null || selectedPages.length === 0) return;

    // Step 3: 選択ページをVision解析
    showToast('画像認識中...', 'success');
    const formData2 = new FormData();
    formData2.append('file', file);
    formData2.append('pages', selectedPages.join(','));
    try {
      const res = await fetch(
        `/api/projects/${project.id}/sources/${src.id}/analyze-pdf-pages`,
        { method: 'POST', body: formData2 }
      );
      if (!res.ok) { const d = await res.json(); showToast(d.detail || '解析失敗', 'error'); return; }
      const updated = await res.json();
      const idx = project.sources.findIndex(s => s.id === src.id);
      if (idx >= 0) project.sources[idx] = updated;
      _renderDetail(src.id);
      showToast('画像認識完了', 'success');
    } catch (_) {
      showToast('画像認識に失敗しました', 'error');
    }
  }

  function _showPdfPageModal(thumbnails) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';

      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.style.maxWidth = '700px';
      modal.style.width = '90vw';

      const thumbsHtml = thumbnails.map(t => `
        <label class="pdf-page-thumb">
          <input type="checkbox" value="${t.page}" />
          <img src="${escHtml(t.data)}" alt="${escHtml(t.label)}" />
          <span class="pdf-page-label">${escHtml(t.label)}</span>
        </label>
      `).join('');

      modal.innerHTML = `
        <h3 style="margin-bottom:8px">ページを選択</h3>
        <p style="color:var(--color-text-muted);font-size:13px;margin-bottom:12px">解析するページを選択してください（複数選択可）</p>
        <div class="pdf-page-grid">${thumbsHtml}</div>
        <div class="modal-actions" style="margin-top:16px">
          <button class="btn btn-secondary" id="pdf-modal-cancel">キャンセル</button>
          <button class="btn btn-primary" id="pdf-modal-confirm">解析実行</button>
        </div>
      `;

      // チェックボックスの選択状態をラベルに反映
      modal.querySelectorAll('.pdf-page-thumb input').forEach(cb => {
        cb.addEventListener('change', () => {
          cb.closest('.pdf-page-thumb').classList.toggle('selected', cb.checked);
        });
      });

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      modal.querySelector('#pdf-modal-cancel').addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });
      modal.querySelector('#pdf-modal-confirm').addEventListener('click', () => {
        const checked = [...modal.querySelectorAll('input[type="checkbox"]:checked')];
        const pages = checked.map(cb => parseInt(cb.value));
        overlay.remove();
        resolve(pages);
      });
    });
  }

  async function _summarize(src) {
    const project = window.appState.getProject();
    showToast('要約生成中...', 'success');
    try {
      const updated = await ApiClient.post(
        `/api/projects/${project.id}/sources/${src.id}/summarize`
      );
      const idx = project.sources.findIndex(s => s.id === src.id);
      if (idx >= 0) project.sources[idx] = updated;
      _renderDetail(src.id);
      showToast('要約を生成しました', 'success');
    } catch (_) {}
  }

  function bindEvents() {
    document.getElementById('btn-add-source').addEventListener('click', async () => {
      const project = window.appState.getProject();
      if (!project) return;
      const src = await ApiClient.post(`/api/projects/${project.id}/sources`);
      project.sources.push(src);
      _activeId = src.id;
      render(project);
    });
  }

  async function exportCsv() {
    const project = window.appState.getProject();
    if (!project) return;
    try {
      const res = await fetch(`/api/projects/${project.id}/sources/export`);
      if (!res.ok) { showToast('エクスポートに失敗しました', 'error'); return; }
      const csvText = await res.text();
      // pywebview ネイティブ保存ダイアログ
      const dialog = await ApiClient.saveFileDialog('sources.csv');
      if (!dialog || !dialog.path) return;
      const writeResult = await ApiClient.writeFile(dialog.path, csvText);
      if (writeResult.ok) {
        showToast('エクスポート完了', 'success');
      } else {
        showToast('ファイル保存に失敗しました', 'error');
      }
    } catch (_) {
      showToast('エクスポートに失敗しました', 'error');
    }
  }

  async function importCsv() {
    const project = window.appState.getProject();
    if (!project) return;
    try {
      const dialog = await ApiClient.openFileDialog([['CSV ファイル', '*.csv']]);
      if (!dialog || !dialog.path) return;
      const data = await ApiClient.post(`/api/projects/${project.id}/sources/import-native`, { path: dialog.path });
      showToast(`${data.imported} 件インポートしました`, 'success');
      const updated = await ApiClient.get(`/api/projects/${project.id}`);
      window.appState.setProject(updated);
    } catch (_) {
      showToast('インポートに失敗しました', 'error');
    }
  }

  function reset() {
    _project = null;
    _activeId = null;
    _sectionCollapsed = {};
  }

  return { render, bindEvents, exportCsv, importCsv, reset };
})();
