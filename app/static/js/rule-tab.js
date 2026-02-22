/**
 * RuleTab — ルール・カテゴリ管理 UI（タスク 14）
 */

const RuleTab = (() => {
  let _project = null;
  let _activeCategoryId = null;

  function render(project) {
    _project = project;
    _renderCategories();
    _renderRules();
  }

  function _renderCategories() {
    const list = document.getElementById('category-list');
    list.innerHTML = '';
    const sorted = [..._project.rule_categories].sort((a, b) => a.order - b.order);

    sorted.forEach(cat => {
      const li = document.createElement('li');
      li.dataset.id = cat.id;
      if (cat.id === _activeCategoryId) li.classList.add('active');
      li.innerHTML = `
        <span style="flex:1">${escHtml(cat.name)}</span>
        <span style="display:none" class="item-actions">
          <button class="btn-icon btn-sm" data-action="edit">⚙</button>
          <button class="btn-icon btn-sm" data-action="delete">×</button>
        </span>
      `;
      li.style.display = 'flex';
      li.style.alignItems = 'center';

      li.addEventListener('mouseenter', () => li.querySelector('.item-actions').style.display = 'flex');
      li.addEventListener('mouseleave', () => li.querySelector('.item-actions').style.display = 'none');

      li.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
        e.stopPropagation();
        _editCategory(cat);
      });
      li.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        _deleteCategory(cat);
      });

      li.addEventListener('click', () => {
        _activeCategoryId = cat.id;
        window.appState.setState({ activeRuleCategoryId: cat.id });
        _renderCategories();
        _renderRules();
      });

      list.appendChild(li);
    });
  }

  function _renderRules() {
    const container = document.getElementById('rule-list');
    const nameEl = document.getElementById('rule-category-name');

    if (!_activeCategoryId) {
      nameEl.textContent = 'カテゴリを選択';
      container.innerHTML = '';
      return;
    }

    const cat = _project.rule_categories.find(c => c.id === _activeCategoryId);
    nameEl.textContent = cat ? cat.name : '';

    const rules = _project.rules
      .filter(r => r.category_id === _activeCategoryId)
      .sort((a, b) => a.order - b.order);

    container.innerHTML = '';
    rules.forEach(rule => {
      const li = document.createElement('li');
      li.className = 'rule-card';
      li.dataset.id = rule.id;
      li.innerHTML = `
        <input type="checkbox" class="rule-toggle" ${rule.enabled ? 'checked' : ''} title="ON/OFF" />
        <div class="rule-text" contenteditable="true">${escHtml(rule.content)}</div>
        <button class="btn-icon btn-sm" data-action="delete" title="削除">×</button>
      `;

      const toggle = li.querySelector('.rule-toggle');
      toggle.addEventListener('change', () => _toggleRule(rule, toggle.checked));

      const textEl = li.querySelector('.rule-text');
      let editTimer;
      textEl.addEventListener('input', () => {
        clearTimeout(editTimer);
        editTimer = setTimeout(() => _updateRuleContent(rule, textEl.innerText), 800);
      });

      // アイテム外クリックで編集解除（ブラウザネイティブ動作に委譲）

      li.querySelector('[data-action="delete"]').addEventListener('click', () => _deleteRule(rule));

      container.appendChild(li);
    });
  }

  async function _editCategory(cat) {
    const newName = prompt('カテゴリ名:', cat.name);
    if (!newName || newName === cat.name) return;
    const project = window.appState.getProject();
    try {
      await ApiClient.put(
        `/api/projects/${project.id}/rule-categories/${cat.id}`,
        { name: newName }
      );
      cat.name = newName;
      _renderCategories();
    } catch (_) {}
  }

  async function _deleteCategory(cat) {
    if (!confirm(`カテゴリ「${cat.name}」と配下のルールをすべて削除しますか？`)) return;
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
      _renderRules();
    } catch (_) {}
  }

  function bindEvents() {
    document.getElementById('btn-add-category').addEventListener('click', async () => {
      const project = window.appState.getProject();
      if (!project) return;
      const name = prompt('カテゴリ名:');
      if (!name) return;
      const cat = await ApiClient.post(`/api/projects/${project.id}/rule-categories`, { name });
      project.rule_categories.push(cat);
      _activeCategoryId = cat.id;
      render(project);
    });

    document.getElementById('btn-add-rule').addEventListener('click', async () => {
      const project = window.appState.getProject();
      if (!project || !_activeCategoryId) {
        showToast('カテゴリを選択してください', 'error');
        return;
      }
      const content = prompt('ルール内容:');
      if (!content) return;
      const rule = await ApiClient.post(`/api/projects/${project.id}/rules`, {
        category_id: _activeCategoryId,
        content,
        enabled: true,
      });
      project.rules.push(rule);
      _renderRules();
    });

    document.getElementById('btn-rule-export').addEventListener('click', async () => {
      const project = window.appState.getProject();
      if (!project) return;
      window.location.href = `/api/projects/${project.id}/rules/export`;
    });

    document.getElementById('btn-rule-import').addEventListener('click', async () => {
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
          const res = await fetch(`/api/projects/${project.id}/rules/import`, {
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
