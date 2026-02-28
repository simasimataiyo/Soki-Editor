/**
 * EditTab — アウトライン・ドキュメントビュー・文献/図表挿入（タスク 11）
 */

const EditTab = (() => {
  let _project = null;
  let _dragState = null;  // ドラッグ操作状態
  let _savedTiptapPos = null; // モーダル表示前のカーソル位置保存用（Tiptap ProseMirror位置）

  // Tiptapのupdateイベントハンドラ管理
  let _tiptapUpdateTimer = null;
  let _tiptapUpdateHandler = null;

  /**
   * EditTabを初期化してUIを描画する
   * Tiptapが未初期化の場合は tiptap-ready イベントを待つ
   * @param {object} project - プロジェクトオブジェクト
   */
  function render(project) {
    _project = project;
    _renderOutline();

    if (window.TiptapEditor && window.TiptapEditor.getEditor()) {
      _renderDocView();
      _registerTiptapUpdateHandler();
    } else {
      // type="module" スクリプトの遅延読み込みに対応
      document.addEventListener('tiptap-ready', () => {
        _renderDocView();
        _registerTiptapUpdateHandler();
      }, { once: true });
    }

    _initReferencesCheckbox(project);
    _updateCharCount();
  }

  /**
   * Tiptapのupdateイベントハンドラを登録する
   * render()が呼ばれるたびに旧ハンドラを解除して再登録する
   */
  function _registerTiptapUpdateHandler() {
    const editor = window.TiptapEditor.getEditor();
    if (!editor) return;

    if (_tiptapUpdateHandler) editor.off('update', _tiptapUpdateHandler);

    _tiptapUpdateHandler = () => {
      if (window.TiptapEditor._suppressUpdate) return;

      // parseSections → in-memoryを即時更新（文字数カウント用）
      const parsed = window.TiptapEditor.parseSections();
      for (const p of parsed) {
        if (!p.id) continue;
        const sec = _project.sections.find(s => s.id === p.id);
        if (sec) {
          sec.content = p.content;
          sec.title = p.title;
        }
      }
      _updateCharCount();

      // 2秒debounceでAPIに保存
      clearTimeout(_tiptapUpdateTimer);
      _tiptapUpdateTimer = setTimeout(() => {
        const project = window.appState.getProject();
        if (!project) return;
        _syncTiptapToBackend(parsed, project);
      }, 2000);
    };

    editor.on('update', _tiptapUpdateHandler);
  }

  /**
   * TiptapのパースデータをバックエンドAPIにdiff保存する
   * 変更のあるセクションのみPUTリクエストを送る
   */
  async function _syncTiptapToBackend(parsedSections, project) {
    for (const p of parsedSections) {
      if (!p.id) continue; // IDなし見出し（ユーザーが手動追加）はスキップ
      const existing = project.sections.find(s => s.id === p.id);
      if (!existing) continue;
      const updates = {};
      if (p.content !== existing.content) updates.content = p.content;
      if (p.title !== existing.title) updates.title = p.title;
      if (Object.keys(updates).length === 0) continue;
      try {
        await ApiClient.put(`/api/projects/${project.id}/sections/${p.id}`, updates);
        Object.assign(existing, updates);
      } catch (_) { }
    }
  }

  /**
   * 「参考文献セクションを表示」チェックボックスを初期化し、変更時にAPIと画面を更新する
   * @param {object} project - プロジェクトオブジェクト
   */
  function _initReferencesCheckbox(project) {
    const checkbox = document.getElementById('references-section-enabled');
    if (!checkbox) return;
    checkbox.checked = project.references_section_enabled || false;
    // 既存のリスナーを置き換えるため、クローンして差し替え
    const newCheckbox = checkbox.cloneNode(true);
    checkbox.parentNode.replaceChild(newCheckbox, checkbox);
    newCheckbox.addEventListener('change', async () => {
      const enabled = newCheckbox.checked;
      await ApiClient.put(`/api/projects/${project.id}/references-section`, {
        enabled,
      });
      // ローカルプロジェクト状態を更新
      const proj = window.appState.getProject();
      if (proj) proj.references_section_enabled = enabled;
      _renderDocView();
    });
  }

  // ─── アウトラインパネル ─────────────────────────────────

  let _collapsed = {};  // アウトライン折りたたみ状態

  /**
   * アウトラインパネル全体を再描画する
   * ルートセクションを取得し、ツリー構造で再帰的にアイテムをレンダリングする
   */
  function _renderOutline() {
    const list = document.getElementById('outline-list');
    list.innerHTML = '';
    const sorted = [..._project.sections].sort((a, b) => a.order - b.order);

    // ツリー構造を構築
    const roots = sorted.filter(s => !s.parent_id);
    roots.forEach(sec => _renderOutlineItem(list, sec, sorted, 1));

    // 何もないところをクリックしたときに全セクション非選択にするイベント
    list.addEventListener('click', (e) => {
      // クリックしたのが outline-item でない場合、全セクション非選択
      if (!e.target.closest('.outline-item')) {
        window.appState.setSelectedSectionId(null);
        _updateDocViewEditMode();
      }
    });
  }

  /**
   * アウトラインの1アイテムをレンダリングし、DnD・クリック・ダブルクリックイベントを設定する
   * @param {HTMLElement} container - 追加先の親要素
   * @param {object} sec - セクションオブジェクト
   * @param {Array} allSorted - order順にソート済みの全セクション配列
   * @param {number} depth - 現在の階層深さ（1始まり）
   */
  function _renderOutlineItem(container, sec, allSorted, depth) {
    const children = allSorted.filter(s => s.parent_id === sec.id);
    const hasChildren = children.length > 0;
    const isCollapsed = _collapsed[sec.id];
    const isSelected = (window.appState.getSelectedSectionId() === sec.id);

    const li = document.createElement('li');
    li.className = `outline-item level-${depth}${isSelected ? ' selected' : ''}`;
    li.dataset.id = sec.id;
    li.draggable = true;

    const toggle = hasChildren
      ? `<span class="outline-toggle" data-action="toggle">${isCollapsed ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>`
      : `<span class="outline-toggle-spacer"></span>`;

    li.innerHTML = `
      ${toggle}
      <span class="item-title">${escHtml(sec.title)}</span>
      <button class="btn-icon item-delete-btn" title="削除">${SVG_DELETE}</button>
    `;

    // ドラッグイベント
    li.addEventListener('dragstart', (e) => {
      _dragState = {
        draggedId: sec.id,
        targetId: null,
        position: null,
      };
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', sec.id);
    });

    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      document.querySelectorAll('.outline-item').forEach(el => {
        el.classList.remove('drag-over-before', 'drag-over-after', 'drag-over-child');
      });
      _dragState = null;
    });

    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!_dragState || _dragState.draggedId === sec.id) return;

      const rect = li.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const height = rect.height;
      const threshold = height / 4;

      // ドロップ位置を判定
      if (y < threshold) {
        _dragState.position = 'before';
        _dragState.targetId = sec.id;
        _updateDragVisuals(sec.id, 'before');
      } else if (y > height - threshold) {
        _dragState.position = 'after';
        _dragState.targetId = sec.id;
        _updateDragVisuals(sec.id, 'after');
      } else {
        _dragState.position = 'child';
        _dragState.targetId = sec.id;
        _updateDragVisuals(sec.id, 'child');
      }
    });

    li.addEventListener('dragleave', (e) => {
      if (!_dragState || _dragState.draggedId === sec.id) return;
      const rect = li.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // 要素の外に出た場合のみクリア
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
        _clearDragVisuals();
      }
    });

    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!_dragState || !_dragState.targetId) return;

      const { draggedId, targetId, position } = _dragState;
      if (draggedId === targetId) return;

      await _handleSectionDrop(draggedId, targetId, position);
    });

    if (hasChildren) {
      li.querySelector('[data-action="toggle"]').addEventListener('click', (e) => {
        e.stopPropagation();
        _collapsed[sec.id] = !_collapsed[sec.id];
        _renderOutline();
      });
    }

    li.addEventListener('click', () => {
      // Tiptapの対応する見出しへスクロール
      const headingEl = document.querySelector(`#tiptap-editor-mount [data-section-id="${sec.id}"]`);
      if (headingEl) {
        const docView = document.getElementById('doc-view');
        if (docView) {
          const mountEl = document.getElementById('tiptap-editor-mount');
          const mountTop = mountEl ? mountEl.offsetTop : 0;
          const offset = headingEl.offsetTop + mountTop;
          docView.scrollTo({ top: Math.max(0, offset - 8), behavior: 'smooth' });
        } else {
          headingEl.scrollIntoView({ block: 'start' });
        }
      }

      // 選択状態を更新
      document.querySelectorAll('.outline-item').forEach(el => {
        el.classList.remove('selected');
        el.classList.remove('active');
      });
      li.classList.add('selected');
      li.classList.add('active');
      window.appState.setSelectedSectionId(sec.id);
      _updateDocViewEditMode();

      AppShell.setCurrentScope(sec.id);
    });

    // ダブルクリックでタイトル編集
    li.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      _editSectionMeta(sec);
    });

    li.querySelector('.item-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      _deleteSection(sec);
    });

    container.appendChild(li);

    // 子要素を再帰的にレンダリング
    if (hasChildren && !isCollapsed) {
      children.sort((a, b) => a.order - b.order).forEach(child => {
        _renderOutlineItem(container, child, allSorted, depth + 1);
      });
    }
  }

  // ─── ドキュメントビュー ─────────────────────────────────

  /**
   * ドキュメントビュー全体を再描画する
   * TiptapにセクションデータをロードしてWYSIWYGビューを更新する
   */
  function _renderDocView() {
    if (!window.TiptapEditor) return;

    // Tiptapにセクションデータをセット
    window.TiptapEditor.setContentFromSections(_project.sections);

    // 参考文献ブロックを#doc-view末尾に表示
    const docView = document.getElementById('doc-view');
    const existingRefBlock = docView.querySelector('.references-block');
    if (existingRefBlock) existingRefBlock.remove();

    if (_project.references_section_enabled) {
      const sorted = [..._project.sections].sort((a, b) => a.order - b.order);
      _renderReferencesBlock(docView, sorted);
    }

    _updateDocViewEditMode();
  }

  /**
   * 参考文献ブロックをドキュメントビューの末尾に描画する
   * 本文中の [^ref-xxx] タグを出現順に収集し、番号付きリストとして表示する
   * @param {HTMLElement} container - 追加先の親要素
   * @param {Array} sortedSections - order順にソート済みの全セクション配列
   */
  function _renderReferencesBlock(container, sortedSections) {
    // 本文中の [^ref-xxx] を出現順に収集
    const refPattern = /\[\^(ref-[^\]]+)\]/g;
    const srcById = {};
    (_project.sources || []).forEach(s => {
      if (s.bibliography && s.bibliography.include_in_references) {
        srcById[s.id] = s;
      }
    });

    const refMap = {};
    let counter = 0;
    sortedSections.forEach(sec => {
      let m;
      refPattern.lastIndex = 0;
      while ((m = refPattern.exec(sec.content || '')) !== null) {
        const srcId = m[1];
        if (srcId in srcById && !(srcId in refMap)) {
          counter++;
          refMap[srcId] = counter;
        }
      }
    });

    const entries = Object.entries(refMap).sort((a, b) => a[1] - b[1]);

    const block = document.createElement('div');
    block.className = 'section-block references-block';

    let entriesHtml = '';
    if (entries.length === 0) {
      entriesHtml = '<p class="references-empty">参考文献はまだありません。本文中に [^ref-xxx] 形式で文献を挿入してください。</p>';
    } else {
      entriesHtml = entries.map(([srcId, num]) => {
        const src = srcById[srcId];
        if (!src) return '';
        const bib = src.bibliography;
        const parts = [];
        if (bib.author) parts.push(escHtml(bib.author));
        if (bib.title) parts.push(`『${escHtml(bib.title)}』`);
        if (bib.journal) parts.push(escHtml(bib.journal));
        if (bib.year) parts.push(`(${escHtml(bib.year)})`);
        if (bib.url) parts.push(escHtml(bib.url));
        const text = parts.length ? parts.join(' ') : '(文献情報なし)';
        return `<div class="references-entry">[${num}] ${text}</div>`;
      }).join('');
    }

    block.innerHTML = `
      <div class="section-header references-header">
        <h2 class="section-title">
          <span class="section-bullet">≡</span> 参考文献
        </h2>
        <div class="section-actions" style="opacity:1">
          <button class="btn btn-sm btn-secondary" data-action="refresh-references">リスト更新</button>
        </div>
      </div>
      <div class="section-body references-body">
        ${entriesHtml}
      </div>
    `;

    block.querySelector('[data-action="refresh-references"]').addEventListener('click', (e) => {
      e.stopPropagation();
      _renderDocView();
    });

    container.appendChild(block);
  }


  // ─── セクション操作 ─────────────────────────────────────

  /**
   * セクションのメタ情報（タイトル・親セクション）を編集するモーダルを表示し、変更をAPIに保存する
   * モーダル内に削除ボタンも提供する
   * @param {object} sec - 編集対象のセクションオブジェクト
   */
  async function _editSectionMeta(sec) {
    const project = window.appState.getProject();
    const sections = project.sections;

    // 自分と子孫のIDセットを作成（親選択肢から除外してループを防ぐ）
    function getDescendantIds(id) {
      const children = sections.filter(s => s.parent_id === id);
      return [id, ...children.flatMap(c => getDescendantIds(c.id))];
    }
    const excludeIds = new Set(getDescendantIds(sec.id));

    // 階層順（深さ優先）でソートして親セクション選択肢を構築
    function sortHierarchically(secs) {
      const byParent = {};
      secs.forEach(s => {
        const key = s.parent_id || '__root__';
        if (!byParent[key]) byParent[key] = [];
        byParent[key].push(s);
      });
      Object.values(byParent).forEach(arr => arr.sort((a, b) => a.order - b.order));
      const result = [];
      function visit(parentId) {
        const key = parentId || '__root__';
        (byParent[key] || []).forEach(s => {
          result.push(s);
          visit(s.id);
        });
      }
      visit(null);
      return result;
    }

    const parentOptions = [
      { value: '', label: 'ルート（親なし）' },
      ...sortHierarchically(sections.filter(s => !excludeIds.has(s.id)))
        .map(s => ({
          value: s.id,
          label: '　'.repeat(_sectionDepth(s, sections) - 1) + s.title,
        })),
    ];

    const result = await Modal.form('セクション編集', [
      { name: 'title', label: 'タイトル', type: 'text', value: sec.title },
      { name: 'parent_id', label: '親セクション', type: 'select', value: sec.parent_id || '', options: parentOptions },
    ], {
      confirmText: '保存',
      extraButtons: [
        {
          id: 'delete',
          label: '削除',
          className: 'btn-danger',
          onClick: async (_formData, overlay, resolve, closeModal) => {
            await _deleteSection(sec);
            resolve(null);
            closeModal(overlay);
          },
        },
      ],
    });
    if (result === null) return;

    const newTitle = result.title.trim();
    const newParentId = result.parent_id || null;

    const updateData = {};
    if (newTitle && newTitle !== sec.title) updateData.title = newTitle;
    if (newParentId !== sec.parent_id) {
      updateData.parent_id = newParentId;
      // 新しい親の末尾に追加
      const siblings = sections.filter(s => s.parent_id === newParentId && s.id !== sec.id);
      updateData.order = siblings.length > 0 ? Math.max(...siblings.map(s => s.order)) + 1 : 0;
    }

    if (Object.keys(updateData).length === 0) return;

    await ApiClient.put(
      `/api/projects/${project.id}/sections/${sec.id}`,
      updateData
    );
    if (updateData.title !== undefined) sec.title = updateData.title;
    if ('parent_id' in updateData) {
      sec.parent_id = newParentId;
      sec.order = updateData.order;
    }
    _renderOutline();
    _renderDocView();
  }

  /**
   * 確認ダイアログを表示してセクションを削除する
   * Undo/Redoスタックに操作を積み、削除後は画面を再描画する
   * @param {object} sec - 削除対象のセクションオブジェクト
   */
  async function _deleteSection(sec) {
    if (!(await Modal.confirm(`「${sec.title}」を削除しますか？`))) return;
    const project = window.appState.getProject();

    const oldSecs = [...project.sections];
    project.sections = project.sections.filter(s => s.id !== sec.id);
    _renderOutline();
    _renderDocView();

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

  /**
   * セクションを同じ親の中で上下に移動する
   * 隣接するセクションとorderを入れ替えてAPIに保存する
   * @param {object} sec - 移動対象のセクションオブジェクト
   * @param {number} direction - 移動方向（-1: 上へ、1: 下へ）
   */
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

  /**
   * タイトル入力プロンプトを表示し、ルート直下に新しい章セクションを追加する
   */
  async function _addChapter() {
    const project = window.appState.getProject();
    const title = await Modal.prompt('章を追加', '章タイトルを入力してください');
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

  /**
   * 選択中セクションを考慮して親を自動決定し、新しい節セクションを追加する
   * 選択中セクションがルートなら同じ親、それ以外は選択中を親として追加する
   */
  async function _addSection() {
    const project = window.appState.getProject();
    const activeId = window.appState.getState().activeSectionId;
    const activeSec = project.sections.find(s => s.id === activeId);
    const parentId = activeSec ? (activeSec.parent_id ? activeSec.parent_id : activeSec.id) : null;
    const title = await Modal.prompt('節を追加', '節タイトルを入力してください');
    if (!title) return;
    const siblings = project.sections.filter(s => s.parent_id === parentId);
    const maxOrder = siblings.reduce((m, s) => Math.max(m, s.order), -1);
    const sec = await ApiClient.post(`/api/projects/${project.id}/sections`, {
      title, parent_id: parentId, order: maxOrder + 1,
    });
    project.sections.push(sec);
    _renderOutline();
    _renderDocView();
    ReviewTab.updateSections(_project);
  }

  // ─── 文献・図表挿入ダイアログ ──────────────────────────

  /**
   * 現在のTiptapカーソル位置を _savedTiptapPos に保存する
   */
  function _saveCursorPosition() {
    const editor = window.TiptapEditor && window.TiptapEditor.getEditor();
    if (editor) {
      _savedTiptapPos = editor.state.selection.from;
    } else {
      _savedTiptapPos = null;
    }
  }

  /**
   * ソース選択モーダルを表示し、選択した文献の引用タグをカーソル位置に挿入する
   * @param {string} sectionId - 挿入先のセクションID
   */
  async function _showInsertRefDialog(sectionId) {
    _saveCursorPosition();
    const project = window.appState.getProject();
    if (!project.sources.length) { showToast('ソースがありません', 'error'); return; }
    const items = project.sources.map(s => ({ value: s.id, label: s.bibliography?.title || s.name }));
    const choice = await Modal.select('文献を挿入', 'ソースを選択してください', items, { large: true });
    if (!choice) return;
    const src = project.sources.find(s => s.id === choice);
    if (!src) { showToast('ソースが見つかりません', 'error'); return; }
    _insertAtCursor(sectionId, `[^${src.id}]`);
  }

  /**
   * マテリアル選択モーダルを表示し、選択した図表のMarkdown画像タグをカーソル位置に挿入する
   * @param {string} sectionId - 挿入先のセクションID
   */
  async function _showInsertFigDialog(sectionId) {
    _saveCursorPosition();
    const project = window.appState.getProject();
    if (!project.materials.length) { showToast('マテリアルがありません', 'error'); return; }
    const items = project.materials.map(m => ({ value: m.id, label: m.name }));
    const choice = await Modal.select('図表を挿入', 'マテリアルを選択してください', items, { large: true });
    if (!choice) return;
    const mat = project.materials.find(m => m.id === choice);
    if (!mat) { showToast('マテリアルが見つかりません', 'error'); return; }
    const caption = mat.caption || mat.name;
    const filePath = mat.file_path || '';
    _insertAtCursor(sectionId, `![${caption}](${filePath} "${mat.id}")`);
  }

  /**
   * 保存済みカーソル位置（Tiptap ProseMirror位置）にテキストを挿入する
   * カーソル位置が無効な場合はセクションのコンテンツ末尾に追加する
   * @param {string} sectionId - 挿入先のセクションID
   * @param {string} text - 挿入するテキスト
   */
  function _insertAtCursor(sectionId, text) {
    const editor = window.TiptapEditor && window.TiptapEditor.getEditor();
    if (!editor) return;

    if (_savedTiptapPos !== null) {
      editor.chain().focus().insertContentAt(_savedTiptapPos, text).run();
    } else {
      // フォールバック: セクションのコンテンツ末尾に挿入
      const endPos = window.TiptapEditor.getSectionContentEnd(sectionId);
      if (endPos !== null) {
        editor.chain().focus().insertContentAt(endPos, text).run();
      }
    }
    _savedTiptapPos = null;
    // Tiptapのupdateイベントが自動保存をトリガーする
  }


  // ─── ユーティリティ ────────────────────────────────────

  /**
   * セクションの階層深さを返す（ルートセクションは1）
   * @param {object} sec - 対象セクションオブジェクト
   * @param {Array} allSections - 全セクション配列
   * @returns {number} 階層深さ（1始まり）
   */
  function _sectionDepth(sec, allSections) {
    const byId = Object.fromEntries(allSections.map(s => [s.id, s]));
    let d = 1, pid = sec.parent_id;
    while (pid && byId[pid]) { d++; pid = byId[pid].parent_id; }
    return d;
  }

  // ─── ドラッグアンドドロップ ─────────────────────────────

  /**
   * 指定セクションのアウトラインアイテムにドラッグオーバー視覚効果を適用する
   * @param {string} targetId - ドロップ先セクションID
   * @param {'before'|'after'|'child'} position - ドロップ位置
   */
  function _updateDragVisuals(targetId, position) {
    _clearDragVisuals();
    const targetEl = document.querySelector(`.outline-item[data-id="${targetId}"]`);
    if (targetEl) {
      targetEl.classList.add(`drag-over-${position}`);
    }
  }

  /**
   * 全アウトラインアイテムのドラッグオーバー視覚効果をクリアする
   */
  function _clearDragVisuals() {
    document.querySelectorAll('.outline-item').forEach(el => {
      el.classList.remove('drag-over-before', 'drag-over-after', 'drag-over-child');
    });
  }

  /**
   * ドロップ操作を処理してセクションを移動する
   * ループ検出・新しい親の計算・order再計算・APIコール・ローカル状態更新を行う
   * @param {string} draggedId - ドラッグしたセクションID
   * @param {string} targetId - ドロップ先セクションID
   * @param {'before'|'after'|'child'} position - ドロップ位置
   */
  async function _handleSectionDrop(draggedId, targetId, position) {
    const project = window.appState.getProject();
    const draggedSec = project.sections.find(s => s.id === draggedId);
    const targetSec = project.sections.find(s => s.id === targetId);

    if (!draggedSec || !targetSec) return;

    // ループ検出（自分の先祖を親にできない）
    if (position === 'child') {
      let current = targetSec;
      while (current.parent_id) {
        if (current.parent_id === draggedId) {
          showToast('自分の子孫セクションを親にすることはできません', 'error');
          return;
        }
        current = project.sections.find(s => s.id === current.parent_id);
      }
    }

    // 新しい親を計算
    let newParentId = null;

    if (position === 'child') {
      newParentId = targetSec.id;
    } else if (position === 'before') {
      newParentId = targetSec.parent_id;
    } else { // after
      newParentId = targetSec.parent_id;
    }

    // オーダーを整数に再計算（簡素化）
    // 1. 新しい親の下の兄弟セクションを取得（ドラッグセクションを除外）
    const siblings = project.sections
      .filter(s => s.parent_id === newParentId)
      .filter(s => s.id !== draggedId)
      .sort((a, b) => a.order - b.order);

    // 2. ドラッグセクションの挿入位置を特定
    let insertIndex = 0;
    if (position === 'before') {
      insertIndex = siblings.findIndex(s => s.id === targetId);
    } else if (position === 'after') {
      insertIndex = siblings.findIndex(s => s.id === targetId) + 1;
    } else { // child
      insertIndex = siblings.length;
    }

    // 3. 全体のオーダーを再計算
    const allSections = [
      ...siblings.slice(0, insertIndex),
      { id: draggedId },
      ...siblings.slice(insertIndex),
    ];

    const orderUpdates = allSections.map((s, idx) => ({
      section_id: s.id,
      parent_id: newParentId,
      order: idx,
    }));

    // 4. APIコール
    try {
      await ApiClient.post(`/api/projects/${project.id}/sections/reorder`, orderUpdates);
    } catch (error) {
      showToast('セクションの移動に失敗しました', 'error');
      return;
    }

    // 5. API成功後にのみローカル状態を更新
    draggedSec.parent_id = newParentId;
    draggedSec.order = orderUpdates.find(u => u.section_id === draggedId).order;

    siblings.forEach(s => {
      const localSec = project.sections.find(sec => sec.id === s.id);
      if (localSec) {
        localSec.order = orderUpdates.find(u => u.section_id === s.id).order;
      }
    });

    _renderOutline();
    _renderDocView();
    ReviewTab.updateSections(_project);
    showToast('セクションを移動しました', 'success');
  }

  // ─── 文字数カウント ───────────────────────────────────

  /**
   * トップバーの文字数カウント表示を更新する
   * Editタブのみ表示し、セクション選択中は選択セクションの文字数、非選択時は全文字数を表示する
   */
  function _updateCharCount() {
    const display = document.getElementById('char-count-display');
    if (!display) return;
    const project = window.appState.getProject();
    if (!project || window.appState.getState().activeTab !== 'edit') {
      display.style.display = 'none';
      return;
    }

    const selectedId = window.appState.getSelectedSectionId();
    let count, label;

    if (selectedId) {
      const sec = project.sections.find(s => s.id === selectedId);
      count = sec ? (sec.content || '').replace(/\s/g, '').length : 0;
      label = `選択中: ${count.toLocaleString()} 文字`;
    } else {
      count = project.sections.reduce((sum, s) => sum + (s.content || '').replace(/\s/g, '').length, 0);
      label = `全文: ${count.toLocaleString()} 文字`;
    }

    display.textContent = label;
    display.style.display = '';
  }

  // ─── 編集モード更新 ───────────────────────────────────

  /**
   * 選択中セクションに応じてUI状態を更新する（Tiptap移行後の簡略版）
   * アウトライン選択状態・セクションツールバーの表示/非表示を管理する
   */
  function _updateDocViewEditMode() {
    const selectedId = window.appState.getSelectedSectionId();

    // アウトラインの選択状態を全セクションで更新
    document.querySelectorAll('.outline-item').forEach(item => {
      const secId = item.dataset.id;
      const isSelected = (secId === selectedId);
      item.classList.toggle('selected', isSelected);
      item.classList.toggle('active', isSelected);
    });

    // セクションツールバー（文献挿入・図表挿入）の表示/非表示
    const toolbar = document.getElementById('tiptap-section-toolbar');
    const toolbarLabel = document.getElementById('tiptap-toolbar-label');
    if (toolbar) {
      if (selectedId) {
        const sec = _project && _project.sections.find(s => s.id === selectedId);
        if (toolbarLabel) toolbarLabel.textContent = sec ? sec.title : '';
        toolbar.style.display = '';

        // ボタンのイベントを再バインド（cloneして重複防止）
        const refBtn = toolbar.querySelector('[data-action="insert-ref"]');
        const figBtn = toolbar.querySelector('[data-action="insert-fig"]');
        if (refBtn) {
          const newRefBtn = refBtn.cloneNode(true);
          refBtn.parentNode.replaceChild(newRefBtn, refBtn);
          newRefBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _showInsertRefDialog(selectedId);
          });
        }
        if (figBtn) {
          const newFigBtn = figBtn.cloneNode(true);
          figBtn.parentNode.replaceChild(newFigBtn, figBtn);
          newFigBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _showInsertFigDialog(selectedId);
          });
        }
      } else {
        toolbar.style.display = 'none';
        // 全セクション非選択時はスコープを「全セクション(骨子)」に戻す
        AppShell.setCurrentScope('all');
      }
    }

    _updateCharCount();
  }

  // ─── セクション追加モーダル（親要素選択付き）─────────────

  /**
   * セクション追加モーダルを表示し、タイトル・概要・親セクションを入力してAPIに保存する
   * @param {string|null|undefined} parentId - デフォルト親セクションID
   *   セクションID → そのセクションを親としてデフォルト設定
   *   null → 親なし（ルート）をデフォルト設定
   *   undefined → 選択中セクションがあればそれを親に自動設定
   */
  async function _showAddSectionModal(parentId = undefined) {
    const project = window.appState.getProject();
    const sections = project.sections;

    // 階層順（深さ優先）でソートして親セクション選択肢を構築
    function sortHierarchically(secs) {
      const byParent = {};
      secs.forEach(s => {
        const key = s.parent_id || '__root__';
        if (!byParent[key]) byParent[key] = [];
        byParent[key].push(s);
      });
      Object.values(byParent).forEach(arr => arr.sort((a, b) => a.order - b.order));
      const result = [];
      function visit(parentId) {
        const key = parentId || '__root__';
        (byParent[key] || []).forEach(s => {
          result.push(s);
          visit(s.id);
        });
      }
      visit(null);
      return result;
    }

    const sortedSections = sortHierarchically(sections);
    const parentOptions = [
      { value: '', label: 'ルート（親なし）' },
      ...sortedSections.map(s => ({
        value: s.id,
        label: '　'.repeat(_sectionDepth(s, sections) - 1) + s.title,
      })),
    ];

    // デフォルトの親セクションを設定
    let defaultParent;
    if (parentId !== undefined) {
      // 明示的に指定された場合（add-child ボタン、btn-add-chapter など）
      defaultParent = parentId;
    } else {
      // 未指定の場合: 選択中セクションをデフォルト親に
      defaultParent = window.appState.getSelectedSectionId() || null;
    }

    // フォームモーダルを表示
    const result = await Modal.form(
      'セクション追加',
      [
        {
          name: 'title',
          label: 'タイトル',
          type: 'text',
          value: '',
          autofocus: true,
        },
        {
          name: 'summary',
          label: '概要',
          type: 'textarea',
          value: '',
        },
        {
          name: 'parent_id',
          label: '親セクション',
          type: 'select',
          value: defaultParent || '',
          options: parentOptions,
        },
      ],
      { large: true }
    );

    if (!result) return;  // キャンセル

    const { title, summary, parent_id } = result;

    if (!title) {
      showToast('タイトルを入力してください', 'error');
      return;
    }

    // オーダー計算
    const selectedParent = parent_id === '' ? null : parent_id;
    const siblings = sections.filter(s => s.parent_id === selectedParent);
    const maxOrder = siblings.reduce((m, s) => Math.max(m, s.order), -1);

    // APIコール
    const sec = await ApiClient.post(`/api/projects/${project.id}/sections`, {
      title,
      summary,
      content: '',
      parent_id: selectedParent || null,
      order: maxOrder + 1,
    });

    project.sections.push(sec);

    // 新規セクションを選択状態に
    window.appState.setSelectedSectionId(sec.id);

    _renderOutline();
    _renderDocView();
    ReviewTab.updateSections(_project);
    _updateDocViewEditMode();
  }

  // ─── イベントバインド ──────────────────────────────────

  /**
   * EditTabのDOMイベントをバインドする
   * 「セクション追加」ボタンにクリックイベントを設定する
   */
  function bindEvents() {
    // 「セクション追加」ボタン: 引数なし（undefined）で呼び出し → 選択中セクションがあればそれを親に
    document.getElementById('btn-add-chapter').addEventListener('click', () => {
      _showAddSectionModal();
    });

    // Tiptapのテキスト選択時の文字数表示（tiptap-ready後に登録）
    function _bindTiptapSelectionUpdate() {
      const editor = window.TiptapEditor && window.TiptapEditor.getEditor();
      if (!editor) return;
      editor.on('selectionUpdate', ({ editor: ed }) => {
        const display = document.getElementById('char-count-display');
        if (!display || window.appState.getState().activeTab !== 'edit') return;
        const { from, to } = ed.state.selection;
        if (from !== to) {
          const selText = ed.state.doc.textBetween(from, to, ' ');
          const count = selText.replace(/\s/g, '').length;
          display.textContent = `選択: ${count.toLocaleString()} 文字`;
          display.style.display = '';
        } else {
          _updateCharCount();
        }
      });
    }

    if (window.TiptapEditor && window.TiptapEditor.getEditor()) {
      _bindTiptapSelectionUpdate();
    } else {
      document.addEventListener('tiptap-ready', _bindTiptapSelectionUpdate, { once: true });
    }
  }

  /**
   * EditTabの状態をリセットする
   * プロジェクト・タイマー・ドラッグ状態・折りたたみ状態を初期化する
   */
  function reset() {
    _project = null;
    _dragState = null;
    _collapsed = {};
    _savedTiptapPos = null;
    clearTimeout(_tiptapUpdateTimer);
    _tiptapUpdateTimer = null;
    // Tiptapのupdateハンドラを解除
    if (_tiptapUpdateHandler && window.TiptapEditor) {
      const editor = window.TiptapEditor.getEditor();
      if (editor) editor.off('update', _tiptapUpdateHandler);
    }
    _tiptapUpdateHandler = null;
  }

  return {
    render,
    bindEvents,
    insertRef: _showInsertRefDialog,
    insertFig: _showInsertFigDialog,
    addChapter: _addChapter,
    reset,
  };
})();
