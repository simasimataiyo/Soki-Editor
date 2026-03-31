import { ApiClient } from './api-client.js';
import { showToast, dismissToast } from './toast.js';
import { appState } from './state-manager.js';
import { Modal } from './modal.js';
import { escHtml } from './dom-utils.js';
import { SVG_CHEVRON_RIGHT, SVG_CHEVRON_DOWN, SVG_DOCUMENT, SVG_DELETE } from './svg-icons.js';

/**
 * SourceTab — ソース管理 U
 */

export const SourceTab = (() => {
  let _project = null;
  let _activeId = null;
  let _tiptapEditor = null;

  const DEFAULT_SOURCE_NAME = '新しいソース';
  const _APP_TOKEN = ApiClient.getAppToken();
  const SOURCE_TEXT_EXTENSIONS = ['.txt', '.md', '.pdf', '.csv', '.docx', '.xlsx', '.pptx'];
  const SOURCE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'];
  const SOURCE_UPLOAD_EXTENSIONS = [...SOURCE_TEXT_EXTENSIONS, ...SOURCE_IMAGE_EXTENSIONS];
  const SOURCE_TEXT_ACCEPT = SOURCE_TEXT_EXTENSIONS.join(',');

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

  /** ファイル名から拡張子を除いた文字列を返す */
  function _stemName(filename) {
    return filename.replace(/\.[^.]+$/, '');
  }

  /**
   * ソース名が初期値のままであればファイル名に置き換えてサーバーへ保存する
   * 文献情報のタイトルも未設定であれば同じ値を充てる
   */
  async function _applyFileNameIfDefault(project, updated, filename) {
    if (updated.name !== DEFAULT_SOURCE_NAME) return;
    const newName = _stemName(filename);
    if (!newName) return;
    const patch = { name: newName };
    if (!updated.bibliography?.title) {
      patch.bibliography = { ...updated.bibliography, title: newName };
    }
    try {
      const renamed = await ApiClient.put(
        `/api/projects/${project.id}/sources/${updated.id}`,
        patch
      );
      const idx = project.sources.findIndex(s => s.id === updated.id);
      if (idx >= 0) project.sources[idx] = renamed;
    } catch (_) {}
  }

  const BIB_TYPE_LABELS = {
    paper: '論文', book: '図書', book_chapter: '図書の一部', web: 'Web', resource: 'リソース'
  };
  const BIB_TYPES_ORDER = ['paper', 'book', 'book_chapter', 'web', 'resource'];

  /** 参考文献フォーマットのデフォルト定義（サーバー側と同期すること） */
  const DEFAULT_CITATION_FORMATS = {
    paper: [
      { field: 'author', prefix: '', suffix: '' },
      { field: 'year', prefix: '(', suffix: ')' },
      { field: 'title', prefix: '『', suffix: '』' },
      { field: 'journal', prefix: '', suffix: '' },
      { field: 'volume', prefix: '', suffix: '' },
      { field: 'issue', prefix: '(', suffix: ')' },
      { field: 'pages', prefix: ':', suffix: '' },
    ],
    book: [
      { field: 'author', prefix: '', suffix: '' },
      { field: 'year', prefix: '(', suffix: ')' },
      { field: 'title', prefix: '『', suffix: '』' },
      { field: 'publisher', prefix: '', suffix: '' },
      { field: 'publication_place', prefix: '', suffix: '' },
    ],
    book_chapter: [
      { field: 'author', prefix: '', suffix: '' },
      { field: 'year', prefix: '(', suffix: ')' },
      { field: 'title', prefix: '『', suffix: '』' },
      { field: 'editor', prefix: '', suffix: '(編)' },
      { field: 'publisher', prefix: '', suffix: '' },
      { field: 'pages', prefix: 'pp.', suffix: '' },
    ],
    web: [
      { field: 'author', prefix: '', suffix: '' },
      { field: 'year', prefix: '(', suffix: ')' },
      { field: 'title', prefix: '', suffix: '' },
      { field: 'site_name', prefix: '', suffix: '' },
      { field: 'url', prefix: '', suffix: '' },
      { field: 'accessed_date', prefix: '[参照: ', suffix: ']' },
    ],
    resource: [
      { field: 'author', prefix: '', suffix: '' },
      { field: 'year', prefix: '(', suffix: ')' },
      { field: 'title', prefix: '', suffix: '' },
    ],
  };

  /** 参考文献フォーマットで選択可能なフィールドの選択肢 */
  const CITATION_FIELD_OPTIONS = [
    { value: 'author', label: '著者' },
    { value: 'title', label: 'タイトル' },
    { value: 'year', label: '出版年' },
    { value: 'journal', label: '掲載誌' },
    { value: 'volume', label: '巻数' },
    { value: 'issue', label: '号数' },
    { value: 'pages', label: 'ページ' },
    { value: 'publisher', label: '出版社' },
    { value: 'publication_place', label: '出版地' },
    { value: 'editor', label: '編者' },
    { value: 'url', label: 'URL' },
    { value: 'site_name', label: 'サイト名' },
    { value: 'accessed_date', label: '参照日' },
    { value: 'created_date', label: '作成日' },
    { value: 'other', label: 'その他' },
    { value: 'literal', label: '固定テキスト' },
  ];

  // 折りたたみ状態（右パネルセクション用）
  let _sectionCollapsed = {};

  // 左パネルカテゴリグループの折りたたみ状態
  let _groupCollapsed = {};

  // 検索フィルター文字列
  let _searchFilter = '';

  // DnD 状態
  let _sourceDragState = null; // { draggedId, targetId, position, draggedGroupType }
  let _isDraggingItem = false; // アイテムDnD中フラグ（ファイルDnDと区別）

  // Auto-Process 状態 Map<srcId, 'summarizing'|'extracting'|'done'|'error'>
  const _autoProcessState = new Map();

  // 保存タイマー（モジュールレベル、一元管理）
  let _pendingSaveTimer = null;
  let _pendingSaveId = null;

  // 処理中状態（非同期操作の追跡）Map<srcId, Set<'summary'|'bibliography'|'fullText'>>
  const _processingState = new Map();

  /** 表示用タイトル: 文献情報のタイトル → name のフォールバック */
  function _displayTitle(src) {
    return src.bibliography?.title || src.name;
  }

  /**
   * ソース名編集モーダルを開き、名前を更新する
   * モーダル内の削除ボタンから _deleteSource も呼び出せる
   * @param {object} src - 編集対象のソースオブジェクト
   */
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
          onClick: async (_formData, _overlay, resolve, closeModal) => {
            const deleted = await _deleteSource(src);
            if (deleted) {
              // 削除成功: _closeAllが確認OKで既に呼ばれているが念のため
              resolve(null);
              closeModal();
            }
            // 削除キャンセル時は何もしない（フォームモーダルに戻っている）
          },
        },
      ],
    });
    if (result === null) return;

    const newName = result.name.trim();
    if (!newName || newName === src.name) return;

    const project = appState.getProject();
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

  /** デバウンス保存をスケジュール（全保存タイマーを一元管理） */
  function _scheduleSave(srcId) {
    if (_pendingSaveTimer) clearTimeout(_pendingSaveTimer);
    _pendingSaveId = srcId;
    _pendingSaveTimer = setTimeout(() => {
      _pendingSaveTimer = null;
      _pendingSaveId = null;
      _saveSource(srcId);
    }, 2000);
  }

  /** 保留中の保存を即時フラッシュ（DOM切替前に呼ぶこと） */
  function _flushPendingSave() {
    if (_pendingSaveTimer) {
      clearTimeout(_pendingSaveTimer);
      _pendingSaveTimer = null;
      const id = _pendingSaveId;
      _pendingSaveId = null;
      if (id) _saveSource(id);
    }
  }

  /** 保留中の保存をキャンセル（AI操作前など） */
  function _cancelPendingSave() {
    if (_pendingSaveTimer) {
      clearTimeout(_pendingSaveTimer);
      _pendingSaveTimer = null;
      _pendingSaveId = null;
    }
  }

  /** 処理開始を記録し、アクティブな場合は再レンダリング */
  function _startProcessing(srcId, field) {
    if (!_processingState.has(srcId)) _processingState.set(srcId, new Set());
    _processingState.get(srcId).add(field);
    if (srcId === _activeId) {
      _renderList();
      _renderDetail(srcId);
    }
  }

  /** 処理完了を記録し、アクティブな場合は再レンダリング */
  function _stopProcessing(srcId, field) {
    const fields = _processingState.get(srcId);
    if (fields) {
      fields.delete(field);
      if (fields.size === 0) _processingState.delete(srcId);
    }
    if (srcId === _activeId) {
      _renderList();
      _renderDetail(srcId);
    }
  }

  /** 指定フィールドが処理中か確認 */
  function _isProcessing(srcId, field) {
    return _processingState.get(srcId)?.has(field) ?? false;
  }

  /**
   * ソースタブ全体を再描画する（タブ切替・プロジェクト更新時に呼ぶ）
   * 保留中の自動保存をフラッシュしてからリストと詳細を再描画する
   * @param {object} project - 現在のプロジェクトオブジェクト
   */
  function render(project) {
    _flushPendingSave();
    _project = project;
    
    
    if(!_activeId && _project.sources.length ){
      _activeId = _project.sources[0]["id"];
    }

    if (_activeId){
      _renderDetail(_activeId);
    }else document.getElementById('source-detail').innerHTML =
      '<p class="placeholder-text">ソースを選択してください</p>';
      
    _renderList();
  }

  /**
   * ソース一覧（左ペイン）を再描画する
   * カテゴリ別グループヘッダーと折りたたみ、検索フィルターに対応
   */
  function _renderList() {
    const list = document.getElementById('source-list');
    list.innerHTML = '';

    const filter = _searchFilter.toLowerCase();
    const sources = filter
      ? _project.sources.filter(s =>
          _displayTitle(s).toLowerCase().includes(filter) ||
          (s.name || '').toLowerCase().includes(filter)
        )
      : _project.sources;

    // カテゴリ別にグループ化
    const groups = {};
    BIB_TYPES_ORDER.forEach(t => { groups[t] = []; });
    sources.forEach(src => {
      const t = src.bibliography?.type || 'paper';
      (groups[t] = groups[t] || []).push(src);
    });

    BIB_TYPES_ORDER.forEach(type => {
      const items = groups[type];
      if (items.length === 0) return;

      // グループヘッダー li
      const headerLi = document.createElement('li');
      headerLi.className = 'source-group-header';
      headerLi.dataset.groupType = type;
      const isCollapsed = !!_groupCollapsed[type];
      headerLi.innerHTML = `
        <span class="chevron">${isCollapsed ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
        <span class="group-label">${BIB_TYPE_LABELS[type]}</span>
        <span class="group-count">${items.length}</span>
      `;
      headerLi.addEventListener('click', () => {
        _groupCollapsed[type] = !_groupCollapsed[type];
        _renderList();
      });
      list.appendChild(headerLi);

      if (!isCollapsed) {
        items.forEach(src => {
          const li = _createSourceListItem(src, type);
          list.appendChild(li);
        });
      }
    });
  }

  /**
   * ソースリストアイテム li を生成してイベントをバインドする
   */
  function _createSourceListItem(src, groupType) {
    const li = document.createElement('li');
    li.dataset.id = src.id;
    li.dataset.groupType = groupType;
    if (src.id === _activeId) li.classList.add('active');
    li.draggable = true;

    const autoState = _autoProcessState.get(src.id);
    const processingHtml = autoState && autoState !== 'done'
      ? `<span class="source-auto-processing">
           <span class="section-spinner"></span>
           <span>${_autoProcessLabel(autoState)}</span>
         </span>`
      : '';

    li.innerHTML = `
      <span class="source-drag-handle" title="ドラッグして並べ替え">⠿</span>
      ${SVG_DOCUMENT}
      <span class="item-name">${escHtml(_displayTitle(src))}</span>
      ${processingHtml}
      <button class="btn-icon item-delete-btn" title="削除">${SVG_DELETE}</button>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.source-drag-handle')) return;
      _flushPendingSave();
      _activeId = src.id;
      appState.setState({ activeSourceId: src.id });
      _renderList();
      _renderDetail(src.id);
    });

    li.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      _editSourceName(src);
    });

    li.querySelector('.item-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      _deleteSource(src);
    });

    _bindSourceItemDnD(li, src, groupType);
    return li;
  }

  function _autoProcessLabel(state) {
    if (state === 'summarizing') return '要約中';
    if (state === 'extracting') return '文献抽出中';
    if (state === 'error') return 'エラー';
    return '処理中';
  }

  /**
   * ソースリストアイテムへ DnD イベントをバインドする（同カテゴリ内のみ）
   */
  function _bindSourceItemDnD(li, src, groupType) {
    li.addEventListener('dragstart', (e) => {
      _isDraggingItem = true;
      _sourceDragState = { draggedId: src.id, targetId: null, position: null, draggedGroupType: groupType };
      li.classList.add('source-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', src.id);
    });

    li.addEventListener('dragend', () => {
      _isDraggingItem = false;
      li.classList.remove('source-dragging');
      document.querySelectorAll('#source-list li').forEach(el => {
        el.classList.remove('source-drag-over-before', 'source-drag-over-after');
      });
      _sourceDragState = null;
    });

    li.addEventListener('dragover', (e) => {
      if (!_sourceDragState) return;
      if (_sourceDragState.draggedId === src.id) return;
      // 異なるカテゴリへのドロップは無効化
      if (_sourceDragState.draggedGroupType !== groupType) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.preventDefault();

      const rect = li.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const position = y < rect.height / 2 ? 'before' : 'after';

      document.querySelectorAll('#source-list li').forEach(el => {
        el.classList.remove('source-drag-over-before', 'source-drag-over-after');
      });
      li.classList.add(`source-drag-over-${position}`);
      _sourceDragState.targetId = src.id;
      _sourceDragState.position = position;
    });

    li.addEventListener('dragleave', (e) => {
      const rect = li.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top  || e.clientY > rect.bottom) {
        li.classList.remove('source-drag-over-before', 'source-drag-over-after');
      }
    });

    li.addEventListener('drop', async (e) => {
      if (!_sourceDragState || !_sourceDragState.targetId) return;
      if (_sourceDragState.draggedGroupType !== groupType) return;
      e.preventDefault();
      e.stopPropagation();

      const { draggedId, targetId, position } = _sourceDragState;
      if (draggedId === targetId) return;

      await _handleSourceReorder(draggedId, targetId, position);
    });
  }

  /**
   * ソース並べ替え処理（楽観的 UI 更新 → API 送信）
   */
  async function _handleSourceReorder(draggedId, targetId, position) {
    const project = appState.getProject();
    const sources = [...project.sources];
    const fromIdx = sources.findIndex(s => s.id === draggedId);
    const toIdx   = sources.findIndex(s => s.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const [dragged] = sources.splice(fromIdx, 1);
    const newToIdx = sources.findIndex(s => s.id === targetId);
    const insertAt = position === 'before' ? newToIdx : newToIdx + 1;
    sources.splice(insertAt, 0, dragged);

    // 楽観的更新
    project.sources = sources;
    _renderList();

    try {
      await ApiClient.post(
        `/api/projects/${project.id}/sources/reorder`,
        { ordered_ids: sources.map(s => s.id) }
      );
    } catch (_) {
      showToast('並べ替えに失敗しました', 'error');
      // ロールバック
      const orig = await ApiClient.get(`/api/projects/${project.id}`);
      project.sources = orig.sources;
      _renderList();
    }
  }

  /**
   * 左パネルへの複数ファイルドロップを処理する
   * ファイルごとに新規ソースを作成し、auto-process が有効な場合は要約・文献情報抽出も実行する
   */
  async function _bulkCreateSources(files, autoProcess) {
    const project = appState.getProject();

    const validFiles = files.filter(f => {
      const ext = '.' + f.name.split('.').pop().toLowerCase();
      return SOURCE_UPLOAD_EXTENSIONS.includes(ext);
    });

    if (validFiles.length === 0) {
      showToast('対応しているファイル形式がありません', 'error');
      return;
    }
    const skipped = files.length - validFiles.length;
    if (skipped > 0) {
      showToast(`${skipped} 件のファイルは非対応形式のためスキップします`, 'info');
    }

    let addedCount = 0;
    for (const file of validFiles) {
      try {
        // ソース作成
        const src = await ApiClient.post(`/api/projects/${project.id}/sources`);
        project.sources.push(src);
        _renderList();

        // ファイルアップロード
        const formData = new FormData();
        formData.append('file', file);
        const res = await _authFetch(
          `/api/projects/${project.id}/sources/${src.id}/read-file-upload`,
          { method: 'POST', body: formData }
        );
        if (!res.ok) {
          showToast(`${file.name}: アップロードに失敗しました`, 'error');
          continue;
        }
        let updated = await res.json();

        // ファイル名をソース名に適用
        await _applyFileNameIfDefault(project, updated, file.name);
        const refreshed = project.sources.find(s => s.id === updated.id);
        if (refreshed) updated = refreshed;

        const idx = project.sources.findIndex(s => s.id === updated.id);
        if (idx >= 0) project.sources[idx] = updated;
        _renderList();

        // Auto-Process
        if (autoProcess && updated.full_text) {
          _autoProcessSource(project, updated); // 非同期（awaitしない = 並列処理）
        }

        addedCount++;
      } catch (_) {
        showToast(`${file.name}: 処理中にエラーが発生しました`, 'error');
      }
    }

    if (addedCount > 0) {
      showToast(`${addedCount} 件のソースを追加しました`, 'success');
    }
  }

  /**
   * ソースの要約・文献情報抽出をバックグラウンドで実行する
   * 左パネルのスピナーのみ更新し、右パネルには干渉しない
   */
  async function _autoProcessSource(project, src) {
    // 要約
    _autoProcessState.set(src.id, 'summarizing');
    _renderList();
    try {
      const summarized = await ApiClient.post(
        `/api/projects/${project.id}/sources/${src.id}/summarize`
      );
      const idx = project.sources.findIndex(s => s.id === src.id);
      if (idx < 0) { _autoProcessState.delete(src.id); return; } // 削除済み
      project.sources[idx] = summarized;
      // アクティブソースの右パネルも更新
      if (_activeId === src.id) _renderDetail(src.id);
    } catch (_) {
      _autoProcessState.set(src.id, 'error');
      _renderList();
      showToast(`${_displayTitle(src)}: 要約生成に失敗しました`, 'error');
      setTimeout(() => { _autoProcessState.delete(src.id); _renderList(); }, 3000);
      return;
    }

    // 文献情報抽出
    _autoProcessState.set(src.id, 'extracting');
    _renderList();
    try {
      const extracted = await ApiClient.post(
        `/api/projects/${project.id}/sources/${src.id}/extract-bibliography`
      );
      const idx = project.sources.findIndex(s => s.id === src.id);
      if (idx < 0) { _autoProcessState.delete(src.id); return; }
      project.sources[idx] = extracted;
      if (_activeId === src.id) _renderDetail(src.id);
    } catch (_) {
      _autoProcessState.set(src.id, 'error');
      _renderList();
      showToast(`${_displayTitle(src)}: 文献情報抽出に失敗しました`, 'error');
      setTimeout(() => { _autoProcessState.delete(src.id); _renderList(); }, 3000);
      return;
    }

    _autoProcessState.set(src.id, 'done');
    _renderList();
    setTimeout(() => { _autoProcessState.delete(src.id); _renderList(); }, 2000);
  }

  /**
   * ソース左パネルへのファイルドロップイベントをバインドする
   * アイテム DnD 中は無視し、ファイルのみ反応する
   */
  function _bindLeftPanelFileDrop() {
    const panel = document.getElementById('source-panel');

    panel.addEventListener('dragenter', (e) => {
      if (_isDraggingItem) return;
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      panel.classList.add('panel-file-drop-active');
    });

    panel.addEventListener('dragover', (e) => {
      if (_isDraggingItem) return;
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    panel.addEventListener('dragleave', (e) => {
      if (_isDraggingItem) return;
      if (panel.contains(e.relatedTarget)) return;
      panel.classList.remove('panel-file-drop-active');
    });

    panel.addEventListener('drop', async (e) => {
      if (_isDraggingItem) return;
      panel.classList.remove('panel-file-drop-active');
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      let autoProcess = true;
      try {
        const settings = await ApiClient.get('/api/settings');
        autoProcess = settings.auto_process_on_drop ?? true;
      } catch (_) {}

      await _bulkCreateSources(files, autoProcess);
    });
  }

  /**
   * ソース詳細ペイン（右ペイン）を再描画する
   * 文献情報・要約・内容・設定の各折りたたみセクションと
   * ドラッグ＆ドロップ、自動保存イベントを設定する
   * @param {string} sourceId - 表示するソースのID
   */
  function _renderDetail(sourceId) {
    const src = _project.sources.find(s => s.id === sourceId);
    if (!src) return;
    const pane = document.getElementById('source-detail');
    const b = src.bibliography;

    // 処理中フラグ
    const summaryProc    = _isProcessing(src.id, 'summary');
    const bibProc        = _isProcessing(src.id, 'bibliography');
    const fullTextProc   = _isProcessing(src.id, 'fullText');
    const SPINNER = '<span class="section-spinner"></span>';

    pane.innerHTML = `
      <div class="pane-drag-overlay">
        <span class="pane-drag-overlay-text">ファイルをドラッグアンドドロップ...</span>
      </div>
      <div class="source-detail-scroll">
        <!-- タイトルバー -->
        <div class="detail-title-bar">
          <h2>${escHtml(_displayTitle(src))}</h2>
        </div>

        <!-- 内容セクション -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="content">
            <span class="chevron">${_sectionCollapsed['content'] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
            <h3>内容${fullTextProc ? SPINNER : ''}</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['content'] ? ' collapsed' : ''}">
            <div class="form-group" style="margin-bottom:12px">
              <label>全文</label>
              <textarea class="form-control" id="src-full-text" rows="10" ${fullTextProc ? 'disabled' : ''}>${escHtml(src.full_text)}</textarea>
            </div>
            
            <div class="form-group" style="margin-bottom:12px">
              <label>ファイルパス</label>
              <input type="text" class="form-control" id="src-file-path" value="${escHtml(src.file_path || '')}" readonly />
            </div>

            <div class="source-actions">
              <button class="btn btn-secondary btn-sm" id="btn-analyze-image" ${fullTextProc ? 'disabled' : ''}>画像解説を追加</button>
              <button class="btn btn-secondary btn-sm" id="btn-read-file" ${fullTextProc ? 'disabled' : ''}>ファイル読み込み</button>
              <button class="btn btn-primary btn-sm" id="btn-save-source" ${fullTextProc ? 'disabled' : ''}>保存</button>
            </div>

          </div>
        </div>

        <!-- 要約セクション -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="summary">
            <span class="chevron">${_sectionCollapsed['summary'] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
            <h3>要約${summaryProc ? SPINNER : ''}</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['summary'] ? ' collapsed' : ''}">
            <textarea class="form-control" id="src-summary" rows="5" ${summaryProc ? 'disabled' : ''}>${escHtml(src.summary)}</textarea>
          </div>

          <!-- 長い要約 -->
          <div class="collapsible-header" data-section="extended-summary">
            <span class="chevron">${_sectionCollapsed['extended-summary'] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
            <h3>長い要約${summaryProc ? SPINNER : ''}</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['extended-summary'] ? ' collapsed' : ''}">
            <textarea class="form-control" id="src-extended-summary" rows="8" ${summaryProc ? 'disabled' : ''}>${escHtml(src.extended_summary)}</textarea>
          </div>
          <div class="source-actions">
            <button class="btn btn-secondary btn-sm" id="btn-summarize" ${summaryProc ? 'disabled' : ''}>要約更新</button>
          </div>
        </div>

        <!-- 文献情報セクション -->
        <div class="collapsible-section">
          <div class="collapsible-header" data-section="bibliography">
            <span class="chevron">${_sectionCollapsed['bibliography'] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
            <h3>文献情報${bibProc ? SPINNER : ''}</h3>
          </div>
          <div class="collapsible-body${_sectionCollapsed['bibliography'] ? ' collapsed' : ''}">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div class="form-group" style="flex:1;max-width:200px">
                <label>種類</label>
                <select class="form-control" id="src-bib-type" ${bibProc ? 'disabled' : ''}>
                  ${Object.entries(BIB_TYPE_LABELS).map(([v, l]) =>
                    `<option value="${v}" ${b.type===v?'selected':''}>${l}</option>`
                  ).join('')}
                </select>
              </div>
              <div class="toggle-group">
                <label>参考文献リストに掲載</label>
                <label class="toggle-switch">
                  <input type="checkbox" id="src-include" ${b.include_in_references?'checked':''} ${bibProc ? 'disabled' : ''} />
                  <span class="slider"></span>
                </label>
              </div>
            </div>

            <div class="source-actions" style="margin-top:8px">
              <button class="btn btn-secondary btn-sm" id="btn-extract-bib" ${bibProc ? 'disabled' : ''}>文献情報取得</button>
              <button class="btn btn-secondary btn-sm" id="btn-citation-format" title="この種類の参考文献表記フォーマットを設定">表記設定</button>
            </div>
            <div id="bib-fields"></div>
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
    document.getElementById('btn-save-source').addEventListener('click', async () => {
      _cancelPendingSave();
      await _saveSource(src.id);
      showToast('保存しました', 'success');
    });
    document.getElementById('btn-summarize').addEventListener('click', () => _summarize(src));
    document.getElementById('btn-extract-bib').addEventListener('click', () => _extractBibliography(src));
    document.getElementById('btn-citation-format').addEventListener('click', () => {
      const currentType = document.getElementById('src-bib-type')?.value || src.bibliography.type;
      _showCitationFormatModal(currentType);
    });

    // ─── ペイン全体ドラッグ&ドロップ ───────────────────────────
    const overlay = pane.querySelector('.pane-drag-overlay');

    /**
     * ドラッグオーバーレイの位置・サイズを詳細ペインに合わせて同期する
     */
    function _syncOverlay() {
      const r = pane.getBoundingClientRect();
      overlay.style.top    = r.top    + 'px';
      overlay.style.left   = r.left   + 'px';
      overlay.style.width  = r.width  + 'px';
      overlay.style.height = r.height + 'px';
    }

    /**
     * ドロップされたファイルをサーバーへアップロードしてソースの全文を更新する
     * PDFを再読み込みした場合は画像認識モーダルを閉じる
     * @param {File} file - ドロップされたファイル
     */
    async function _handleFileDrop(file) {
      const project = appState.getProject();
      const formData = new FormData();
      formData.append('file', file);
      _cancelPendingSave();
      _startProcessing(src.id, 'fullText');  // 全文フィールド無効化（ブロッキングオーバーレイなし）
      const loadingToast = showToast('ファイルを読み込み中...', 'info', { persistent: true, spinner: true });
      try {
        const res = await _authFetch(
          `/api/projects/${project.id}/sources/${src.id}/read-file-upload`,
          { method: 'POST', body: formData }
        );
        if (!res.ok) {
          showToast('読み込み失敗', 'error');
          dismissToast(loadingToast);
          _stopProcessing(src.id, 'fullText');
          return;
        }
        const updated = await res.json();
        const idx = project.sources.findIndex(s => s.id === src.id);
        if (idx >= 0) project.sources[idx] = updated;
        await _applyFileNameIfDefault(project, updated, file.name);
        // PDFを再読み込みした場合は画像認識モーダルを閉じる（サムネイルが更新されるため）
        const modalOverlay = document.querySelector('.modal-overlay');
        if (modalOverlay && modalOverlay.querySelector('.pdf-page-grid')) {
          modalOverlay.remove();
        }
        dismissToast(loadingToast);
        _stopProcessing(src.id, 'fullText');  // 再レンダリング（最新データ表示）
        showToast('ファイルを読み込みました', 'success');
      } catch (_) {
        dismissToast(loadingToast);
        _stopProcessing(src.id, 'fullText');
        showToast('ファイル読み込みに失敗しました', 'error');
      }
    }

    // pane の dragenter でファイルドラッグを検知してオーバーレイを表示
    pane.addEventListener('dragenter', (e) => {
      if (_isDraggingItem) return; // アイテムDnD中はファイルドロップオーバーレイを表示しない
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      _syncOverlay()
      pane.classList.add('pane-drag-active');
    });

    // オーバーレイだけで dragleave/dragover/drop を受け取る
    overlay.addEventListener('dragleave', (e) => {
      // オーバーレイ外に出た場合のみ非表示（子要素への移動は無視）
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

    // 自動保存（モジュールレベルタイマーで一元管理）
    pane.querySelectorAll('input:not([readonly]), textarea, select').forEach(el => {
      el.addEventListener('input', () => _scheduleSave(src.id));
      el.addEventListener('change', () => _scheduleSave(src.id));
    });
  }

  /**
   * 文献種類に応じた入力フィールド群を #bib-fields に描画する
   * タイトルフィールド変更時はリストのタイトル表示をリアルタイム更新する
   * @param {string} type - 文献種類 ('paper' | 'book' | 'book_chapter' | 'web' | 'resource')
   */
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

    // 新しいフィールドにも自動保存をバインド（モジュールレベルタイマー使用）
    container.querySelectorAll('.bib-field').forEach(el => {
      el.addEventListener('input', () => {
        _scheduleSave(src.id);
        // タイトル変更時は最新のソースオブジェクトを使用
        if (el.dataset.field === 'title') {
          const project = appState.getProject();
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

  /**
   * 詳細ペインの現在値をサーバーへ保存する
   * 別のソースに切り替わっていた場合はスキップし、文献タイトルをソース名に同期する
   * @param {string} srcId - 保存するソースのID
   */
  async function _saveSource(srcId) {
    // ガード: 現在表示中のソースでなければスキップ（切替後の古いタイマーから保護）
    if (srcId !== _activeId) return;

    const project = appState.getProject();
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
      extended_summary: document.getElementById('src-extended-summary')?.value || '',
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

  /**
   * 確認ダイアログを表示してソースを削除する
   * @param {object} src - 削除するソースオブジェクト
   * @returns {boolean} 削除が完了した場合は true、キャンセルまたは失敗した場合は false
   */
  async function _deleteSource(src) {
    if (!(await Modal.confirm(`「${_displayTitle(src)}」を削除しますか？`))) return false;
    const project = appState.getProject();
    try {
      await ApiClient.delete(`/api/projects/${project.id}/sources/${src.id}`);
      project.sources = project.sources.filter(s => s.id !== src.id);
      _activeId = null;
      render(project);
      // バックエンドで更新された content を取得してTiptapに反映
      try {
        const result = await ApiClient.get(`/api/projects/${project.id}/content`);
        project.content = result.content;
        if (_tiptapEditor) _tiptapEditor.setContentFromMarkdown(project.content);
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * ファイルピッカーを開いてファイルをアップロードし、ソースの全文を更新する
   * 対応形式: .txt / .md / .pdf / .csv / .docx / .xlsx / .pptx
   * @param {object} src - 対象のソースオブジェクト
   */
  async function _readFile(src) {
    const project = appState.getProject();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = SOURCE_TEXT_ACCEPT;
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      _cancelPendingSave();
      _startProcessing(src.id, 'fullText');
      const loadingToast = showToast('ファイルを読み込み中...', 'info', { persistent: true, spinner: true });
      try {
        const res = await _authFetch(`/api/projects/${project.id}/sources/${src.id}/read-file-upload`, {
          method: 'POST', body: formData,
        });
        if (!res.ok) {
          const d = await res.json();
          showToast(d.detail || 'エラー', 'error');
          dismissToast(loadingToast);
          _stopProcessing(src.id, 'fullText');
          return;
        }
        const updated = await res.json();
        const idx = project.sources.findIndex(s => s.id === src.id);
        if (idx >= 0) project.sources[idx] = updated;
        await _applyFileNameIfDefault(project, updated, file.name);
        // PDFを再読み込みした場合は画像認識モーダルを閉じる（サムネイルが更新されるため）
        const modalOverlay = document.querySelector('.modal-overlay');
        if (modalOverlay && modalOverlay.querySelector('.pdf-page-grid')) {
          modalOverlay.remove();
        }
        dismissToast(loadingToast);
        _stopProcessing(src.id, 'fullText');
        showToast('ファイルを読み込みました', 'success');
      } catch (_) {
        dismissToast(loadingToast);
        _stopProcessing(src.id, 'fullText');
        showToast('ファイル読み込みに失敗しました', 'error');
      }
    };
    input.click();
  }

  /**
   * 画像認識を実行する入口関数
   * PDFソースの場合は保存済みサムネイルを使ったページ選択フローへ、
   * それ以外はファイルピッカーで画像またはPDFを選択させる
   * @param {object} src - 対象のソースオブジェクト
   */
  async function _analyzeImage(src) {
    const project = appState.getProject();

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
      const loadingToast = showToast('画像解析中...', 'success',{ persistent: true, spinner: true });
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await _authFetch(`/api/projects/${project.id}/sources/${src.id}/analyze-image-upload`, {
          method: 'POST', body: formData,
        });
        if (!res.ok) { const d = await res.json(); showToast(d.detail || 'エラー', 'error'); return; }
        const updated = await res.json();
        const idx = project.sources.findIndex(s => s.id === src.id);
        if (idx >= 0) project.sources[idx] = updated;
        _renderDetail(src.id);
        dismissToast(loadingToast);
        showToast('画像解析完了', 'success');
      } catch (_) {
        dismissToast(loadingToast);
        showToast('画像解析に失敗しました', 'error');
      }
    };
    input.click();
  }

  /**
   * 保存済みサムネイルを使ってPDFページを選択し、Vision解析する
   * サムネイルをAPIから取得して _showPdfAnalysisModal に渡す
   * @param {object} src - 対象のソースオブジェクト（file_type === 'pdf'）
   */
  async function _analyzeSavedPdfPages(src) {
    const project = appState.getProject();

    let pageList;
    try {
      const res = await _authFetch(`/api/projects/${project.id}/sources/${src.id}/pdf-page-list`);
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
      src: _withApiToken(`/api/files?path=${encodeURIComponent(p.thumbnail_path)}&project_id=${project.id}`),
    }));

    _showPdfAnalysisModal(src, thumbnails, null);
  }

  /**
   * アップロードされたPDFファイルからサムネイルを生成してページ選択・Vision解析を行う
   * @param {object} src - 対象のソースオブジェクト
   * @param {File} file - ユーザーが選択したPDFファイル
   */
  async function _analyzePdfWithPageSelection(src, file) {
    const project = appState.getProject();
    showToast('PDFを読み込み中...', 'success');

    const formData1 = new FormData();
    formData1.append('file', file);
    let thumbnails;
    try {
      const res = await _authFetch(
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
    const project = appState.getProject();

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
    let _maxCharsPerPage = null;

    /**
     * モーダルを閉じ、進行中のストリーミングをキャンセルする
     */
    function _closeModal() {
      if (abortController) abortController.abort();
      overlay.remove();
    }

    // ── ページ選択画面 ────────────────────────────────────────
    /**
     * PDFのサムネイル一覧を表示し、解析するページをチェックボックスで複数選択させる
     */
    function _showPageSelect(preselectedPages = null) {
      const thumbsHtml = thumbnails.map(t => `
        <label class="pdf-page-thumb">
          <input type="checkbox" name="pdf-page-check" value="${t.page}" />
          <img src="${escHtml(t.src || t.data || '')}" alt="${escHtml(t.label)}" />
          <span class="pdf-page-label">${escHtml(t.label)}</span>
        </label>
      `).join('');
      const initialMaxChars = _maxCharsPerPage ? String(_maxCharsPerPage) : '';

      modal.innerHTML = `
        <div class="pdf-modal-header">
          <h3>ページを選択</h3>
          <button class="pdf-modal-close" title="閉じる">×</button>
        </div>
        <p style="color:var(--color-text-muted);font-size:13px;margin-bottom:8px">解析するページを選択してください（複数選択可）</p>
        <div class="form-group" style="margin-bottom:12px">
          <label>1ページあたりの最大文字数（省略可）</label>
          <input type="number" class="form-control" id="pdf-max-chars-input" placeholder="例: 2000" min="100" max="10000" step="100" value="${escHtml(initialMaxChars)}" />
        </div>
        <div style="margin-bottom:10px;display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm" id="pdf-select-all">全選択</button>
          <button class="btn btn-secondary btn-sm" id="pdf-deselect-all">全解除</button>
          <span id="pdf-selected-count" style="margin-left:4px;font-size:13px;color:var(--color-text-muted);align-self:center">0 ページ選択中</span>
        </div>
        <div class="pdf-page-grid">${thumbsHtml}</div>
        <div class="modal-actions" style="margin-top:16px">
          <button class="btn btn-primary" id="pdf-modal-confirm">解析実行</button>
        </div>
      `;

      function _parseMaxCharsInput() {
        const input = modal.querySelector('#pdf-max-chars-input');
        if (!input) return null;
        const trimmed = input.value.trim();
        if (!trimmed) return null;
        const parsed = parseInt(trimmed, 10);
        if (Number.isNaN(parsed) || parsed <= 0) {
          showToast('1ページあたりの最大文字数には正の整数を入力してください', 'error');
          return undefined;
        }
        return parsed;
      }

      function _updateSelectedCount() {
        const checked = modal.querySelectorAll('input[name="pdf-page-check"]:checked');
        modal.querySelector('#pdf-selected-count').textContent = `${checked.length} ページ選択中`;
      }

      modal.querySelectorAll('.pdf-page-thumb input[type="checkbox"]').forEach(cb => {
        if (preselectedPages && preselectedPages.includes(parseInt(cb.value))) {
          cb.checked = true;
          cb.closest('.pdf-page-thumb').classList.add('selected');
        }
        cb.addEventListener('change', () => {
          cb.closest('.pdf-page-thumb').classList.toggle('selected', cb.checked);
          _updateSelectedCount();
        });
      });

      _updateSelectedCount();

      modal.querySelector('#pdf-select-all').addEventListener('click', () => {
        modal.querySelectorAll('input[name="pdf-page-check"]').forEach(cb => {
          cb.checked = true;
          cb.closest('.pdf-page-thumb').classList.add('selected');
        });
        _updateSelectedCount();
      });

      modal.querySelector('#pdf-deselect-all').addEventListener('click', () => {
        modal.querySelectorAll('input[name="pdf-page-check"]').forEach(cb => {
          cb.checked = false;
          cb.closest('.pdf-page-thumb').classList.remove('selected');
        });
        _updateSelectedCount();
      });

      modal.querySelector('.pdf-modal-close').addEventListener('click', _closeModal);

      modal.querySelector('#pdf-modal-confirm').addEventListener('click', () => {
        const checked = [...modal.querySelectorAll('input[name="pdf-page-check"]:checked')];
        if (checked.length === 0) { showToast('ページを選択してください', 'error'); return; }
        const pages = checked.map(cb => parseInt(cb.value)).sort((a, b) => a - b);
        const parsed = _parseMaxCharsInput();
        if (parsed === undefined) return;
        _maxCharsPerPage = parsed;
        _startMultiAnalysis(pages);
      });
    }
    // ── 解析実行（ストリーミング）────────────────────────────
    /**
     * 指定ページのVision解析をSSEストリーミングで実行し、結果をリアルタイム表示する
     * pdfFile が null の場合は保存済み画像を使うエンドポイントに送信する
     * @param {number} pageNum - 解析するページの0始まりインデックス
     */
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
        <div class="modal-actions pdf-stop-actions">
          <button class="btn btn-secondary btn-sm" id="pdf-btn-stop">解析完了として扱う</button>
        </div>
        <div class="pdf-analysis-result" id="pdf-analysis-text"></div>
      `;

      modal.querySelector('.pdf-modal-close').addEventListener('click', _closeModal);
      const stopBtn = modal.querySelector('#pdf-btn-stop');

      const resultEl = modal.querySelector('#pdf-analysis-text');
      let fullText = '';
      let stopCompletionRequested = false;
      if (stopBtn) {
        stopBtn.addEventListener('click', () => {
          stopCompletionRequested = true;
          if (abortController) abortController.abort();
        });
      }

      try {
        let streamUrl, streamOptions;
        const maxChars = _maxCharsPerPage;

        if (pdfFile) {
          const formData = new FormData();
          formData.append('file', pdfFile);
          formData.append('page', String(pageNum));
          if (maxChars !== null) {
            formData.append('max_chars_per_page', String(maxChars));
          }
          streamUrl = `/api/projects/${project.id}/sources/${src.id}/analyze-pdf-page-stream`;
          streamOptions = { method: 'POST', body: formData, signal: abortController.signal };
        } else {
          streamUrl = `/api/projects/${project.id}/sources/${src.id}/analyze-saved-pdf-page-stream`;
          streamOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              maxChars !== null
                ? { page: pageNum, max_chars_per_page: maxChars }
                : { page: pageNum }
            ),
            signal: abortController.signal,
          };
        }

        const res = await _authFetch(streamUrl, streamOptions);
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
        if (e.name === 'AbortError') {
          if (stopCompletionRequested) {
            _showResult(pageNum, fullText);
          }
          return;
        }
        const errEl = document.createElement('p');
        errEl.style.cssText = 'color:var(--color-danger);margin-top:8px;font-size:13px';
        errEl.textContent = `エラー: ${e.message}`;
        modal.appendChild(errEl);
        // エラー時もアクションボタンを表示
        _showResult(pageNum, fullText, true);
      }
    }

    // ── 複数ページ解析（順次ストリーミング）─────────────────────
    /**
     * 複数ページを順次Vision解析し、進捗と結果をリアルタイム表示する
     * @param {number[]} pages - 解析するページの0始まりインデックス配列（昇順）
     */
    async function _startMultiAnalysis(pages) {
      if (pages.length === 0) return;
      if (abortController) abortController.abort();
      abortController = new AbortController();

      const selection = [...pages];
      const pageTexts = {};
      let currentIdx = 0;
      let stopRequested = false;
      const processedPages = [];
      const maxChars = _maxCharsPerPage;

      function _renderProgress(pageNum) {
        modal.innerHTML = `
          <div class="pdf-modal-header">
            <h3>解析中... (${currentIdx + 1} / ${selection.length} ページ)</h3>
            <button class="pdf-modal-close" title="閉じる">×</button>
          </div>
          <div class="pdf-analysis-progress">
            <div class="pdf-analysis-spinner"></div>
            <span>p.${pageNum + 1} を解析しています...</span>
          </div>
          <div class="modal-actions pdf-stop-actions">
            <button class="btn btn-secondary btn-sm" id="pdf-btn-stop">解析完了として扱う</button>
          </div>
          <div class="pdf-analysis-result" id="pdf-analysis-text"></div>
        `;
        modal.querySelector('.pdf-modal-close').addEventListener('click', _closeModal);
        const stopBtn = modal.querySelector('#pdf-btn-stop');
        if (stopBtn) {
          stopBtn.addEventListener('click', () => {
            stopRequested = true;
            if (abortController) abortController.abort();
          });
        }
      }

      async function _analyzeOnePage(pageNum) {
        _renderProgress(pageNum);
        const resultEl = modal.querySelector('#pdf-analysis-text');
        let fullText = '';

        let streamUrl, streamOptions;
        if (pdfFile) {
          const formData = new FormData();
          formData.append('file', pdfFile);
          formData.append('page', String(pageNum));
          if (maxChars !== null) {
            formData.append('max_chars_per_page', String(maxChars));
          }
          streamUrl = `/api/projects/${project.id}/sources/${src.id}/analyze-pdf-page-stream`;
          streamOptions = { method: 'POST', body: formData, signal: abortController.signal };
        } else {
          const payload = { page: pageNum };
          if (maxChars !== null) {
            payload.max_chars_per_page = maxChars;
          }
          streamUrl = `/api/projects/${project.id}/sources/${src.id}/analyze-saved-pdf-page-stream`;
          streamOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: abortController.signal,
          };
        }

        const res = await _authFetch(streamUrl, streamOptions);
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
          const lines = buffer.split('
');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') break;
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
          if (stopRequested) break;
        }
        return fullText;
      }

      const errors = {};
      for (let i = 0; i < pages.length; i++) {
        if (stopRequested) break;
        currentIdx = i;
        const pageNum = pages[i];
        processedPages.push(pageNum);
        try {
          pageTexts[pageNum] = await _analyzeOnePage(pageNum);
          if (stopRequested) break;
        } catch (e) {
          if (e.name === 'AbortError') break;
          errors[pageNum] = e.message;
          pageTexts[pageNum] = '';
        }
      }

      if (processedPages.length === 0) {
        _closeModal();
        return;
      }

      _showMultiResult(processedPages, selection, pageTexts, errors);
    }
    // ── 複数ページ解析結果確認画面 ───────────────────────────
    /**
     * 複数ページ解析完了後の結果確認画面を表示する
     * @param {number[]} pages - 解析したページの0始まりインデックス配列
     * @param {Object} pageTexts - {page: text} の結果マップ
     * @param {Object} errors - {page: errorMessage} のエラーマップ
     */
    function _showMultiResult(displayPages, retryPages, pageTexts, errors) {
      const hasError = Object.keys(errors).length > 0;
      const combined = displayPages.map(p => {
        if (errors[p]) return `--- ${p + 1}ページ目 ---\n[エラー: ${errors[p]}]`;
        return `--- ${p + 1}ページ目 ---\n${pageTexts[p] || ''}`;
      }).join('\n\n');

      modal.innerHTML = `
        <div class="pdf-modal-header">
          <h3>${hasError ? '解析完了（一部エラー）' : '解析完了'} — ${displayPages.length} ページ</h3>
          <button class="pdf-modal-close" title="閉じる">×</button>
        </div>
        <div class="pdf-analysis-result" style="height:400px;overflow-y:auto;white-space:pre-wrap;font-size:13px;padding:12px;background:var(--color-bg-secondary);border-radius:6px;margin-bottom:12px">${escHtml(combined)}</div>
        <div class="modal-actions" style="margin-top:8px">
          <button class="btn btn-secondary" id="pdf-btn-back">ページ選択に戻る</button>
          <button class="btn btn-secondary" id="pdf-btn-retry">再実行</button>
          <button class="btn btn-primary" id="pdf-btn-add"${!combined.trim() ? ' disabled' : ''}>内容に追加</button>
        </div>
      `;

      modal.querySelector('.pdf-modal-close').addEventListener('click', _closeModal);
      modal.querySelector('#pdf-btn-back').addEventListener('click', () => _showPageSelect(retryPages));
      modal.querySelector('#pdf-btn-retry').addEventListener('click', () => _startMultiAnalysis(retryPages));

      if (combined.trim()) {
        modal.querySelector('#pdf-btn-add').addEventListener('click', async () => {
          const currentText = src.full_text || '';
          const separator = currentText ? '\n\n' : '';
          const newText = currentText + separator + combined;
          try {
            const updated = await ApiClient.put(
              `/api/projects/${project.id}/sources/${src.id}`,
              { full_text: newText }
            );
            const idx = project.sources.findIndex(s => s.id === src.id);
            if (idx >= 0) project.sources[idx] = updated;
            src.full_text = updated.full_text;
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

    // ── 解析結果確認画面 ─────────────────────────────────────
    /**
     * 解析完了後の結果確認画面を表示する
     * 「ページ選択に戻る」「再実行」「内容に追加」ボタンを提供する
     * @param {number} pageNum - 解析したページの0始まりインデックス
     * @param {string} analysisText - LLMが生成したテキスト
     * @param {boolean} [isError=false] - エラー終了の場合は true
     */
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

  /**
   * PDF全ページ一括書き起こしモーダル（設定 → ストリーミング解析 → 結果確認）
   * @param {object} src - ソースオブジェクト（file_type === 'pdf'）
   */
  function _showBatchPdfAnalysisModal(src) {
    const project = appState.getProject();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.maxWidth = '680px';
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

    // ── 設定画面 ─────────────────────────────────────────────────
    function _showSettings() {
      modal.innerHTML = `
        <div class="pdf-modal-header">
          <h3>全ページ一括解析</h3>
          <button class="pdf-modal-close" title="閉じる">×</button>
        </div>
        <p style="color:var(--color-text-muted);font-size:13px;margin-bottom:16px">
          保存済みの全ページを順番に書き起こします。
        </p>
        <div class="form-group" style="margin-bottom:16px">
          <label>1ページあたりの最大文字数（省略可）</label>
          <input type="number" class="form-control" id="batch-max-chars"
            min="100" max="10000" step="100"
            placeholder="例: 2000（省略時は制限なし）" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="batch-btn-cancel">キャンセル</button>
          <button class="btn btn-primary" id="batch-btn-start">解析開始</button>
        </div>
      `;
      modal.querySelector('.pdf-modal-close').addEventListener('click', _closeModal);
      modal.querySelector('#batch-btn-cancel').addEventListener('click', _closeModal);
      modal.querySelector('#batch-btn-start').addEventListener('click', () => {
        const val = modal.querySelector('#batch-max-chars').value.trim();
        const maxChars = val ? parseInt(val, 10) : null;
        _startBatchAnalysis(maxChars);
      });
    }

    // ── バッチ解析実行 ────────────────────────────────────────────
    async function _startBatchAnalysis(maxChars) {
      if (abortController) abortController.abort();
      abortController = new AbortController();

      const pageTexts = {};
      let totalPages = null;

      modal.innerHTML = `
        <div class="pdf-modal-header">
          <h3>解析中...</h3>
          <button class="pdf-modal-close" title="閉じる">×</button>
        </div>
        <div class="pdf-analysis-progress" id="batch-progress">
          <div class="pdf-analysis-spinner"></div>
          <span id="batch-progress-label">準備中...</span>
        </div>
        <div class="pdf-analysis-result" id="batch-current-text"></div>
        <div class="modal-actions" style="margin-top:12px">
          <button class="btn btn-secondary" id="batch-btn-abort">中止</button>
        </div>
      `;
      modal.querySelector('.pdf-modal-close').addEventListener('click', _closeModal);
      modal.querySelector('#batch-btn-abort').addEventListener('click', () => {
        abortController.abort();
        // 中止時点までの結果を確認画面へ
        _showBatchResult(pageTexts, totalPages, true);
      });

      const progressLabel = modal.querySelector('#batch-progress-label');
      const currentTextEl = modal.querySelector('#batch-current-text');

      try {
        const res = await _authFetch(
          `/api/projects/${project.id}/sources/${src.id}/analyze-all-pages-stream`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ max_chars_per_page: maxChars }),
            signal: abortController.signal,
          }
        );
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
              _showBatchResult(pageTexts, totalPages, false);
              return;
            }
            try {
              const parsed = JSON.parse(payload);
              if (parsed.event === 'page_start') {
                totalPages = parsed.total;
                pageTexts[parsed.page] = '';
                progressLabel.textContent = `${parsed.page + 1} / ${parsed.total} ページ目を解析中...`;
                currentTextEl.textContent = '';
              } else if (parsed.event === 'chunk') {
                pageTexts[parsed.page] = (pageTexts[parsed.page] || '') + parsed.text;
                currentTextEl.textContent = pageTexts[parsed.page];
                currentTextEl.scrollTop = currentTextEl.scrollHeight;
              } else if (parsed.event === 'error') {
                pageTexts[parsed.page] = `[解析失敗: ${parsed.message}]`;
                currentTextEl.textContent = pageTexts[parsed.page];
              }
            } catch (e) {
              if (!(e instanceof SyntaxError)) throw e;
            }
          }
        }

        _showBatchResult(pageTexts, totalPages, false);

      } catch (e) {
        if (e.name === 'AbortError') {
          // 中止ボタンが押されていれば結果画面はすでに表示済み
          return;
        }
        modal.innerHTML = `
          <div class="pdf-modal-header">
            <h3>解析エラー</h3>
            <button class="pdf-modal-close" title="閉じる">×</button>
          </div>
          <p style="color:var(--color-danger);font-size:13px;margin:12px 0">${escHtml(e.message)}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" id="batch-err-close">閉じる</button>
            <button class="btn btn-primary" id="batch-err-retry">再試行</button>
          </div>
        `;
        modal.querySelector('.pdf-modal-close').addEventListener('click', _closeModal);
        modal.querySelector('#batch-err-close').addEventListener('click', _closeModal);
        modal.querySelector('#batch-err-retry').addEventListener('click', () => _startBatchAnalysis(maxChars));
      }
    }

    // ── 結果確認画面 ──────────────────────────────────────────────
    function _showBatchResult(pageTexts, totalPages, wasAborted) {
      const pageNums = Object.keys(pageTexts).map(Number).sort((a, b) => a - b);
      const combinedText = pageNums
        .map(n => `--- ${n + 1}ページ目 ---\n${pageTexts[n]}`)
        .join('\n\n');
      const title = wasAborted
        ? `中止 (${pageNums.length}ページ書き起こし済み)`
        : `解析完了 (${pageNums.length}ページ)`;

      modal.innerHTML = `
        <div class="pdf-modal-header">
          <h3>${escHtml(title)}</h3>
          <button class="pdf-modal-close" title="閉じる">×</button>
        </div>
        <div class="pdf-analysis-result" id="batch-result-text" style="max-height:340px">${escHtml(combinedText)}</div>
        <div class="modal-actions" style="margin-top:16px">
          <button class="btn btn-secondary" id="batch-btn-back">戻る</button>
          <button class="btn btn-primary" id="batch-btn-add"${!combinedText ? ' disabled' : ''}>内容に追加</button>
        </div>
      `;
      modal.querySelector('.pdf-modal-close').addEventListener('click', _closeModal);
      modal.querySelector('#batch-btn-back').addEventListener('click', _showSettings);
      modal.querySelector('#batch-btn-add').addEventListener('click', async () => {
        const currentText = src.full_text || '';
        const separator = currentText ? '\n\n' : '';
        const newText = currentText + separator + combinedText;

        try {
          const updated = await ApiClient.put(
            `/api/projects/${project.id}/sources/${src.id}`,
            { full_text: newText }
          );
          const idx = project.sources.findIndex(s => s.id === src.id);
          if (idx >= 0) project.sources[idx] = updated;
          src.full_text = updated.full_text;
          const ta = document.getElementById('src-full-text');
          if (ta) ta.value = updated.full_text;
          showToast('内容に追加しました', 'success');
          _closeModal();
        } catch (_) {
          showToast('保存に失敗しました', 'error');
        }
      });
    }

    // 初期表示
    _showSettings();
  }

  /**
   * LLMを使ってソースの要約を生成し、要約フィールドを更新する
   * @param {object} src - 対象のソースオブジェクト
   */
  async function _summarize(src) {
    _cancelPendingSave();
    _startProcessing(src.id, 'summary');  // フィールド無効化 + 再レンダリング
    const project = appState.getProject();
    const loadingToast = showToast('要約生成中...', 'info', { persistent: true, spinner: true });
    try {
      const updated = await ApiClient.post(
        `/api/projects/${project.id}/sources/${src.id}/summarize`
      );
      dismissToast(loadingToast);
      const idx = project.sources.findIndex(s => s.id === src.id);
      if (idx >= 0) project.sources[idx] = updated;
      _stopProcessing(src.id, 'summary');  // フィールド有効化 + 再レンダリング（最新データ表示）
      showToast('要約を生成しました', 'success');
    } catch (_) {
      dismissToast(loadingToast);
      _stopProcessing(src.id, 'summary');
      showToast('要約の生成に失敗しました', 'error');
    }
  }

  /**
   * LLMを使ってソースの長い要約を生成し、要約フィールドを更新する
   * @param {object} src - 対象のソースオブジェクト
   */
  async function _summarizeExtended(src) {
    _cancelPendingSave();
    _startProcessing(src.id, 'summary');  // フィールド無効化 + 再レンダリング
    const project = appState.getProject();
    const loadingToast = showToast('長い要約生成中...', 'info', { persistent: true, spinner: true });
    try {
      const updated = await ApiClient.post(
        `/api/projects/${project.id}/sources/${src.id}/summarize-extended`
      );
      dismissToast(loadingToast);
      const idx = project.sources.findIndex(s => s.id === src.id);
      if (idx >= 0) project.sources[idx] = updated;
      _stopProcessing(src.id, 'summary');  // フィールド有効化 + 再レンダリング（最新データ表示）
      showToast('長い要約を生成しました', 'success');
    } catch (_) {
      dismissToast(loadingToast);
      _stopProcessing(src.id, 'summary');
      showToast('長い要約の生成に失敗しました', 'error');
    }
  }

  
  /**
   * LLMを使って全文から文献情報を抽出し、文献情報フィールドを更新する
   * 実行前に確認ダイアログを表示する
   * @param {object} src - 対象のソースオブジェクト
   */
  async function _extractBibliography(src) {
    const project = appState.getProject();
    if (!(await Modal.confirm('LLMを使用して文献情報を抽出します。実行しますか？'))) return;
    _cancelPendingSave();
    _startProcessing(src.id, 'bibliography');  // bib フィールド無効化 + 再レンダリング
    const loadingToast = showToast('文献情報抽出中...', 'info', { persistent: true, spinner: true });
    try {
      const updated = await ApiClient.post(
        `/api/projects/${project.id}/sources/${src.id}/extract-bibliography`
      );
      dismissToast(loadingToast);
      const idx = project.sources.findIndex(s => s.id === src.id);
      if (idx >= 0) project.sources[idx] = updated;
      _stopProcessing(src.id, 'bibliography');  // フィールド有効化 + 再レンダリング
      showToast('文献情報を抽出しました', 'success');
    } catch (_) {
      dismissToast(loadingToast);
      _stopProcessing(src.id, 'bibliography');
      showToast('文献情報の抽出に失敗しました', 'error');
    }
  }

  /**
   * 参考文献表記フォーマット設定モーダルを表示する
   * @param {string} bibType - 設定する文献種類（'paper'|'book'|'book_chapter'|'web'|'resource'）
   */
  function _showCitationFormatModal(bibType) {
    const project = appState.getProject();
    if (!project) return;

    // 現在のフォーマット（カスタムまたはデフォルト）を取得
    const savedFormats = project.citation_formats || {};
    const currentTokens = savedFormats[bibType]
      ? JSON.parse(JSON.stringify(savedFormats[bibType]))
      : JSON.parse(JSON.stringify(DEFAULT_CITATION_FORMATS[bibType] || []));

    const typeName = BIB_TYPE_LABELS[bibType] || bibType;

    // オーバーレイを作成
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)';

    const modal = document.createElement('div');
    modal.className = 'modal-content';
    modal.style.cssText = 'width:560px;max-width:95vw;max-height:85vh;overflow-y:auto;padding:24px;background:var(--color-surface);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.3)';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // トークンリスト（ローカル編集状態）
    let tokens = currentTokens;

    function renderModal() {
      modal.innerHTML = `
        <h3 class="citation-modal-title">参考文献 表記フォーマット設定</h3>
        <p class="citation-modal-description">${escHtml(typeName)} の表記順序と装飾を設定します</p>
        <div id="citation-token-list" class="citation-token-list"></div>
        <div class="citation-token-actions">
          <button class="btn btn-secondary btn-sm" id="btn-citation-add-field">＋ フィールド追加</button>
          <button class="btn btn-secondary btn-sm" id="btn-citation-reset">デフォルトに戻す</button>
        </div>
        <div class="citation-preview-panel">
          <strong>プレビュー:</strong>
          <div id="citation-preview" class="citation-preview"></div>
        </div>
        <div class="citation-footer-actions">
          <button class="btn btn-secondary" id="btn-citation-cancel">キャンセル</button>
          <button class="btn btn-primary" id="btn-citation-save">保存</button>
        </div>
      `;

      // プレビューサンプルデータ
      const sampleBib = {
        author: '山田 太郎',
        title: 'サンプルタイトル',
        year: '2024',
        journal: 'サンプル誌',
        volume: '12',
        issue: '3',
        pages: '45-67',
        publisher: 'サンプル出版',
        publication_place: '東京',
        editor: '鈴木 花子',
        url: 'https://example.com',
        site_name: 'サンプルサイト',
        accessed_date: '2024-03-01',
        created_date: '2024-01-01',
        other: '',
      };

      function updatePreview() {
        const parts = [];
        tokens.forEach(tok => {
          if (tok.field === 'literal') {
            if (tok.prefix) parts.push(tok.prefix);
          } else {
            const val = sampleBib[tok.field] || '';
            if (val) parts.push(`${tok.prefix || ''}${val}${tok.suffix || ''}`);
          }
        });
        const preview = document.getElementById('citation-preview');
        if (preview) preview.textContent = parts.join(' ') || '(フィールドが設定されていません)';
      }

      function renderTokenList() {
        const list = document.getElementById('citation-token-list');
        if (!list) return;
        list.innerHTML = '';
        tokens.forEach((tok, idx) => {
          const row = document.createElement('div');
          row.className = 'citation-token-row';
          row.draggable = true;
          row.dataset.idx = idx;

          row.innerHTML = `
            <span class="drag-handle" title="ドラッグで並び替え">⠿</span>
            <select class="form-control citation-tok-field">
              ${CITATION_FIELD_OPTIONS.map(o => `<option value="${o.value}"${tok.field===o.value?' selected':''}>${escHtml(o.label)}</option>`).join('')}
            </select>
            ${tok.field === 'literal'
              ? `<input type="text" class="form-control citation-tok-prefix is-literal" placeholder="固定テキスト" value="${escHtml(tok.prefix)}" />`
              : `<input type="text" class="form-control citation-tok-prefix" placeholder="前の文字列" value="${escHtml(tok.prefix)}" />
                 <input type="text" class="form-control citation-tok-suffix" placeholder="後の文字列" value="${escHtml(tok.suffix)}" />`
            }
            <button class="btn btn-sm citation-token-delete-btn" data-action="delete" title="削除">×</button>
          `;

          // 変更イベント
          row.querySelector('.citation-tok-field').addEventListener('change', (e) => {
            tokens[idx].field = e.target.value;
            if (e.target.value === 'literal') {
              tokens[idx].suffix = '';
            }
            renderTokenList();
          });
          row.querySelector('.citation-tok-prefix').addEventListener('input', (e) => {
            tokens[idx].prefix = e.target.value;
            updatePreview();
          });
          const suffixEl = row.querySelector('.citation-tok-suffix');
          if (suffixEl) {
            suffixEl.addEventListener('input', (e) => {
              tokens[idx].suffix = e.target.value;
              updatePreview();
            });
          }

          // 削除
          row.querySelector('[data-action="delete"]').addEventListener('click', () => {
            tokens.splice(idx, 1);
            renderTokenList();
          });

          // ドラッグ&ドロップ
          row.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(idx));
          });
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            row.style.opacity = '0.6';
          });
          row.addEventListener('dragleave', () => {
            row.style.opacity = '';
          });
          row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.style.opacity = '';
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
            if (isNaN(fromIdx) || fromIdx === idx) return;
            const moved = tokens.splice(fromIdx, 1)[0];
            tokens.splice(idx, 0, moved);
            renderTokenList();
          });

          list.appendChild(row);
        });
        updatePreview();
      }

      renderTokenList();

      document.getElementById('btn-citation-add-field').addEventListener('click', () => {
        tokens.push({ field: 'author', prefix: '', suffix: '' });
        renderTokenList();
      });

      document.getElementById('btn-citation-reset').addEventListener('click', async () => {
        if (!(await Modal.confirm(`「${typeName}」のフォーマットをデフォルトに戻しますか？`))) return;
        tokens = JSON.parse(JSON.stringify(DEFAULT_CITATION_FORMATS[bibType] || []));
        renderTokenList();
      });

      document.getElementById('btn-citation-cancel').addEventListener('click', () => {
        overlay.remove();
      });

      document.getElementById('btn-citation-save').addEventListener('click', async () => {
        try {
          const saved = await ApiClient.put(
            `/api/projects/${project.id}/citation-formats`,
            { type: bibType, tokens }
          );
          // プロジェクト状態を更新
          if (!project.citation_formats) project.citation_formats = {};
          project.citation_formats[bibType] = saved.tokens;
          appState.setProject(project);
          overlay.remove();
          showToast('表記フォーマットを保存しました', 'success');
        } catch (_) {
          showToast('保存に失敗しました', 'error');
        }
      });

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
    }

    renderModal();
  }

  /**
   * ソースタブのグローバルイベントをバインドする（初期化時に1回だけ呼ぶ）
   * 「ソース追加」ボタンのクリックで新規ソースを作成してリストに追加する
   */
  function bindEvents({ tiptapEditor } = {}) {
    _tiptapEditor = tiptapEditor || null;
    document.getElementById('btn-add-source').addEventListener('click', async () => {
      const project = appState.getProject();
      if (!project) return;
      const src = await ApiClient.post(`/api/projects/${project.id}/sources`);
      project.sources.push(src);
      _activeId = src.id;
      render(project);
    });

    // 検索フィルター
    const searchEl = document.getElementById('source-search');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        _searchFilter = searchEl.value;
        _renderList();
      });
    }

    // 左パネルファイルドロップ
    _bindLeftPanelFileDrop();
  }

  /**
   * 全ソースの文献情報をCSVでエクスポートする
   * pywebview のネイティブ保存ダイアログを使ってファイルを書き出す
   */
  async function exportCsv() {
    const project = appState.getProject();
    if (!project) return;
    try {
      const res = await _authFetch(`/api/projects/${project.id}/sources/export`);
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

  /**
   * pywebview のネイティブファイルダイアログでCSVを選択し、ソースを一括インポートする
   * インポート後はプロジェクトを再取得してアプリ状態を更新する
   */
  async function importCsv() {
    const project = appState.getProject();
    if (!project) return;
    try {
      const dialog = await ApiClient.openFileDialog([['CSV ファイル', '*.csv']]);
      if (!dialog || !dialog.path) return;
      const data = await ApiClient.post(`/api/projects/${project.id}/sources/import-native`, { path: dialog.path });
      showToast(`${data.imported} 件インポートしました`, 'success');
      const updated = await ApiClient.get(`/api/projects/${project.id}`);
      appState.setProject(updated);
    } catch (_) {
      showToast('インポートに失敗しました', 'error');
    }
  }

  /**
   * ソースタブの状態を初期化する（プロジェクト切替時に呼ぶ）
   * アクティブID・折りたたみ状態・保存タイマー・処理中状態をすべてリセットする
   */
  function reset() {
    _project = null;
    _activeId = null;
    _sectionCollapsed = {};
    _groupCollapsed = {};
    _searchFilter = '';
    _sourceDragState = null;
    _isDraggingItem = false;
    _autoProcessState.clear();
    _cancelPendingSave();
    _processingState.clear();
  }

  return { render, bindEvents, exportCsv, importCsv, reset };
})();
