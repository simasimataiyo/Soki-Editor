/**
 * EditTab — アウトライン・ドキュメントビュー・文献/図表挿入（タスク 11）
 */

const EditTab = (() => {
  let _project = null;
  let _saveTimer = {};
  let _dragState = null;  // ドラッグ操作状態
  let _savedRange = null; // モーダル表示前のカーソル位置保存用

  /**
   * EditTabを初期化してUIを描画する
   * @param {object} project - プロジェクトオブジェクト
   */
  function render(project) {
    _project = project;
    _renderOutline();
    _renderDocView();
    _renderScopeSelect();
    _initReferencesCheckbox(project);
    _updateCharCount();
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
      const el = document.getElementById(`sec-block-${sec.id}`);
      if (el) {
        // トップバーの高さを考慮して位置調整
        const topBar = document.querySelector('.top-bar');
        const topBarHeight = topBar ? topBar.offsetHeight : 0;
        // scrollIntoViewでまずビュー内に表示
        el.scrollIntoView({ block: 'start' });
        // 少し遅延後にトップバーの高さ分を調整
        requestAnimationFrame(() => {
          const rect = el.getBoundingClientRect();
          const scrollTop = window.scrollY + rect.top - topBarHeight;
          window.scrollTo({ behavior: 'smooth', top: Math.max(0, scrollTop) });
        });
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

    container.appendChild(li);

    // 子要素を再帰的にレンダリング
    if (hasChildren && !isCollapsed) {
      children.sort((a, b) => a.order - b.order).forEach(child => {
        _renderOutlineItem(container, child, allSorted, depth + 1);
      });
    }
  }

  // ─── ドキュメントビュー ─────────────────────────────────

  let _secCollapsed = {};  // ドキュメントビュー折りたたみ状態

  /**
   * ドキュメントビュー全体を再描画する
   * ルートセクションをツリー構造でレンダリングし、参考文献ブロックも表示する
   */
  function _renderDocView() {
    const container = document.getElementById('doc-sections');
    container.innerHTML = '';
    const sorted = [..._project.sections].sort((a, b) => a.order - b.order);

    // ツリー構造で再帰的にレンダリング
    const roots = sorted.filter(s => !s.parent_id);
    roots.forEach(sec => _renderDocSection(container, sec, sorted, 1));

    // 参考文献セクション（有効時のみ表示）
    if (_project.references_section_enabled) {
      _renderReferencesBlock(container, sorted);
    }

    // 選択中セクションのフローティングアクション（文献挿入・図表挿入）を復元
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

  /**
   * ドキュメントビューの1セクションブロックをレンダリングする
   * 折りたたみ・選択・編集・削除・移動・子セクション追加のイベントを設定する
   * @param {HTMLElement} container - 追加先の親要素
   * @param {object} sec - セクションオブジェクト
   * @param {Array} allSorted - order順にソート済みの全セクション配列
   * @param {number} depth - 現在の階層深さ（1始まり）
   */
  function _renderDocSection(container, sec, allSorted, depth) {
    const children = allSorted.filter(s => s.parent_id === sec.id);
    const hasChildren = children.length > 0;
    const isCollapsed = _secCollapsed[sec.id];
    const isSelected = (window.appState.getSelectedSectionId() === sec.id);

    const block = document.createElement('div');
    block.className = `section-block depth-${depth}${isSelected ? ' selected' : ''}`;
    block.id = `sec-block-${sec.id}`;
    block.dataset.secId = sec.id;

    const level = Math.min(depth + 1, 6);
    const tag = `h${level}`;
    const toggleIcon = isCollapsed ? SVG_TOGGLE_RIGHT : SVG_TOGGLE_DOWN;
    const bulletMark = _getBulletMark(sec, allSorted);


    block.innerHTML = `
      <div class="section-header">
        <span class="section-toggle" data-action="sec-toggle">${toggleIcon}</span>
        <${tag} class="section-title" data-action="sec-collapse-toggle" data-sec-id="${sec.id}">
          ${escHtml(sec.title)}
        </${tag}>
        <div class="section-actions">
          <button class="btn-icon" data-action="add-child" title="子セクション追加" data-sec-id="${sec.id}">${SVG_ADD_CHILD}</button>
          <button class="btn-icon" data-action="up" title="上へ">${SVG_ARROW_UP}</button>
          <button class="btn-icon" data-action="down" title="下へ">${SVG_ARROW_DOWN}</button>
          <button class="btn-icon" data-action="edit" title="編集">${SVG_EDIT}</button>
          <button class="btn-icon" data-action="delete" title="削除">${SVG_DELETE}</button>
        </div>
      </div>
      <div class="section-body${isCollapsed ? ' collapsed' : ''}">
        <div class="section-summary${isSelected ? '' : ' hidden'}" contenteditable="${isSelected}" data-sec-id="${sec.id}" data-field="summary">${escHtml(sec.summary)}</div>
        <div class="section-content-wrapper" style="position: relative;">
          <div class="section-content" contenteditable="${isSelected}" data-sec-id="${sec.id}" data-field="content">${escHtml(sec.content)}</div>
        </div>
        <div class="section-children"></div>
      </div>
    `;

    // 折りたたみトグル（コラプスボタンのみ）
    block.querySelector('[data-action="sec-toggle"]').addEventListener('click', (e) => {
      e.stopPropagation();
      _secCollapsed[sec.id] = !_secCollapsed[sec.id];
      _renderDocView();
    });

    // セクションブロッククリックで選択
    block.addEventListener('click', (e) => {
      // クリック対象が子孫のセクションブロックに属する場合は無視
      // （子セクション自身のハンドラに任せる）
      const closestBlock = e.target.closest('.section-block');
      if (closestBlock !== block) return;

      // content/summary クリック: 未選択なら選択してから編集可能にする
      if (e.target.closest('[data-field="summary"]') || e.target.closest('[data-field="content"]')) {
        if (window.appState.getSelectedSectionId() !== sec.id) {
          window.appState.setSelectedSectionId(sec.id);
          _updateDocViewEditMode();
          AppShell.setCurrentScope(sec.id);
        }
        e.stopPropagation();
        return;
      }

      // アクションボタン以外のクリックで選択
      if (!e.target.closest('.section-actions') && !e.target.closest('.section-floating-actions')) {
        window.appState.setSelectedSectionId(sec.id);
        _updateDocViewEditMode();
        AppShell.setCurrentScope(sec.id);
      }
    });

    // 子セクション追加
    block.querySelector('[data-action="add-child"]').addEventListener('click', (e) => {
      e.stopPropagation();
      _showAddSectionModal(sec.id);
    });

    // アクションボタン
    block.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      _editSectionMeta(sec);
    });
    block.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      _deleteSection(sec);
    });
    block.querySelector('[data-action="up"]').addEventListener('click', (e) => {
      e.stopPropagation();
      _moveSection(sec, -1);
    });
    block.querySelector('[data-action="down"]').addEventListener('click', (e) => {
      e.stopPropagation();
      _moveSection(sec, 1);
    });

    // 概要・本文の変更保存（デバウンス）- contenteditable=false の間は input イベントが発火しないため常時登録
    ['summary', 'content'].forEach(field => {
      const el = block.querySelector(`[data-field="${field}"]`);
      el.addEventListener('input', () => _debounceSave(sec.id, field, el));
      // Tabキーでインデント挿入
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && el.getAttribute('contenteditable') === 'true') {
          e.preventDefault();
          document.execCommand('insertText', false, '    ');
        }
      });
      // ペースト時: スタイル情報を除去し、改行・空白のみプレーンテキストとして挿入
      el.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        document.execCommand('insertText', false, text);
      });
    });

    container.appendChild(block);

    // 子セクションをsection-children内にレンダリング
    if (hasChildren && !isCollapsed) {
      const childrenContainer = block.querySelector('.section-children');
      children.sort((a, b) => a.order - b.order).forEach(child => {
        _renderDocSection(childrenContainer, child, allSorted, depth + 1);
      });
    }
  }

  /**
   * セクションのフィールド変更を2秒デバウンスしてAPIに保存する
   * contentフィールドの場合は入力中もリアルタイムで文字数表示を更新する
   * @param {string} sectionId - セクションID
   * @param {string} field - 保存するフィールド名（'summary' または 'content'）
   * @param {HTMLElement} el - 入力要素（innerTextを取得）
   */
  function _debounceSave(sectionId, field, el) {
    const key = `${sectionId}-${field}`;
    clearTimeout(_saveTimer[key]);
    // 入力中もリアルタイムで文字数更新（contentフィールドの場合）
    if (field === 'content') {
      const project = window.appState.getProject();
      if (project) {
        const sec = project.sections.find(s => s.id === sectionId);
        if (sec) sec[field] = el.innerText;
        _updateCharCount();
      }
    }
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
    }, 2000);
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
    _renderScopeSelect();
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
    _renderScopeSelect();
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
    _renderScopeSelect();
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
    _renderScopeSelect();
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
    _renderScopeSelect();
  }

  // ─── 文献・図表挿入ダイアログ ──────────────────────────

  /**
   * 現在のカーソル位置を _savedRange に保存する
   * カーソルが選択中セクションのcontentエリア内にない場合は null にリセットする
   */
  function _saveCursorPosition() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      // カーソルが選択中セクションの content 内にあるか確認
      const selectedId = window.appState.getSelectedSectionId();
      if (selectedId) {
        const contentEl = document.querySelector(`[data-field="content"][data-sec-id="${selectedId}"]`);
        if (contentEl && contentEl.contains(range.startContainer)) {
          _savedRange = range.cloneRange();
          return;
        }
      }
    }
    _savedRange = null;
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
   * 保存済みカーソル位置にテキストを挿入する
   * カーソル位置が無効な場合はcontentエリアの末尾に追加する
   * @param {string} sectionId - 挿入先のセクションID
   * @param {string} text - 挿入するテキスト
   */
  function _insertAtCursor(sectionId, text) {
    const contentEl = document.querySelector(`[data-field="content"][data-sec-id="${sectionId}"]`);
    if (!contentEl) return;

    // 保存済みカーソル位置を復元して挿入
    if (_savedRange && contentEl.contains(_savedRange.startContainer)) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(_savedRange);
      _savedRange.deleteContents();
      _savedRange.insertNode(document.createTextNode(text));
      sel.collapseToEnd();
    } else {
      // カーソル位置がない場合は末尾に追加
      const existing = contentEl.innerText;
      const separator = existing && !existing.endsWith('\n') ? '\n' : '';
      contentEl.innerText = existing + separator + text;
    }
    _savedRange = null;

    // input イベントを発火して自動保存をトリガー
    contentEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // _renderScopeSelect は chat-scope ドロップダウン廃止により削除済み
  function _renderScopeSelect() {}

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

  /**
   * セクションの階層深さに応じたビュレット記号を返す
   * @param {object} sec - 対象セクションオブジェクト
   * @param {Array} allSections - 全セクション配列
   * @returns {string} ビュレット記号（深さ1〜2: '•'、3以降: '▸'）
   */
  function _getBulletMark(sec, allSections) {
    const depth = _sectionDepth(sec, allSections);
    return depth === 1 ? '•' : depth === 2 ? '•' : '▸';
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
    _renderScopeSelect();
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
   * 選択中セクションに応じてドキュメントビューの編集モードを更新する
   * contenteditable・summary表示・フローティングアクションボタン・アウトライン選択状態を同期する
   */
  function _updateDocViewEditMode() {
    const selectedId = window.appState.getSelectedSectionId();

    document.querySelectorAll('.section-block').forEach(block => {
      const secId = block.dataset.secId;
      const isSelected = (secId === selectedId);

      // クラス更新
      block.classList.toggle('selected', isSelected);

      // contenteditable更新 + summaryの表示切り替え
      // data-sec-id でフィルタして、ネストした子セクションの要素に影響しないようにする
      const summaryEl = block.querySelector(`[data-field="summary"][data-sec-id="${secId}"]`);
      if (summaryEl) {
        summaryEl.setAttribute('contenteditable', isSelected);
        summaryEl.classList.toggle('hidden', !isSelected);
      }
      const contentEl = block.querySelector(`[data-field="content"][data-sec-id="${secId}"]`);
      if (contentEl) {
        contentEl.setAttribute('contenteditable', isSelected);
      }

      // アウトラインの選択状態も更新
      const outlineItem = document.querySelector(`.outline-item[data-id="${secId}"]`);
      if (outlineItem) {
        outlineItem.classList.toggle('selected', isSelected);
        outlineItem.classList.toggle('active', isSelected);
      }
    });

    // 選択中セクションにフローティングアクションボタンを表示
    document.querySelectorAll('.section-floating-actions').forEach(el => el.remove());

    if (selectedId) {
      const selectedBlock = document.querySelector(`#sec-block-${selectedId}`);
      if (selectedBlock) {
        const contentWrapper = selectedBlock.querySelector('.section-content-wrapper');
        if (contentWrapper) {
          const floatingActions = document.createElement('div');
          floatingActions.className = 'section-floating-actions';
          floatingActions.innerHTML = `
            <button class="btn btn-sm btn-secondary" data-action="insert-ref" data-sec-id="${selectedId}">文献挿入</button>
            <button class="btn btn-sm btn-secondary" data-action="insert-fig" data-sec-id="${selectedId}">図表挿入</button>
          `;
          contentWrapper.appendChild(floatingActions);

          // ボタンイベントバインド
          floatingActions.querySelector('[data-action="insert-ref"]').addEventListener('click', (e) => {
            e.stopPropagation();
            _showInsertRefDialog(selectedId);
          });
          floatingActions.querySelector('[data-action="insert-fig"]').addEventListener('click', (e) => {
            e.stopPropagation();
            _showInsertFigDialog(selectedId);
          });
        }
      }
    } else {
      // 全セクション非選択時はスコープを「全セクション(骨子)」に戻す
      AppShell.setCurrentScope('all');
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
    _renderScopeSelect();
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
  }

  /**
   * EditTabの状態をリセットする
   * プロジェクト・タイマー・ドラッグ状態・折りたたみ状態を初期化する
   */
  function reset() {
    _project = null;
    _saveTimer = {};
    _dragState = null;
    _collapsed = {};
    _secCollapsed = {};
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
