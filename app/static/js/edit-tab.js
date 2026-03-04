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

  // セクション削除API呼び出し中フラグ（二重実行防止）
  let _deletionPending = false;

  // ツールチップ DOM
  let _tooltip = null;

  /**
   * プロジェクト開時に content と sections の整合性を検証・修復する。
   * content（Markdown本文）を正として、sections と差異があれば修正する。
   * - content に存在しない sections → API DELETE して除去
   * - sections に存在しない content マーカー → API POST で登録
   * @param {object} project - プロジェクトオブジェクト
   */
  async function _reconcileContentAndSections(project) {
    const content = project.content || '';
    // 新形式: {JSON} / 旧形式: uuid の両方にマッチ
    const markerPattern = /<!-- soki-section:(\{[^}]*\}|[a-f0-9-]+) -->\n(#{1,6})\s+([^\n]+)/g;

    // content から全セクションIDとタイトルを抽出
    const contentSections = [];
    const contentIds = new Set();
    let m;
    while ((m = markerPattern.exec(content)) !== null) {
      // 新形式からIDを抽出
      let sectionId = m[1];
      if (sectionId.startsWith('{')) {
        try { sectionId = JSON.parse(sectionId).id; } catch (_) { continue; }
      }
      contentIds.add(sectionId);
      contentSections.push({ id: sectionId, level: m[2].length, title: m[3].trim() });
    }

    let changed = false;

    // ケース d: sections に重複IDがある → 重複分を除去（APIには不要なのでローカルのみ）
    const seenIds = new Set();
    project.sections = project.sections.filter(s => {
      if (seenIds.has(s.id)) { changed = true; return false; }
      seenIds.add(s.id);
      return true;
    });

    const sectionIds = new Set(project.sections.map(s => s.id));

    // ケース b: sections にあるが content にない → DELETE
    const orphanedSections = project.sections.filter(s => !contentIds.has(s.id));
    for (const sec of orphanedSections) {
      try {
        await ApiClient.delete(`/api/projects/${project.id}/sections/${sec.id}`);
        project.sections = project.sections.filter(s => s.id !== sec.id);
        changed = true;
      } catch (_) { }
    }

    // ケース a: content にあるが sections にない → 同じIDで POST 登録
    const missingSections = contentSections.filter(cs => !sectionIds.has(cs.id));
    for (const cs of missingSections) {
      try {
        const order = project.sections.filter(s => !s.parent_id).length;
        const sec = await ApiClient.post(`/api/projects/${project.id}/sections`, {
          id: cs.id,
          title: cs.title,
          summary: '',
          parent_id: null,
          order,
        });
        project.sections.push(sec);
        changed = true;
      } catch (_) { }
    }

    // ケース c: sections にあり content にもあるが、タイトルが不一致 → PUT で更新
    for (const cs of contentSections) {
      const sec = project.sections.find(s => s.id === cs.id);
      if (sec && sec.title !== cs.title) {
        try {
          await ApiClient.put(`/api/projects/${project.id}/sections/${sec.id}`, { title: cs.title });
          sec.title = cs.title;
          changed = true;
        } catch (_) { }
      }
    }

    if (changed) _renderOutline();
  }

  /**
   * EditTabを初期化してUIを描画する
   * Tiptapが未初期化の場合は tiptap-ready イベントを待つ
   * @param {object} project - プロジェクトオブジェクト
   */
  function render(project) {
    _project = project;
    _reconcileContentAndSections(project);
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
      _onTiptapUpdate();
    };

    editor.on('update', _tiptapUpdateHandler);
  }

  /**
   * Tiptap updateイベントのメイン処理
   * Tiptapノードを唯一の真実のソースとしてアウトラインを更新する
   */
  function _onTiptapUpdate() {
    const tiptapSections = window.TiptapEditor.parseSectionsFromDoc();

    // 1. アウトライン同期（undo復元・タイトル変化・階層変化を含む）
    _syncOutlineFromTiptap(tiptapSections);

    // 2. 削除されたセクションを検知

    // 3. 削除されたセクションを検知
    _detectDeletedSections(tiptapSections);

    // 4. 文字数カウント更新
    _updateCharCount();

    // 5. 2秒debounceで PUT /content
    clearTimeout(_tiptapUpdateTimer);
    _tiptapUpdateTimer = setTimeout(() => _syncContentToBackend(), 2000);
  }

  function _syncOutlineFromTiptap(tiptapSections) {
    if (!_project) return;
    let changed = false;

    // 1. Recalculate Hierarchy based on Tiptap reading order
    const stack = [];
    const counts = {};
    tiptapSections.forEach(ts => {
      while (stack.length > 0 && stack[stack.length - 1].level >= ts.level) {
        stack.pop();
      }
      ts.calculatedParentId = stack.length > 0 ? stack[stack.length - 1].id : null;

      const pid = ts.calculatedParentId || '__root__';
      if (!(pid in counts)) counts[pid] = 0;
      ts.calculatedOrder = counts[pid]++;

      stack.push(ts);
    });

    for (const ts of tiptapSections) {
      const existing = _project.sections.find(s => s.id === ts.id);
      if (!existing) {
        // undoで復元されたノード または 新規追加されたノード
        _project.sections.push({
          id: ts.id,
          title: ts.title,
          summary: ts.summary || '',
          parent_id: ts.calculatedParentId,
          order: ts.calculatedOrder,
        });
        changed = true;
        // POST to backend
        ApiClient.post(`/api/projects/${_project.id}/sections`, {
          id: ts.id,
          title: ts.title,
          summary: ts.summary || '',
          parent_id: ts.calculatedParentId,
          order: ts.calculatedOrder,
        }).catch(e => { /* Ignore 409 if exists */ });
      } else {
        // タイトル・summary・構造（D&D等による）変化を同期
        const structuralChange = existing.parent_id !== ts.calculatedParentId || existing.order !== ts.calculatedOrder;
        if (existing.title !== ts.title || existing.summary !== ts.summary || structuralChange) {
          existing.title = ts.title;
          existing.summary = ts.summary;
          existing.parent_id = ts.calculatedParentId;
          existing.order = ts.calculatedOrder;
          changed = true;

          ApiClient.put(`/api/projects/${_project.id}/sections/${ts.id}`, {
            title: ts.title,
            summary: ts.summary || '',
            parent_id: ts.calculatedParentId,
            order: ts.calculatedOrder,
          }).catch(e => { console.error(e); });
        }
      }

      // Ensure the tiptap node has the correct attributes
      if (ts.parentId !== ts.calculatedParentId || ts.sectionOrder !== ts.calculatedOrder) {
        window.TiptapEditor.updateSectionMetaById(ts.id, {
          parentId: ts.calculatedParentId,
          sectionOrder: ts.calculatedOrder
        });
      }
    }

    if (changed) _renderOutline();
  }

  /**
   * project.sectionsにあってTiptapにないIDを検知し、即座にAPIから削除する
   * UndoでTiptap側のノードが復元された場合は_syncOutlineFromTiptapが再追加する
   * @param {{ id }[]} tiptapSections
   */
  async function _detectDeletedSections(tiptapSections) {
    if (!_project || _deletionPending) return;

    const tiptapIds = new Set(tiptapSections.map(s => s.id));
    const deletedSections = _project.sections.filter(s => !tiptapIds.has(s.id));
    if (deletedSections.length === 0) return;

    _deletionPending = true;

    const project = window.appState.getProject();
    if (!project) { _deletionPending = false; return; }

    for (const sec of deletedSections) {
      try {
        await ApiClient.delete(`/api/projects/${project.id}/sections/${sec.id}`);
        project.sections = project.sections.filter(s => s.id !== sec.id);
      } catch (_) { }
    }

    _deletionPending = false;

    await _syncContentToBackend();
    _renderOutline();
  }

  /**
   * TiptapのMarkdownコンテンツをバックエンドのproject.contentとして保存する
   */
  async function _syncContentToBackend() {
    const project = window.appState.getProject();
    if (!project) return;
    const content = window.TiptapEditor.getContentAsMarkdown();
    try {
      await ApiClient.put(`/api/projects/${project.id}/content`, { content });
      project.content = content;
    } catch (_) { }
  }

  /**
   * @deprecated _syncOutlineFromTiptap に置き換え済み。後方互換のために残す。
   */
  function _syncTitlesFromContent(content) {
    if (!_project) return;
    const markerPattern = /<!-- soki-section:([a-f0-9-]+) -->\n(#{1,6})\s+(.+)/g;
    let m;
    let changed = false;
    while ((m = markerPattern.exec(content)) !== null) {
      const [, id, , title] = m;
      const sec = _project.sections.find(s => s.id === id);
      if (sec && sec.title !== title.trim()) {
        sec.title = title.trim();
        changed = true;
      }
    }
    if (changed) _renderOutline();
  }

  /**
   * (Removed `_detectAndHandleNewHeadings` and `_inferHierarchyAndOrder` because UniqueID extension generates IDs automatically, and structure is derived natively from document order instead.)
   */


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
      if (proj) {
        proj.references_section_enabled = enabled;
        if (window.TiptapEditor) {
          window.TiptapEditor.setProjectData(enabled, proj.sources || [], proj.materials || []);
        }
      }
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
      // TiptapEditor.scrollToSection を使ってスクロール
      if (window.TiptapEditor && window.TiptapEditor.scrollToSection) {
        window.TiptapEditor.scrollToSection(sec.id);
      } else {
        // フォールバック
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
   * TiptapにprojectのMarkdownコンテンツをロードしてWYSIWYGビューを更新する
   */
  /**
   * project.sections[] のメタデータ（summary/parentId/sectionOrder）を
   * Tiptapノード属性に書き込む。
   * 初回ロード・リロード時に旧形式マーカーのデータを補完するために呼ぶ。
   */
  function _injectSectionMeta() {
    if (!_project || !window.TiptapEditor) return;
    window.TiptapEditor._suppressUpdate = true;
    for (const sec of _project.sections) {
      window.TiptapEditor.updateSectionMetaById(sec.id, {
        summary: sec.summary || '',
        parentId: sec.parent_id || null,
        sectionOrder: sec.order ?? 0,
      });
    }
    setTimeout(() => { window.TiptapEditor._suppressUpdate = false; }, 50);
  }

  function _renderDocView() {
    if (!window.TiptapEditor) return;

    // Set Editor Project Data for extensions to use (CharacterCount, References)
    window.TiptapEditor.setProjectData(_project.references_section_enabled, _project.sources || [], _project.materials || []);

    // Tiptapにproject.contentをセット（新アーキテクチャ）
    window.TiptapEditor.setContentFromMarkdown(_project.content || '');
    // project.sections[] のメタデータ（summary/parentId/order）をTiptapノード属性に注入
    _injectSectionMeta();

    _updateDocViewEditMode();
  }


  // ─── セクション操作 ─────────────────────────────────────

  /**
   * セクションのメタ情報（タイトル・概要・親セクション）を編集するモーダルを表示し、変更をAPIに保存する
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
      { name: 'summary', label: '概要', type: 'textarea', value: sec.summary || '' },
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
    const newSummary = result.summary;
    const newParentId = result.parent_id || null;

    const updateData = {};
    if (newTitle && newTitle !== sec.title) updateData.title = newTitle;
    if (newSummary !== (sec.summary || '')) updateData.summary = newSummary;
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
    if (updateData.summary !== undefined) sec.summary = updateData.summary;
    if ('parent_id' in updateData) {
      sec.parent_id = newParentId;
      sec.order = updateData.order;
    }

    // TiptapノードのsummaryとparentIdも更新（undoスタックに記録されるため一貫性が保たれる）
    const metaUpdate = {};
    if (updateData.summary !== undefined) metaUpdate.summary = updateData.summary;
    if ('parent_id' in updateData) {
      metaUpdate.parentId = newParentId;
      metaUpdate.sectionOrder = updateData.order;
    }
    if (Object.keys(metaUpdate).length > 0) {
      window.TiptapEditor.updateSectionMetaById(sec.id, metaUpdate);
    }

    await _syncOutlineToBody();
    _renderOutline();
  }

  /**
   * セクションを削除する（Undoで復元可能）
   * 削除後はproject.contentからも該当ブロックを除去する
   * @param {object} sec - 削除対象のセクションオブジェクト
   */
  async function _deleteSection(sec) {
    const project = window.appState.getProject();
    const sections = project.sections;

    // 自分と子孫のIDセットを作成
    function getDescendantIds(id) {
      const children = sections.filter(s => s.parent_id === id);
      return [id, ...children.flatMap(c => getDescendantIds(c.id))];
    }
    const idsToDelete = new Set(getDescendantIds(sec.id));

    // APIから削除
    for (const id of idsToDelete) {
      try {
        await ApiClient.delete(`/api/projects/${project.id}/sections/${id}`);
      } catch (_) { }
    }

    project.sections = project.sections.filter(s => !idsToDelete.has(s.id));

    // Tiptapドキュメントから該当ブロック（子セクションとその中身を含む）をすべて削除
    if (window.TiptapEditor.deleteSectionBlock) {
      window.TiptapEditor.deleteSectionBlock(sec.id);
    } else {
      window.TiptapEditor.deleteSectionHeading(sec.id);
    }

    await _syncContentToBackend();
    _renderOutline();
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
    await _syncOutlineToBody();
    _renderOutline();
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
    await _syncOutlineToBody();
    _renderOutline();
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
    await _syncOutlineToBody();
    _renderOutline();
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
    const filteredSources = project.sources.filter(s => s.bibliography?.include_in_references === true);
    if (!filteredSources.length) { showToast('参考文献に含めるソースがありません', 'error'); return; }
    const items = filteredSources.map(s => ({ value: s.id, label: s.bibliography?.title || s.name }));
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
    _insertFigNumberNode(sectionId, mat);
  }

  /**
   * FigureNode（図表番号インライン）をTiptapエディタに直接挿入する
   */
  function _insertFigNumberNode(sectionId, mat) {
    const editor = window.TiptapEditor && window.TiptapEditor.getEditor();
    if (!editor) return;
    const nodeContent = { type: 'figureNode', attrs: { figId: mat.id, altText: mat.caption || mat.name } };
    if (_savedTiptapPos !== null) {
      editor.chain().focus().insertContentAt(_savedTiptapPos, nodeContent).run();
    } else {
      const endPos = sectionId ? window.TiptapEditor.getSectionContentEnd(sectionId) : null;
      if (endPos !== null) {
        editor.chain().focus().insertContentAt(endPos, nodeContent).run();
      } else {
        editor.chain().focus().insertContent(nodeContent).run();
      }
    }
    _savedTiptapPos = null;
  }

  /**
   * マテリアル選択モーダルを表示し、選択した図表をブロック要素としてカーソル位置に挿入する
   * @param {string} sectionId - 挿入先のセクションID
   */
  async function _showInsertFigBlockDialog(sectionId) {
    _saveCursorPosition();
    const project = window.appState.getProject();
    if (!project.materials.length) { showToast('マテリアルがありません', 'error'); return; }
    const items = project.materials.map(m => ({ value: m.id, label: m.name }));
    const choice = await Modal.select('図表を挿入', 'マテリアルを選択してください', items, { large: true });
    if (!choice) return;
    const mat = project.materials.find(m => m.id === choice);
    if (!mat) { showToast('マテリアルが見つかりません', 'error'); return; }
    _insertFigBlockNode(sectionId, mat.id);
  }

  /**
   * FigureBlockNodeをTiptapエディタに直接挿入する
   */
  function _insertFigBlockNode(sectionId, figId) {
    const editor = window.TiptapEditor && window.TiptapEditor.getEditor();
    if (!editor) return;
    const blockNode = { type: 'figureBlockNode', attrs: { figId } };
    if (_savedTiptapPos !== null) {
      editor.chain().focus().insertContentAt(_savedTiptapPos, blockNode).createParagraphNear().focus().run();
    } else {
      const endPos = sectionId ? window.TiptapEditor.getSectionContentEnd(sectionId) : null;
      if (endPos !== null) {
        editor.chain().focus().insertContentAt(endPos, blockNode).createParagraphNear().focus().run();
      } else {
        editor.chain().focus().insertContent(blockNode).createParagraphNear().focus().run();
      }
    }
    _savedTiptapPos = null;
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
      const endPos = sectionId ? window.TiptapEditor.getSectionContentEnd(sectionId) : null;
      if (endPos !== null) {
        editor.chain().focus().insertContentAt(endPos, text).run();
      } else {
        editor.chain().focus().insertContent(text).run();
      }
    }
    _savedTiptapPos = null;
    // Tiptapのupdateイベントが自動保存をトリガーする
  }

  /**
   * アウトラインパネルの最新状態（順序・親・タイトル）に合わせて
   * project.content の Markdown を再構築し、Tiptap エディタに即時反映する。
   * これにより、アウトライン上のドラッグ&ドロップやタイトル編集が本文に即時同期される。
   */
  async function _syncOutlineToBody() {
    if (!window.TiptapEditor || !_project) return;

    // 現在のテキストを抽出
    const currentContent = window.TiptapEditor.getContentAsMarkdown();
    // 新形式: {JSON} / 旧形式: uuid の両方にマッチ
    const MARKER_RE = /<!-- soki-section:(\{[^}]*\}|[a-f0-9-]+) -->\n?/g;
    const allMatches = [...currentContent.matchAll(MARKER_RE)];

    let preamble = '';
    const sectionBlocks = {}; // id → ブロック文字列

    // マーカーペイロードからIDを抽出するヘルパー
    function extractId(payload) {
      if (payload.startsWith('{')) {
        try { return JSON.parse(payload).id; } catch (_) { return null; }
      }
      return payload;
    }

    if (allMatches.length === 0) {
      preamble = currentContent;
    } else {
      if (allMatches[0].index > 0) {
        preamble = currentContent.slice(0, allMatches[0].index);
      }
      for (let i = 0; i < allMatches.length; i++) {
        const m = allMatches[i];
        const id = extractId(m[1]);
        if (!id) continue;
        const start = m.index;
        const end = (i + 1 < allMatches.length) ? allMatches[i + 1].index : currentContent.length;
        sectionBlocks[id] = currentContent.slice(start, end);
      }
    }

    // アウトラインツリー順に並び替え
    const byParent = {};
    _project.sections.forEach(s => {
      const key = s.parent_id || '__root__';
      if (!byParent[key]) byParent[key] = [];
      byParent[key].push(s);
    });
    Object.values(byParent).forEach(arr => arr.sort((a, b) => a.order - b.order));

    const ordered = [];
    function visit(parentId, depth) {
      const key = parentId || '__root__';
      (byParent[key] || []).forEach(s => {
        ordered.push({ sec: s, depth });
        visit(s.id, depth + 1);
      });
    }
    visit(null, 1); // ルートはレベル1 (#)

    let newContent = preamble;
    ordered.forEach(({ sec, depth }) => {
      let block = sectionBlocks[sec.id] || `<!-- soki-section:${sec.id} -->\n## ${sec.title}\n\n`;
      const levelStr = '#'.repeat(Math.min(depth, 6));

      // ブロック内の最初の見出し (#...) のレベルとタイトル文字列をアウトラインの最新状態に置換する
      // 新旧両マーカー形式に対応
      block = block.replace(/(<!-- soki-section:(?:\{[^}]*\}|[a-f0-9-]+) -->(?:\r?\n)?)#{1,6}\s+[^\n]+(.*)/s, `$1${levelStr} ${sec.title}$2`);

      newContent += block;
      if (!newContent.endsWith('\n')) newContent += '\n';
    });

    _project.content = newContent;
    window.TiptapEditor._suppressUpdate = true;
    window.TiptapEditor.setContentFromMarkdown(newContent);
    // setContentFromMarkdown後にsummary/parentId/orderをノード属性に再注入
    _injectSectionMeta();
    // _injectSectionMetaが_suppressUpdateをfalseにするので即座にawaitしてから解除
    await _syncContentToBackend();

    _renderDocView();
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

    // 6. TiptapノードのparentId/sectionOrder属性を更新（undo後も階層情報が正しく復元されるように）
    orderUpdates.forEach(u => {
      window.TiptapEditor.updateSectionMetaById(u.section_id, {
        parentId: u.parent_id,
        sectionOrder: u.order,
      });
    });

    await _syncOutlineToBody();
    _renderOutline();
    showToast('セクションを移動しました', 'success');
  }

  // ─── 文字数カウント ───────────────────────────────────

  /**
   * project.content のマーカー・見出し行を除いた本文文字数を返す
   * @param {string} content - project.content
   * @returns {number}
   */
  function _countBodyChars(content) {
    return (content || '')
      .replace(/<!-- soki-section:(?:\{[^}]*\}|[a-f0-9-]+) -->/g, '')
      .replace(/^#{1,6}\s+.+$/gm, '')
      .replace(/\s/g, '').length;
  }

  /**
   * 指定セクションの本文文字数を返す
   * @param {string} content - project.content
   * @param {string} sectionId - セクションID
   * @returns {number}
   */
  function _countSectionBodyChars(content, sectionId) {
    const escapedId = sectionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `<!-- soki-section:(?:\\{[^}]*"id"\\s*:\\s*"${escapedId}"[^}]*\\}|${escapedId}) -->\\n#{1,6} [^\\n]+\\n(.*?)(?=<!-- soki-section:|$)`,
      's'
    );
    const m = pattern.exec(content || '');
    if (!m) return 0;
    return m[1].replace(/\s/g, '').length;
  }

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

    const content = project.content || '';
    const selectedId = window.appState.getSelectedSectionId();
    let count, label;

    if (selectedId) {
      count = _countSectionBodyChars(content, selectedId);
      label = `選択中: ${count.toLocaleString()} 文字`;
    } else {
      count = window.TiptapEditor ? window.TiptapEditor.getCharacterCount() : _countBodyChars(content);
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
    const toolbar = document.getElementById('tiptap-toolbar');
    const toolbarLabel = document.getElementById('tiptap-toolbar-label');
    const toolbarDivider = document.getElementById('tiptap-toolbar-divider');
    const refBtn = toolbar ? toolbar.querySelector('[data-action="insert-ref"]') : null;
    const figBtn = toolbar ? toolbar.querySelector('[data-action="insert-fig"]') : null;
    const figBlockBtn = toolbar ? toolbar.querySelector('[data-action="insert-fig-block"]') : null;

    if (toolbar) {
      if (toolbarLabel) {
        if (selectedId) {
          const sec = _project && _project.sections.find(s => s.id === selectedId);
          toolbarLabel.textContent = sec ? sec.title : '';
        } else {
          toolbarLabel.textContent = '全セクション';
        }
        toolbarLabel.style.display = '';
      }
      if (toolbarDivider) toolbarDivider.style.display = '';
      if (refBtn) refBtn.style.display = '';
      if (figBtn) figBtn.style.display = '';
      if (figBlockBtn) figBlockBtn.style.display = '';

      // ボタンのイベントを再バインド（cloneして重複防止）
      if (refBtn) {
        const newRefBtn = refBtn.cloneNode(true);
        refBtn.parentNode.replaceChild(newRefBtn, refBtn);
        newRefBtn.addEventListener('mousedown', e => e.preventDefault());
        newRefBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _showInsertRefDialog(selectedId);
        });
      }
      if (figBtn) {
        const newFigBtn = figBtn.cloneNode(true);
        figBtn.parentNode.replaceChild(newFigBtn, figBtn);
        newFigBtn.addEventListener('mousedown', e => e.preventDefault());
        newFigBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _showInsertFigDialog(selectedId);
        });
      }
      if (figBlockBtn) {
        const newFigBlockBtn = figBlockBtn.cloneNode(true);
        figBlockBtn.parentNode.replaceChild(newFigBlockBtn, figBlockBtn);
        newFigBlockBtn.addEventListener('mousedown', e => e.preventDefault());
        newFigBlockBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _showInsertFigBlockDialog(selectedId);
        });
      }

      if (!selectedId) {
        // 全セクション非選択時はスコープを「全セクション(骨子)」に戻す
        AppShell.setCurrentScope('all');
      }
    }

    _updateCharCount();
  }

  // ─── セクション追加モーダル（親要素選択付き）─────────────

  /**
   * セクション追加モーダルを表示し、タイトル・概要・親セクションを入力してAPIに保存する
   * 追加後はTiptapエディタに見出しを挿入する
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

    // APIコール（backendがproject.contentにスケルトンを追記する）
    const sec = await ApiClient.post(`/api/projects/${project.id}/sections`, {
      title,
      summary,
      parent_id: selectedParent || null,
      order: maxOrder + 1,
    });

    project.sections.push(sec);

    // 新規セクションを追加したので、本文にも反映する
    await _syncOutlineToBody();

    // 新規セクションを選択状態に
    window.appState.setSelectedSectionId(sec.id);

    _renderOutline();

    // Tiptap上で新規セクションの見出しにスクロール
    if (window.TiptapEditor && window.TiptapEditor.scrollToSection) {
      window.TiptapEditor.scrollToSection(sec.id);
    }

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

    // 「選択解除」ボタン
    document.getElementById('btn-deselect-section').addEventListener('click', () => {
      clearSectionSelection();
    });

    // Tiptapのテキスト選択時の文字数表示とセクション同期（tiptap-ready後に登録）
    function _bindTiptapSelectionUpdate() {
      const editor = window.TiptapEditor && window.TiptapEditor.getEditor();
      if (!editor) return;
      editor.on('selectionUpdate', ({ editor: ed }) => {
        if (window.appState.getState().activeTab !== 'edit') return;

        const { from, to } = ed.state.selection;

        // --- 1. カーソル位置に対応するセクションを特定してアウトラインと同期 ---
        let currentSectionId = null;
        let lastSectionId = null;

        ed.state.doc.forEach((node, pos) => {
          if (node.type.name === 'sectionHeading' && node.attrs.sectionId) {
            // 見出しの開始位置がカーソル以前なら記憶
            // 見出し内のテキストにカーソルがある場合も考慮して <= とする
            if (pos <= from) {
              lastSectionId = node.attrs.sectionId;
            }
          }
        });

        currentSectionId = lastSectionId;

        // 選択状態が変わった場合のみ更新（無限ループや不要な再描画を防ぐ）
        if (currentSectionId && currentSectionId !== window.appState.getSelectedSectionId()) {
          window.appState.setSelectedSectionId(currentSectionId);
          AppShell.setCurrentScope(currentSectionId);
          _updateDocViewEditMode();
        } else if (!currentSectionId && window.appState.getSelectedSectionId()) {
          // 本文冒頭（最初の見出しより前）にカーソルがある場合はセクション非選択状態
          window.appState.setSelectedSectionId(null);
          AppShell.setCurrentScope('all');
          _updateDocViewEditMode();
        }

        // --- 2. 文字数表示の更新 ---
        const display = document.getElementById('char-count-display');
        if (display) {
          if (from !== to) {
            const selText = ed.state.doc.textBetween(from, to, ' ');
            const count = selText.replace(/\s/g, '').length;
            display.textContent = `選択: ${count.toLocaleString()} 文字`;
            display.style.display = '';
          } else {
            _updateCharCount();
          }
        }
      });
    }

    if (window.TiptapEditor && window.TiptapEditor.getEditor()) {
      _bindTiptapSelectionUpdate();
    } else {
      document.addEventListener('tiptap-ready', _bindTiptapSelectionUpdate, { once: true });
    }

    // ESCキー: 本文編集中に押下で全セクション選択解除
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (window.appState.getState().activeTab !== 'edit') return;
      // モーダルが開いている場合は処理しない
      if (document.querySelector('.modal-overlay')) return;
      // エディタ内またはアウトライン内にフォーカスがある場合に解除
      const tiptapMount = document.getElementById('tiptap-editor-mount');
      const isInEditor = tiptapMount && tiptapMount.contains(document.activeElement);
      const outlineList = document.getElementById('outline-list');
      const isInOutline = outlineList && outlineList.contains(document.activeElement);
      if (isInEditor || isInOutline || window.appState.getSelectedSectionId()) {
        clearSectionSelection();
      }
    });
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
    _deletionPending = false;
    _headingDetectionPending = false;
    clearTimeout(_tiptapUpdateTimer);
    _tiptapUpdateTimer = null;
    // Tiptapのupdateハンドラを解除
    if (_tiptapUpdateHandler && window.TiptapEditor) {
      const editor = window.TiptapEditor.getEditor();
      if (editor) editor.off('update', _tiptapUpdateHandler);
    }
    _tiptapUpdateHandler = null;
  }

  /**
   * 全セクションの選択を解除する（外部から呼び出し可能）
   */
  function clearSectionSelection() {
    window.appState.setSelectedSectionId(null);
    document.querySelectorAll('.outline-item').forEach(el => {
      el.classList.remove('selected');
      el.classList.remove('active');
    });
    _updateDocViewEditMode();
    AppShell.setCurrentScope('all');
  }

  return {
    render,
    bindEvents,
    insertRef: _showInsertRefDialog,
    insertFig: _showInsertFigDialog,
    insertFigBlock: _showInsertFigBlockDialog,
    addChapter: _addChapter,
    reset,
    forceSync: _syncContentToBackend,
    clearSectionSelection,
  };
})();
window.EditTab = EditTab;
