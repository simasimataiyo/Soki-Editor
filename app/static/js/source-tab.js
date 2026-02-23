/**
 * SourceTab — ソース管理 UI（タスク 12）
 */

const SourceTab = (() => {
  let _project = null;
  let _activeId = null;

  const BIB_TYPE_LABELS = {
    paper: '論文', book: '図書', book_chapter: '図書の一部', web: 'Web', resource: 'リソース'
  };

  // 折りたたみ状態
  let _sectionCollapsed = {};
  let _loadingOverlay = null;

  /** 表示用タイトル: 文献情報のタイトル → name のフォールバック */
  function _displayTitle(src) {
    return src.bibliography?.title || src.name;
  }

  async function _editSourceName(src) {
    const result = await Modal.form('ソース編集', [
      { name: 'name', label: '名前', type: 'text', value: src.name }
    ], {
      confirmText: '保存',
      extraButtons: [
        {
          id: 'delete',
          label: '削除',
          className: 'btn-danger',
          onClick: async (_formData, overlay, resolve, closeModal) => {
            await _deleteSource(src);
            resolve(null);
            closeModal(overlay);
          },
        },
      ],
    });
    if (result === null) return;

    const newName = result.name.trim();
    if (!newName || newName === src.name) return;

    const project = window.appState.getProject();
    try {
      const updated = await ApiClient.put(
        `/api/projects/${project.id}/sources/${src.id}`,
        { name: newName }
      );
      src.name = newName;
      const idx = project.sources.findIndex(s => s.id === src.id);
      if (idx >= 0) project.sources[idx] = updated;
      _renderList();
      if (_activeId === src.id) {
        const h2 = document.querySelector('.detail-title-bar h2');
        if (h2) h2.textContent = _displayTitle(src);
      }
    } catch (_) {}
  }

  /** ローディングオーバーレイを表示 */
  function _showLoading(message = '処理中...') {
    if (_loadingOverlay) return;
    _loadingOverlay = document.createElement('div');
    _loadingOverlay.className = 'loading-overlay';
    _loadingOverlay.innerHTML = `
      <div class="loading-spinner"></div>
      <div class="loading-message">${escHtml(message)}</div>
    `;
    document.body.appendChild(_loadingOverlay);
  }

  /** ローディングオーバーレイを非表示 */
  function _hideLoading() {
    if (_loadingOverlay) {
      _loadingOverlay.remove();
      _loadingOverlay = null;
    }
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
      // ダブルクリックでタイトル編集
      li.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        _editSourceName(src);
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
              <button class="btn btn-secondary btn-sm" id="btn-extract-bib">文献情報取得</button>
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
              <div class="source-drop-area">
                <div class="drag-drop-overlay">ここにファイルをドラッグアンドドロップ</div>
                <textarea class="form-control" id="src-full-text" rows="10">${escHtml(src.full_text)}</textarea>
              </div>
            </div>
            <div class="form-group" style="margin-bottom:12px">
              <label>ファイルパス</label>
              <input type="text" class="form-control" id="src-file-path" value="${escHtml(src.file_path || '')}" readonly />
            </div>
            <div class="source-actions">
              <button class="btn btn-secondary btn-sm" id="btn-analyze-image">画像認識</button>
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
    document.getElementById('btn-extract-bib').addEventListener('click', () => _extractBibliography(src));

    // 内容テキストエリアへのドラッグ&ドロップ
    const dropAreaEl = pane.querySelector('.source-drop-area');
    if (dropAreaEl) {
      dropAreaEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        dropAreaEl.classList.add('drag-over');
      });
      dropAreaEl.addEventListener('dragleave', () => {
        dropAreaEl.classList.remove('drag-over');
      });
      dropAreaEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropAreaEl.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (!file) return;
        const project = window.appState.getProject();
        const formData = new FormData();
        formData.append('file', file);
        _showLoading('PDFを読み込み中...');
        try {
          const res = await fetch(
            `/api/projects/${project.id}/sources/${src.id}/read-file-upload`,
            { method: 'POST', body: formData }
          );
          if (!res.ok) { showToast('読み込み失敗', 'error'); return; }
          const updated = await res.json();
          const idx = project.sources.findIndex(s => s.id === src.id);
          if (idx >= 0) project.sources[idx] = updated;
          // PDFを再読み込みした場合は画像認識モーダルを閉じる（サムネイルが更新されるため）
          const modalOverlay = document.querySelector('.modal-overlay');
          if (modalOverlay && modalOverlay.querySelector('.pdf-page-grid')) {
            modalOverlay.remove();
          }
          _renderDetail(src.id);
          showToast('ファイルを読み込みました', 'success');
        } catch (_) {
          showToast('ファイル読み込みに失敗しました', 'error');
        } finally {
          _hideLoading();
        }
      });
    }

    // 自動保存（デバウンス）
    let saveTimer;
    const autoSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => _saveSource(src.id), 2000);
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
      resource: ['title', 'author', 'created_date', 'other'],
    };
    const labels = {
      title:'タイトル', author:'著者', journal:'掲載誌', volume:'巻数', issue:'号数',
      pages:'ページ', year:'出版年', publisher:'出版社', publication_place:'出版地',
      editor:'編者', url:'URL', site_name:'サイト名', accessed_date:'参照日',
      created_date:'作成日', other:'その他',
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
        timer = setTimeout(() => _saveSource(src.id), 2000);
        // タイトル変更時は最新のソースオブジェクトを使用
        if (el.dataset.field === 'title') {
          const project = window.appState.getProject();
          const currentSrc = project.sources.find(s => s.id === src.id);
          if (currentSrc) {
            currentSrc.bibliography.title = el.value;
            _renderList();
            const h2 = document.querySelector('.detail-title-bar h2');
            if (h2) h2.textContent = _displayTitle(currentSrc);
          }
        }
      });
    });
  }

  async function _saveSource(srcId) {
    const project = window.appState.getProject();
    const src = project.sources.find(s => s.id === srcId);
    if (!src) return;

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
      _showLoading('PDFを読み込み中...');
      try {
        const res = await fetch(`/api/projects/${project.id}/sources/${src.id}/read-file-upload`, {
          method: 'POST', body: formData,
        });
        if (!res.ok) { const d = await res.json(); showToast(d.detail || 'エラー', 'error'); return; }
        const updated = await res.json();
        const idx = project.sources.findIndex(s => s.id === src.id);
        if (idx >= 0) project.sources[idx] = updated;
        // PDFを再読み込みした場合は画像認識モーダルを閉じる（サムネイルが更新されるため）
        const modalOverlay = document.querySelector('.modal-overlay');
        if (modalOverlay && modalOverlay.querySelector('.pdf-page-grid')) {
          modalOverlay.remove();
        }
        _renderDetail(src.id);
        showToast('ファイルを読み込みました', 'success');
      } catch (_) {
        showToast('ファイル読み込みに失敗しました', 'error');
      } finally {
        _hideLoading();
      }
    };
    input.click();
  }

  async function _analyzeImage(src) {
    const project = window.appState.getProject();

    // PDFソースの場合は保存済みサムネイルを使ってページ選択
    if (src.file_type === 'pdf') {
      await _analyzeSavedPdfPages(src);
      return;
    }

    // 画像ファイルの場合はファイルピッカー経由
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.jpg,.jpeg,.pdf';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      // PDFの場合はページ選択フローへ（ファイルアップロード版）
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

  /** 保存済みサムネイルを使ってPDFページを選択し、Vision解析する */
  async function _analyzeSavedPdfPages(src) {
    const project = window.appState.getProject();

    let pageList;
    try {
      const res = await fetch(`/api/projects/${project.id}/sources/${src.id}/pdf-page-list`);
      if (!res.ok) { showToast('サムネイル取得失敗', 'error'); return; }
      pageList = await res.json();
    } catch (_) {
      showToast('サムネイル取得に失敗しました', 'error');
      return;
    }

    if (!pageList || pageList.total === 0) {
      showToast('ページが見つかりません。先に「ファイル読み込み」でPDFを読み込んでください。', 'error');
      return;
    }

    const thumbnails = pageList.pages.map(p => ({
      page: p.page,
      label: p.label,
      src: `/api/files?path=${encodeURIComponent(p.thumbnail_path)}&project_id=${project.id}`,
    }));

    _showPdfAnalysisModal(src, thumbnails, null);
  }

  async function _analyzePdfWithPageSelection(src, file) {
    const project = window.appState.getProject();
    showToast('PDFを読み込み中...', 'success');

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

    _showPdfAnalysisModal(src, thumbnails, file);
  }

  /**
   * PDF画像解析モーダル（ページ選択 → ストリーミング解析 → 結果確認）
   * @param {object} src - ソースオブジェクト
   * @param {Array} thumbnails - {page, label, src|data} の配列
   * @param {File|null} pdfFile - アップロード版の場合はFileオブジェクト、保存済み版はnull
   */
  function _showPdfAnalysisModal(src, thumbnails, pdfFile) {
    const project = window.appState.getProject();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.maxWidth = '700px';
    modal.style.width = '90vw';
    modal.style.maxHeight = '85vh';
    modal.style.overflowY = 'auto';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let abortController = null;

    function _closeModal() {
      if (abortController) abortController.abort();
      overlay.remove();
    }

    // ── ページ選択画面 ────────────────────────────────────────
    function _showPageSelect() {
      const thumbsHtml = thumbnails.map(t => `
        <label class="pdf-page-thumb">
          <input type="radio" name="pdf-page-radio" value="${t.page}" />
          <img src="${escHtml(t.src || t.data || '')}" alt="${escHtml(t.label)}" />
          <span class="pdf-page-label">${escHtml(t.label)}</span>
        </label>
      `).join('');

      modal.innerHTML = `
        <div class="pdf-modal-header">
          <h3>ページを選択</h3>
          <button class="pdf-modal-close" title="閉じる">×</button>
        </div>
        <p style="color:var(--color-text-muted);font-size:13px;margin-bottom:12px">解析するページを1つ選択してください</p>
        <div class="pdf-page-grid">${thumbsHtml}</div>
        <div class="modal-actions" style="margin-top:16px">
          <button class="btn btn-primary" id="pdf-modal-confirm">解析実行</button>
        </div>
      `;

      modal.querySelectorAll('.pdf-page-thumb input[type="radio"]').forEach(rb => {
        rb.addEventListener('change', () => {
          modal.querySelectorAll('.pdf-page-thumb').forEach(l => l.classList.remove('selected'));
          rb.closest('.pdf-page-thumb').classList.add('selected');
        });
      });

      modal.querySelector('.pdf-modal-close').addEventListener('click', _closeModal);

      modal.querySelector('#pdf-modal-confirm').addEventListener('click', () => {
        const checked = modal.querySelector('input[name="pdf-page-radio"]:checked');
        if (!checked) { showToast('ページを選択してください', 'error'); return; }
        _startAnalysis(parseInt(checked.value));
      });
    }

    // ── 解析実行（ストリーミング）────────────────────────────
    async function _startAnalysis(pageNum) {
      if (abortController) abortController.abort();
      abortController = new AbortController();

      modal.innerHTML = `
        <div class="pdf-modal-header">
          <h3>解析中... (p.${pageNum + 1})</h3>
          <button class="pdf-modal-close" title="閉じる">×</button>
        </div>
        <div class="pdf-analysis-progress">
          <div class="pdf-analysis-spinner"></div>
          <span>LLMが解析しています...</span>
        </div>
        <div class="pdf-analysis-result" id="pdf-analysis-text"></div>
      `;

      modal.querySelector('.pdf-modal-close').addEventListener('click', _closeModal);

      const resultEl = modal.querySelector('#pdf-analysis-text');
      let fullText = '';

      try {
        let streamUrl, streamOptions;

        if (pdfFile) {
          const formData = new FormData();
          formData.append('file', pdfFile);
          formData.append('page', String(pageNum));
          streamUrl = `/api/projects/${project.id}/sources/${src.id}/analyze-pdf-page-stream`;
          streamOptions = { method: 'POST', body: formData, signal: abortController.signal };
        } else {
          streamUrl = `/api/projects/${project.id}/sources/${src.id}/analyze-saved-pdf-page-stream`;
          streamOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page: pageNum }),
            signal: abortController.signal,
          };
        }

        const res = await fetch(streamUrl, streamOptions);
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.detail || '解析に失敗しました');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') {
              _showResult(pageNum, fullText);
              return;
            }
            try {
              const parsed = JSON.parse(payload);
              if (parsed.error) throw new Error(parsed.error);
              if (parsed.text) {
                fullText += parsed.text;
                resultEl.textContent = fullText;
                resultEl.scrollTop = resultEl.scrollHeight;
              }
            } catch (e) {
              if (!(e instanceof SyntaxError)) throw e;
            }
          }
        }

        // ストリームが [DONE] なしで終了した場合も表示へ
        _showResult(pageNum, fullText);

      } catch (e) {
        if (e.name === 'AbortError') return;
        const errEl = document.createElement('p');
        errEl.style.cssText = 'color:var(--color-danger);margin-top:8px;font-size:13px';
        errEl.textContent = `エラー: ${e.message}`;
        modal.appendChild(errEl);
        // エラー時もアクションボタンを表示
        _showResult(pageNum, fullText, true);
      }
    }

    // ── 解析結果確認画面 ─────────────────────────────────────
    function _showResult(pageNum, analysisText, isError = false) {
      // ヘッダーを更新
      const h3 = modal.querySelector('h3');
      if (h3) h3.textContent = isError ? `解析エラー (p.${pageNum + 1})` : `解析完了 (p.${pageNum + 1})`;

      // スピナーを除去
      const progress = modal.querySelector('.pdf-analysis-progress');
      if (progress) progress.remove();

      // アクションボタンを追加
      const existing = modal.querySelector('.pdf-result-actions');
      if (existing) existing.remove();

      const actions = document.createElement('div');
      actions.className = 'modal-actions pdf-result-actions';
      actions.style.marginTop = '16px';
      actions.innerHTML = `
        <button class="btn btn-secondary" id="pdf-btn-back">ページ選択に戻る</button>
        <button class="btn btn-secondary" id="pdf-btn-retry">再実行</button>
        <button class="btn btn-primary" id="pdf-btn-add"${!analysisText || isError ? ' disabled' : ''}>内容に追加</button>
      `;
      modal.appendChild(actions);

      modal.querySelector('#pdf-btn-back').addEventListener('click', () => _showPageSelect());
      modal.querySelector('#pdf-btn-retry').addEventListener('click', () => _startAnalysis(pageNum));

      if (analysisText && !isError) {
        modal.querySelector('#pdf-btn-add').addEventListener('click', async () => {
          const currentText = src.full_text || '';
          const separator = currentText ? '\n\n' : '';
          const newText = currentText + separator + `--- ${pageNum + 1}ページ目 ---\n${analysisText}`;

          try {
            const updated = await ApiClient.put(
              `/api/projects/${project.id}/sources/${src.id}`,
              { full_text: newText }
            );
            const idx = project.sources.findIndex(s => s.id === src.id);
            if (idx >= 0) project.sources[idx] = updated;
            src.full_text = updated.full_text;
            // 詳細ペインのテキストエリアを直接更新
            const ta = document.getElementById('src-full-text');
            if (ta) ta.value = updated.full_text;
            showToast('内容に追加しました', 'success');
            _showPageSelect();
          } catch (_) {
            showToast('保存に失敗しました', 'error');
          }
        });
      }
    }

    // 初期表示
    _showPageSelect();
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

  async function _extractBibliography(src) {
    const project = window.appState.getProject();
    if (!(await Modal.confirm('LLMを使用して文献情報を抽出します。実行しますか？'))) return;
    showToast('文献情報抽出中...', 'success');
    try {
      const updated = await ApiClient.post(
        `/api/projects/${project.id}/sources/${src.id}/extract-bibliography`
      );
      const idx = project.sources.findIndex(s => s.id === src.id);
      if (idx >= 0) project.sources[idx] = updated;
      _renderDetail(src.id);
      showToast('文献情報を抽出しました', 'success');
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
