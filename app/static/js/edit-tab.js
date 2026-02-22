/**
 * EditTab — アウトライン・ドキュメントビュー・文献/図表挿入（タスク 11）
 */

const EditTab = (() => {
  let _project = null;
  let _saveTimer = {};

  function render(project) {
    _project = project;
    _renderOutline();
    _renderDocView();
    _renderScopeSelect();
  }

  // ─── アウトラインパネル ─────────────────────────────────

  function _renderOutline() {
    const list = document.getElementById('outline-list');
    list.innerHTML = '';
    const sorted = [..._project.sections].sort((a, b) => a.order - b.order);

    sorted.forEach(sec => {
      const depth = _sectionDepth(sec, _project.sections);
      const li = document.createElement('li');
      li.className = `outline-item level-${depth}`;
      li.dataset.id = sec.id;
      li.innerHTML = `
        <span class="item-title">${escHtml(sec.title)}</span>
        <span class="item-actions">
          <button class="btn-icon btn-sm" data-action="up" title="上へ">↑</button>
          <button class="btn-icon btn-sm" data-action="down" title="下へ">↓</button>
          <button class="btn-icon btn-sm" data-action="edit" title="編集">⚙</button>
          <button class="btn-icon btn-sm" data-action="delete" title="削除">×</button>
        </span>
      `;

      li.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
        e.stopPropagation();
        _editSectionMeta(sec);
      });
      li.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        _deleteSection(sec);
      });
      li.querySelector('[data-action="up"]').addEventListener('click', (e) => {
        e.stopPropagation();
        _moveSection(sec, -1);
      });
      li.querySelector('[data-action="down"]').addEventListener('click', (e) => {
        e.stopPropagation();
        _moveSection(sec, 1);
      });

      li.addEventListener('click', () => {
        const el = document.getElementById(`sec-block-${sec.id}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        window.appState.setState({ activeSectionId: sec.id });
      });

      list.appendChild(li);
    });
  }

  // ─── ドキュメントビュー ─────────────────────────────────

  function _renderDocView() {
    const container = document.getElementById('doc-sections');
    container.innerHTML = '';
    const sorted = [..._project.sections].sort((a, b) => a.order - b.order);

    sorted.forEach(sec => {
      const depth = _sectionDepth(sec, _project.sections);
      const block = document.createElement('div');
      block.className = 'section-block';
      block.id = `sec-block-${sec.id}`;

      const tag = depth === 1 ? 'h2' : depth === 2 ? 'h3' : 'h4';
      block.innerHTML = `
        <div class="section-header">
          <${tag}>${escHtml(sec.title)}</${tag}>
          <div class="insert-buttons">
            <button class="btn btn-sm btn-secondary" data-action="insert-ref" title="文献挿入">文献</button>
            <button class="btn btn-sm btn-secondary" data-action="insert-fig" title="図表挿入">図表</button>
          </div>
        </div>
        <div class="section-summary" contenteditable="true" data-sec-id="${sec.id}" data-field="summary">${escHtml(sec.summary)}</div>
        <div class="section-content" contenteditable="true" data-sec-id="${sec.id}" data-field="content">${escHtml(sec.content)}</div>
      `;

      // 概要・本文の変更保存（デバウンス）
      ['summary', 'content'].forEach(field => {
        const el = block.querySelector(`[data-field="${field}"]`);
        el.addEventListener('input', () => _debounceSave(sec.id, field, el));
      });

      // 文献・図表挿入
      block.querySelector('[data-action="insert-ref"]').addEventListener('click', () =>
        _showInsertRefDialog(sec.id)
      );
      block.querySelector('[data-action="insert-fig"]').addEventListener('click', () =>
        _showInsertFigDialog(sec.id)
      );

      container.appendChild(block);
    });
  }

  function _debounceSave(sectionId, field, el) {
    const key = `${sectionId}-${field}`;
    clearTimeout(_saveTimer[key]);
    _saveTimer[key] = setTimeout(async () => {
      const project = window.appState.getProject();
      if (!project) return;
      const value = el.innerText;
      try {
        const updated = await ApiClient.put(
          `/api/projects/${project.id}/sections/${sectionId}`,
          { [field]: value }
        );
        // セクションをメモリ更新（画面再描画なし）
        const sec = project.sections.find(s => s.id === sectionId);
        if (sec) sec[field] = value;
      } catch (_) {}
    }, 800);
  }

  // ─── セクション操作 ─────────────────────────────────────

  async function _editSectionMeta(sec) {
    const newTitle = prompt('セクションタイトル:', sec.title);
    if (newTitle === null) return;
    const newSummary = prompt('概要:', sec.summary);
    if (newSummary === null) return;

    const project = window.appState.getProject();
    const updated = await ApiClient.put(
      `/api/projects/${project.id}/sections/${sec.id}`,
      { title: newTitle, summary: newSummary }
    );
    sec.title = newTitle;
    sec.summary = newSummary;
    _renderOutline();
    const titleEl = document.querySelector(`#sec-block-${sec.id} h2,#sec-block-${sec.id} h3,#sec-block-${sec.id} h4`);
    if (titleEl) titleEl.textContent = newTitle;
  }

  async function _deleteSection(sec) {
    if (!confirm(`「${sec.title}」を削除しますか？`)) return;
    const project = window.appState.getProject();

    const oldSecs = [...project.sections];
    project.sections = project.sections.filter(s => s.id !== sec.id);
    _renderOutline();
    document.getElementById(`sec-block-${sec.id}`)?.remove();

    UndoRedoManager.push({
      do: async () => {
        await ApiClient.delete(`/api/projects/${project.id}/sections/${sec.id}`);
      },
      undo: async () => {
        const restored = await ApiClient.post(`/api/projects/${project.id}/sections`, {
          title: sec.title, summary: sec.summary, content: sec.content,
          parent_id: sec.parent_id, order: sec.order,
        });
        project.sections = oldSecs;
        render(project);
      },
    });

    await ApiClient.delete(`/api/projects/${project.id}/sections/${sec.id}`);
  }

  async function _moveSection(sec, direction) {
    const project = window.appState.getProject();
    const siblings = project.sections
      .filter(s => s.parent_id === sec.parent_id)
      .sort((a, b) => a.order - b.order);

    const idx = siblings.findIndex(s => s.id === sec.id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;

    const swapSec = siblings[swapIdx];
    [sec.order, swapSec.order] = [swapSec.order, sec.order];

    await ApiClient.post(`/api/projects/${project.id}/sections/reorder`,
      siblings.map(s => ({ section_id: s.id, parent_id: s.parent_id, order: s.order }))
    );
    _renderOutline();
    _renderDocView();
  }

  // ─── セクション追加ボタン ──────────────────────────────

  async function _addChapter() {
    const project = window.appState.getProject();
    const title = prompt('章タイトル:');
    if (!title) return;
    const maxOrder = project.sections.filter(s => !s.parent_id)
      .reduce((m, s) => Math.max(m, s.order), -1);
    const sec = await ApiClient.post(`/api/projects/${project.id}/sections`, {
      title, parent_id: null, order: maxOrder + 1,
    });
    project.sections.push(sec);
    _renderOutline();
    _renderDocView();
  }

  async function _addSection() {
    const project = window.appState.getProject();
    const activeId = window.appState.getState().activeSectionId;
    const activeSec = project.sections.find(s => s.id === activeId);
    const parentId = activeSec ? (activeSec.parent_id ? activeSec.parent_id : activeSec.id) : null;
    const title = prompt('節タイトル:');
    if (!title) return;
    const siblings = project.sections.filter(s => s.parent_id === parentId);
    const maxOrder = siblings.reduce((m, s) => Math.max(m, s.order), -1);
    const sec = await ApiClient.post(`/api/projects/${project.id}/sections`, {
      title, parent_id: parentId, order: maxOrder + 1,
    });
    project.sections.push(sec);
    _renderOutline();
    _renderDocView();
  }

  // ─── 文献・図表挿入ダイアログ ──────────────────────────

  function _showInsertRefDialog(sectionId) {
    const project = window.appState.getProject();
    if (!project.sources.length) { showToast('ソースがありません', 'error'); return; }
    const choice = prompt(
      'ソース ID を選択:\n' +
      project.sources.map(s => `${s.id}: ${s.name}`).join('\n')
    );
    if (!choice) return;
    const src = project.sources.find(s => s.id === choice || s.name === choice);
    if (!src) { showToast('ソースが見つかりません', 'error'); return; }
    _insertAtCursor(`[^${src.id}]`);
  }

  function _showInsertFigDialog(sectionId) {
    const project = window.appState.getProject();
    if (!project.materials.length) { showToast('マテリアルがありません', 'error'); return; }
    const choice = prompt(
      'マテリアル ID を選択:\n' +
      project.materials.map(m => `${m.id}: ${m.name}`).join('\n')
    );
    if (!choice) return;
    const mat = project.materials.find(m => m.id === choice || m.name === choice);
    if (!mat) { showToast('マテリアルが見つかりません', 'error'); return; }
    const caption = prompt('キャプション:', mat.caption || mat.name);
    if (caption === null) return;
    const filePath = mat.file_path || '';
    _insertAtCursor(`![${caption}](${filePath} "${mat.id}")`);
  }

  function _insertAtCursor(text) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    sel.collapseToEnd();
  }

  // ─── コンテキストスコープセレクト ─────────────────────

  function _renderScopeSelect() {
    const sel = document.getElementById('chat-scope');
    sel.innerHTML = '<option value="all">全セクション(骨子)</option>';
    (_project?.sections || []).sort((a, b) => a.order - b.order).forEach(sec => {
      const opt = document.createElement('option');
      opt.value = sec.id;
      opt.textContent = sec.title;
      sel.appendChild(opt);
    });
  }

  // ─── ユーティリティ ────────────────────────────────────

  function _sectionDepth(sec, allSections) {
    const byId = Object.fromEntries(allSections.map(s => [s.id, s]));
    let d = 1, pid = sec.parent_id;
    while (pid && byId[pid]) { d++; pid = byId[pid].parent_id; }
    return d;
  }

  // ─── イベントバインド ──────────────────────────────────

  function bindEvents() {
    document.getElementById('btn-add-chapter').addEventListener('click', _addChapter);
    document.getElementById('btn-add-section').addEventListener('click', _addSection);
  }

  return { render, bindEvents };
})();
