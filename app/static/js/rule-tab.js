/**
 * RuleTab — ルール・カテゴリ管理 UI（タスク 14）
 */

const RuleTab = (() => {
  let _project = null;
  let _activeCategoryId = null;
  let _catCollapsed = {};       // 左パネルツリー折りたたみ
  let _sectionCollapsed = {};   // 右パネルセクション折りたたみ

  function render(project) {
    _project = project;
    _renderTree();
    _renderAllSections();
  }

  // ─── 左パネル: カテゴリツリー ──────────────────────────

  function _renderTree() {
    const list = document.getElementById('category-list');
    list.innerHTML = '';
    const sorted = [..._project.rule_categories].sort((a, b) => a.order - b.order);

    sorted.forEach(cat => {
      const rules = _project.rules
        .filter(r => r.category_id === cat.id)
        .sort((a, b) => a.order - b.order);
      const isCollapsed = _catCollapsed[cat.id];

      // カテゴリ行
      const catLi = document.createElement('li');
      catLi.className = 'rule-tree-category' + (cat.id === _activeCategoryId ? ' active' : '');
      catLi.innerHTML = `
        <span class="rule-tree-toggle" data-action="toggle">${isCollapsed ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
        <span class="item-title">${escHtml(cat.name)}</span>
      `;

      catLi.querySelector('.rule-tree-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        _catCollapsed[cat.id] = !_catCollapsed[cat.id];
        _renderTree();
      });

      catLi.addEventListener('click', () => {
        _activeCategoryId = cat.id;
        _renderTree();
        const block = document.querySelector(`.rule-category-section[data-category-id="${cat.id}"]`);
        if (block) {
          // トップバーの高さを考慮して位置調整
          const topBar = document.querySelector('.top-bar');
          const topBarHeight = topBar ? topBar.offsetHeight : 0;
          // scrollIntoViewでまずビュー内に表示
          block.scrollIntoView({ block: 'start' });
          // 少し遅延後にトップバーの高さ分を調整
          requestAnimationFrame(() => {
            const rect = block.getBoundingClientRect();
            const scrollTop = window.scrollY + rect.top - topBarHeight;
            window.scrollTo({ behavior: 'smooth', top: Math.max(0, scrollTop) });
          });
        }
      });
      // ダブルクリックでカテゴリ名編集
      catLi.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        _editCategory(cat);
      });

      list.appendChild(catLi);

      // ルール子要素
      if (!isCollapsed) {
        rules.forEach(rule => {
          const ruleLi = document.createElement('li');
          ruleLi.className = 'rule-tree-rule';
          const preview = (rule.content || '').substring(0, 30) + ((rule.content || '').length > 30 ? '...' : '');
          ruleLi.innerHTML = `<span class="outline-toggle-spacer"></span><span class="item-title"> ${escHtml(preview)}</span>`;
          ruleLi.addEventListener('click', () => {
            const card = document.querySelector(`.rule-card[data-id="${rule.id}"]`);
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
          list.appendChild(ruleLi);
        });
      }
    });
  }

  // ─── 右パネル: カテゴリセクション ──────────────────────

  function _renderAllSections() {
    const container = document.getElementById('rule-all-view');
    container.innerHTML = '';
    const sorted = [..._project.rule_categories].sort((a, b) => a.order - b.order);

    sorted.forEach(cat => {
      const rules = _project.rules
        .filter(r => r.category_id === cat.id)
        .sort((a, b) => a.order - b.order);

      const section = document.createElement('div');
      section.className = 'rule-category-section';
      section.dataset.categoryId = cat.id;

      const isCollapsed = _sectionCollapsed[cat.id];

      // ヘッダー
      const header = document.createElement('div');
      header.className = 'rule-category-header';
      header.innerHTML = `
        <span class="chevron">${isCollapsed ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
        <h3>${escHtml(cat.name)}</h3>
        <div class="header-actions">
          <button class="btn-icon-edit" data-action="edit" title="カテゴリ名編集">
            ${SVG_EDIT_PEN}
          </button>
          <button class="btn-icon-edit" data-action="delete" title="カテゴリ削除" style="color:var(--color-text-muted)">×</button>
        </div>
      `;
      section.appendChild(header);

      // ボディ
      const body = document.createElement('div');
      body.className = 'rule-category-body' + (isCollapsed ? ' collapsed' : '');

      const ul = document.createElement('ul');
      ul.className = 'rule-cards';
      rules.forEach(rule => {
        ul.appendChild(_createRuleCard(rule, cat));
      });
      body.appendChild(ul);
      section.appendChild(body);

      // 折りたたみトグル
      header.querySelector('.chevron').addEventListener('click', (e) => {
        e.stopPropagation();
        _sectionCollapsed[cat.id] = !_sectionCollapsed[cat.id];
        header.querySelector('.chevron').innerHTML = _sectionCollapsed[cat.id] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN;
        body.classList.toggle('collapsed');
      });

      header.querySelector('h3').addEventListener('click', () => {
        _sectionCollapsed[cat.id] = !_sectionCollapsed[cat.id];
        header.querySelector('.chevron').innerHTML = _sectionCollapsed[cat.id] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN;
        body.classList.toggle('collapsed');
      });

      // カテゴリ編集
      header.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
        e.stopPropagation();
        _editCategory(cat);
      });

      // カテゴリ削除
      header.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        _deleteCategory(cat);
      });

      container.appendChild(section);
    });
  }

  function _createRuleCard(rule, cat) {
    const li = document.createElement('li');
    li.className = 'rule-card';
    li.dataset.id = rule.id;
    li.innerHTML = `
      <label class="toggle-switch">
        <input type="checkbox" class="rule-toggle" ${rule.enabled ? 'checked' : ''} />
        <span class="slider"></span>
      </label>
      <div class="rule-text" contenteditable="true">${escHtml(rule.content)}</div>
      <button class="rule-delete" data-action="delete" title="削除">×</button>
    `;

    const toggle = li.querySelector('.rule-toggle');
    toggle.addEventListener('change', () => _toggleRule(rule, toggle.checked));

    const textEl = li.querySelector('.rule-text');
    let editTimer;
    textEl.addEventListener('input', () => {
      clearTimeout(editTimer);
      editTimer = setTimeout(() => _updateRuleContent(rule, textEl.innerText), 800);
    });

    li.querySelector('[data-action="delete"]').addEventListener('click', () => _deleteRule(rule));

    return li;
  }

  async function _editCategory(cat) {
    const newName = await Modal.prompt('カテゴリ名編集', 'カテゴリ名を入力してください', cat.name);
    if (!newName || newName === cat.name) return;
    const project = window.appState.getProject();
    try {
      await ApiClient.put(
        `/api/projects/${project.id}/rule-categories/${cat.id}`,
        { name: newName }
      );
      cat.name = newName;
      render(project);
    } catch (_) {}
  }

  async function _deleteCategory(cat) {
    if (!(await Modal.confirm(`カテゴリ「${cat.name}」と配下のルールをすべて削除しますか？`))) return;
    const project = window.appState.getProject();
    try {
      await ApiClient.delete(`/api/projects/${project.id}/rule-categories/${cat.id}`);
      project.rule_categories = project.rule_categories.filter(c => c.id !== cat.id);
      project.rules = project.rules.filter(r => r.category_id !== cat.id);
      if (_activeCategoryId === cat.id) _activeCategoryId = null;
      render(project);
    } catch (_) {}
  }

  async function _toggleRule(rule, enabled) {
    const project = window.appState.getProject();
    try {
      await ApiClient.put(`/api/projects/${project.id}/rules/${rule.id}`, { enabled });
      rule.enabled = enabled;
    } catch (_) {}
  }

  async function _updateRuleContent(rule, content) {
    const project = window.appState.getProject();
    try {
      await ApiClient.put(`/api/projects/${project.id}/rules/${rule.id}`, { content });
      rule.content = content;
    } catch (_) {}
  }

  async function _deleteRule(rule) {
    const project = window.appState.getProject();
    try {
      await ApiClient.delete(`/api/projects/${project.id}/rules/${rule.id}`);
      project.rules = project.rules.filter(r => r.id !== rule.id);
      _renderAllSections();
      _renderTree();
    } catch (_) {}
  }

  // ─── トップバーから呼び出される公開関数 ──────────────

  async function addCategory() {
    const project = window.appState.getProject();
    if (!project) return;
    const name = await Modal.prompt('カテゴリ追加', 'カテゴリ名を入力してください');
    if (!name) return;
    try {
      const cat = await ApiClient.post(`/api/projects/${project.id}/rule-categories`, { name });
      project.rule_categories.push(cat);
      _activeCategoryId = cat.id;
      render(project);
    } catch (_) {}
  }

  // 左パネル「新規追加」ボタンからルール追加（カテゴリ選択付き）
  async function addRuleFromPanel() {
    const project = window.appState.getProject();
    if (!project) return;

    const cats = [...project.rule_categories].sort((a, b) => a.order - b.order);
    const catOptions = [
      ...cats.map(c => ({ value: c.id, label: c.name })),
      { value: '__new__', label: '＋ 新規カテゴリ...' },
    ];

    const defaultCatId = _activeCategoryId || (cats[0]?.id || '__new__');

    const result = await Modal.form(
      'ルール追加',
      [
        { name: 'content', label: 'ルール内容', type: 'textarea', value: '' },
        { name: 'category_id', label: 'カテゴリ', type: 'select', value: defaultCatId, options: catOptions },
      ]
    );
    if (!result) return;

    let { content, category_id } = result;
    if (!content.trim()) { showToast('ルール内容を入力してください', 'error'); return; }

    if (category_id === '__new__') {
      const newName = await Modal.prompt('カテゴリ追加', 'カテゴリ名を入力してください');
      if (!newName) return;
      try {
        const cat = await ApiClient.post(`/api/projects/${project.id}/rule-categories`, { name: newName });
        project.rule_categories.push(cat);
        category_id = cat.id;
      } catch (_) { return; }
    }

    try {
      const rule = await ApiClient.post(`/api/projects/${project.id}/rules`, {
        category_id,
        content,
        enabled: true,
      });
      project.rules.push(rule);
      _activeCategoryId = category_id;
      _renderAllSections();
      _renderTree();
    } catch (_) {}
  }

  async function addRuleToCategory(categoryId) {
    const project = window.appState.getProject();
    if (!project) return;
    const content = await Modal.prompt('ルール追加', 'ルール内容を入力してください');
    if (!content) return;
    try {
      const rule = await ApiClient.post(`/api/projects/${project.id}/rules`, {
        category_id: categoryId,
        content,
        enabled: true,
      });
      project.rules.push(rule);
      _renderAllSections();
      _renderTree();
    } catch (_) {}
  }

  async function exportCsv() {
    const project = window.appState.getProject();
    if (!project) return;
    try {
      const res = await fetch(`/api/projects/${project.id}/rules/export`);
      if (!res.ok) { showToast('エクスポートに失敗しました', 'error'); return; }
      const csvText = await res.text();
      const dialog = await ApiClient.saveFileDialog('rules.csv');
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
      const data = await ApiClient.post(`/api/projects/${project.id}/rules/import-native`, { path: dialog.path });
      showToast(`${data.imported} 件インポートしました`, 'success');
      const updated = await ApiClient.get(`/api/projects/${project.id}`);
      window.appState.setProject(updated);
    } catch (_) {
      showToast('インポートに失敗しました', 'error');
    }
  }

  function bindEvents() {
    // ボタンはトップバーと各カテゴリブロック内で管理
  }

  function reset() {
    _project = null;
    _activeCategoryId = null;
    _catCollapsed = {};
    _sectionCollapsed = {};
  }

  return { render, bindEvents, addCategory, addRuleFromPanel, addRuleToCategory, exportCsv, importCsv, reset };
})();
