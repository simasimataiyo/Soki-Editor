/**
 * SourceTab — ソース管理 UI（タスク 12）
 */

const SourceTab = (() => {
  let _project = null;
  let _activeId = null;

  const BIB_TYPE_LABELS = {
    paper: '論文', book: '図書', book_chapter: '図書の一部', web: 'Web'
  };

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
      li.innerHTML = `<div style="font-weight:600;font-size:13px">${escHtml(src.name)}</div>
        <div style="font-size:11px;color:var(--color-text-muted)">${src.id}</div>`;
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
      <div class="source-form">
        <div class="form-group">
          <label>名前</label>
          <input type="text" class="form-control" id="src-name" value="${escHtml(src.name)}" />
        </div>
        <div class="form-group">
          <label>文献種別</label>
          <select class="form-control" id="src-bib-type">
            ${Object.entries(BIB_TYPE_LABELS).map(([v, l]) =>
              `<option value="${v}" ${b.type===v?'selected':''}>${l}</option>`
            ).join('')}
          </select>
        </div>
        <div class="bib-fields" id="bib-fields"></div>
        <div class="toggle-group">
          <label>参考文献リストに掲載</label>
          <input type="checkbox" id="src-include" ${b.include_in_references?'checked':''} />
        </div>
        <div class="form-group">
          <label>全文</label>
          <textarea class="form-control" id="src-full-text" rows="6">${escHtml(src.full_text)}</textarea>
        </div>
        <div class="form-group">
          <label>要約</label>
          <textarea class="form-control" id="src-summary" rows="3">${escHtml(src.summary)}</textarea>
        </div>
        <div class="source-actions">
          <button class="btn btn-sm btn-secondary" id="btn-read-file">ファイル読み込み</button>
          <button class="btn btn-sm btn-secondary" id="btn-analyze-image">画像解析</button>
          <button class="btn btn-sm btn-secondary" id="btn-summarize">ソースから要約生成</button>
          <button class="btn btn-sm btn-primary" id="btn-save-source">保存</button>
          <button class="btn btn-sm btn-danger" id="btn-delete-source">削除</button>
        </div>
      </div>
    `;

    _renderBibFields(b.type);

    document.getElementById('src-bib-type').addEventListener('change', (e) => {
      _renderBibFields(e.target.value);
    });

    document.getElementById('btn-save-source').addEventListener('click', () => _saveSource(src));
    document.getElementById('btn-delete-source').addEventListener('click', () => _deleteSource(src));
    document.getElementById('btn-read-file').addEventListener('click', () => _readFile(src));
    document.getElementById('btn-analyze-image').addEventListener('click', () => _analyzeImage(src));
    document.getElementById('btn-summarize').addEventListener('click', () => _summarize(src));
  }

  function _renderBibFields(type) {
    const container = document.getElementById('bib-fields');
    if (!container) return;
    const src = _project.sources.find(s => s.id === _activeId);
    const b = src?.bibliography || {};
    const fieldSets = {
      paper: ['title', 'author', 'journal', 'volume', 'issue', 'pages', 'year'],
      book: ['title', 'author', 'year', 'publisher', 'publication_place'],
      book_chapter: ['title', 'author', 'year', 'publisher', 'editor', 'pages'],
      web: ['title', 'author', 'url', 'site_name', 'accessed_date'],
    };
    const labels = {
      title:'タイトル', author:'著者', journal:'雑誌名', volume:'巻', issue:'号',
      pages:'ページ', year:'年', publisher:'出版社', publication_place:'出版地',
      editor:'編者', url:'URL', site_name:'サイト名', accessed_date:'参照日',
    };
    container.innerHTML = (fieldSets[type] || []).map(f => `
      <div class="form-group">
        <label>${labels[f] || f}</label>
        <input type="text" class="form-control bib-field" data-field="${f}" value="${escHtml(b[f] || '')}" />
      </div>
    `).join('');
  }

  async function _saveSource(src) {
    const project = window.appState.getProject();
    const bibType = document.getElementById('src-bib-type').value;
    const bibFields = {};
    document.querySelectorAll('.bib-field').forEach(el => {
      bibFields[el.dataset.field] = el.value;
    });

    const body = {
      name: document.getElementById('src-name').value,
      full_text: document.getElementById('src-full-text').value,
      summary: document.getElementById('src-summary').value,
      bibliography: {
        ...src.bibliography,
        type: bibType,
        include_in_references: document.getElementById('src-include').checked,
        ...bibFields,
      },
    };

    try {
      const updated = await ApiClient.put(`/api/projects/${project.id}/sources/${src.id}`, body);
      const idx = project.sources.findIndex(s => s.id === src.id);
      if (idx >= 0) project.sources[idx] = updated;
      showToast('保存しました', 'success');
      _renderList();
    } catch (_) {}
  }

  async function _deleteSource(src) {
    if (!confirm(`「${src.name}」を削除しますか？`)) return;
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

    document.getElementById('btn-source-export').addEventListener('click', async () => {
      const project = window.appState.getProject();
      if (!project) return;
      window.location.href = `/api/projects/${project.id}/sources/export`;
    });

    document.getElementById('btn-source-import').addEventListener('click', async () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const project = window.appState.getProject();
        const formData = new FormData();
        formData.append('file', file);
        try {
          const res = await fetch(`/api/projects/${project.id}/sources/import`, {
            method: 'POST', body: formData,
          });
          const data = await res.json();
          showToast(`${data.imported} 件インポートしました`, 'success');
          const updated = await ApiClient.get(`/api/projects/${project.id}`);
          window.appState.setProject(updated);
        } catch (_) {}
      };
      input.click();
    });
  }

  return { render, bindEvents };
})();
