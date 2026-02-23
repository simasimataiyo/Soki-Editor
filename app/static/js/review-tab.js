/**
 * ReviewTab — レビュー UI・marked.js プレビュー・コマンド対応（タスク 17）
 */

const ReviewTab = (() => {
  let _project = null;
  let _sseCtrl = null;

  function _renderScopeSelect() {
    const sel = document.getElementById('review-scope');
    if (!sel) return;
    sel.innerHTML = '<option value="all">全セクション(骨子)</option>';
    const sorted = [...(_project?.sections || [])].sort((a, b) => a.order - b.order);
    const roots = sorted.filter(s => !s.parent_id);

    function _renderOptions(sec, depth) {
      const opt = document.createElement('option');
      opt.value = sec.id;
      opt.textContent = '  '.repeat(depth - 1) + sec.title;
      sel.appendChild(opt);

      const children = sorted.filter(s => s.parent_id === sec.id);
      children.sort((a, b) => a.order - b.order).forEach(child => {
        _renderOptions(child, depth + 1);
      });
    }

    roots.forEach(sec => _renderOptions(sec, 1));
  }

  function render(project) {
    _project = project;
    // レビュー用プロンプトの復元
    if (project.review_system_prompt) {
      document.getElementById('review-prompt').value = project.review_system_prompt;
    }
    _renderScopeSelect();
    _renderPreview(project);
  }

  async function _renderPreview(project) {
    try {
      const previews = await ApiClient.get(`/api/projects/${project.id}/preview`);
      const container = document.getElementById('review-sections');
      const marked = window.marked;
      container.innerHTML = '';

      const previewsById = {};
      previews.forEach(p => {
        previewsById[p.section_id] = p;
      });

      // エディット画面と同じツリー構造でレンダリング
      const sortedSections = [...project.sections].sort((a, b) => a.order - b.order);
      const roots = sortedSections.filter(s => !s.parent_id);

      roots.forEach(sec => {
        _renderSectionBlock(container, sec, sortedSections, previewsById, marked, 1);
      });

      // 参考文献セクション（有効時のみ表示）
      if (project.references_section_enabled && previewsById['__references__']) {
        _renderReferencesBlock(container, previewsById['__references__'], marked);
      }
    } catch (_) {}
  }

  function _renderSectionBlock(container, sec, allSorted, previewsById, marked, depth) {
    const children = allSorted.filter(s => s.parent_id === sec.id);
    const hasChildren = children.length > 0;
    const preview = previewsById[sec.id];

    const block = document.createElement('div');
    block.className = `review-section-block depth-${depth}`;
    block.dataset.sectionId = sec.id;

    const level = Math.min(depth + 1, 6);
    const tag = `h${level}`;

    // ヘッダー（コラプスなし）
    const header = document.createElement('div');
    header.className = 'review-section-header';
    header.innerHTML = `
      <span class="chevron"><span class="chevron-spacer"></span></span>
      <${tag}>${escHtml(sec.title)}</${tag}>
    `;
    block.appendChild(header);

    // ボディ
    const body = document.createElement('div');
    body.className = 'review-section-body';

    const content = document.createElement('div');
    content.className = 'review-section-content';

    // テキストを表示（選択可能）
    const textDiv = document.createElement('div');
    textDiv.className = 'review-section-text';
    textDiv.innerHTML = marked && preview ? marked.parse(preview.rendered_content) : escHtml(preview?.rendered_content || '');

    const commentsDiv = document.createElement('div');
    commentsDiv.className = 'review-section-comments';

    content.appendChild(textDiv);
    content.appendChild(commentsDiv);

    // 子セクションコンテナ
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'review-section-children';

    body.appendChild(content);
    body.appendChild(childrenContainer);
    block.appendChild(body);

    container.appendChild(block);

    // 子セクションを再帰的にレンダリング
    if (hasChildren) {
      children.sort((a, b) => a.order - b.order).forEach(child => {
        _renderSectionBlock(childrenContainer, child, allSorted, previewsById, marked, depth + 1);
      });
    }
  }

  function _renderReferencesBlock(container, preview, marked) {
    const block = document.createElement('div');
    block.className = 'review-section-block references-block';
    block.dataset.sectionId = '__references__';

    const header = document.createElement('div');
    header.className = 'review-section-header';
    header.innerHTML = `
      <span class="chevron">${SVG_CHEVRON_DOWN}</span>
      <h2>参考文献</h2>
    `;
    block.appendChild(header);

    const body = document.createElement('div');
    body.className = 'review-section-body';

    const content = document.createElement('div');
    content.className = 'review-section-content';

    const textDiv = document.createElement('div');
    textDiv.className = 'review-section-text';
    textDiv.innerHTML = marked ? marked.parse(preview.rendered_content) : escHtml(preview.rendered_content);

    const commentsDiv = document.createElement('div');
    commentsDiv.className = 'review-section-comments';

    content.appendChild(textDiv);
    content.appendChild(commentsDiv);
    body.appendChild(content);
    block.appendChild(body);

    container.appendChild(block);
  }

  function _addCommentCard(sectionId, comment) {
    const block = document.querySelector(`.review-section-block[data-section-id="${sectionId}"]`);
    const panel = block ? block.querySelector('.review-section-comments') : null;
    if (!panel) return;

    const card = document.createElement('div');
    card.className = 'comment-card';
    card.innerHTML = `
      <div class="comment-card-header">
        <span class="comment-label">プロンプトにコピー</span>
        <button class="comment-close" data-action="close">×</button>
      </div>
      <div class="comment-card-body">${escHtml(comment)}</div>
    `;

    card.querySelector('.comment-label').addEventListener('click', () => {
      document.getElementById('chat-input').value = comment;
      AppShell.switchTab('edit');
    });
    card.querySelector('.comment-label').style.cursor = 'pointer';

    card.querySelector('[data-action="close"]').addEventListener('click', () => {
      card.remove();
    });

    panel.appendChild(card);
  }

  function bindEvents() {
    document.getElementById('btn-review-send').addEventListener('click', _startReview);
  }

  // ─── コマンド対応レビュー送信 ──────────────────────────

  async function _startReview() {
    const project = window.appState.getProject();
    if (!project) return;
    if (_sseCtrl) _sseCtrl.abort();

    const rawInput = document.getElementById('review-prompt').value.trim();
    if (!rawInput) { showToast('レビュー指示を入力してください', 'error'); return; }

    // コマンド解析
    const parsed = CommandParser.parse(rawInput, 'review');

    // 不明コマンドエラー
    if (parsed.error) {
      showToast(parsed.error, 'error');
      return;
    }

    // /prompt コマンド（LLMを介さない即時実行）
    if (parsed.command && parsed.command.name === 'prompt') {
      await _handlePromptCommand(parsed.command.args, parsed.freeText);
      return;
    }

    // /review コマンド（フォーカス付きレビュー）
    if (parsed.command && parsed.command.name === 'review') {
      const focus = parsed.command.args[0] || null; // "structure", "rule", "source"
      _doReview(project, parsed.freeText, focus, parsed.refs);
      return;
    }

    // 通常レビュー（コマンドなし）
    _doReview(project, rawInput, null, parsed.refs);
  }

  function _doReview(project, systemPrompt, reviewFocus, refs) {
    const scope = document.getElementById('review-scope').value;
    // 各セクションのコメントエリアをクリア
    document.querySelectorAll('.review-section-comments').forEach(el => { el.innerHTML = ''; });

    const btn = document.getElementById('btn-review-send');
    btn.disabled = true;
    btn.textContent = '...';

    const body = {
      system_prompt: systemPrompt || '',
      context_scope: scope,
    };

    // レビューフォーカスコマンド
    if (reviewFocus) {
      body.command = reviewFocus;
    }

    // @参照
    if (refs && refs.length > 0) {
      body.explicit_refs = refs.map(r => r.id);
    }

    _sseCtrl = ApiClient.openSSE(
      `/api/projects/${project.id}/review`,
      body,
      {
        onReviewComment: (sectionId, comment) => _addCommentCard(sectionId, comment),
        onDone: () => {
          btn.disabled = false;
          btn.textContent = '↑';
          showToast('レビュー完了', 'success');
        },
        onError: (msg) => {
          btn.disabled = false;
          btn.textContent = '↑';
          showToast(`レビューエラー: ${msg}`, 'error');
        },
      }
    );
  }

  // ─── プロンプト管理コマンド ─────────────────────────────

  async function _handlePromptCommand(args, freeText) {
    const project = window.appState.getProject();
    if (!project) return;

    const action = args[0]; // "save" or "load"
    const name = freeText || args[1]; // プロンプト名

    if (!action || !name) {
      showToast('使用法: /prompt save 名前 または /prompt load 名前', 'error');
      return;
    }

    if (action === 'save') {
      const prompt = document.getElementById('review-prompt').value.trim();
      if (!prompt) {
        showToast('保存するプロンプトが空です', 'error');
        return;
      }
      try {
        await ApiClient.post(
          `/api/projects/${project.id}/saved-prompts/${encodeURIComponent(name)}`,
          { prompt }
        );
        showToast(`プロンプト「${name}」を保存しました`, 'success');
      } catch (e) {
        showToast(`プロンプト保存エラー: ${e.message}`, 'error');
      }

    } else if (action === 'load') {
      try {
        const prompts = await ApiClient.get(`/api/projects/${project.id}/saved-prompts`);
        if (prompts[name]) {
          document.getElementById('review-prompt').value = prompts[name];
          showToast(`プロンプト「${name}」を読み込みました`, 'success');
        } else {
          showToast(`プロンプト「${name}」が見つかりません`, 'error');
        }
      } catch (e) {
        showToast(`プロンプト読み込みエラー: ${e.message}`, 'error');
      }

    } else {
      showToast(`不明なプロンプト操作: ${action}`, 'error');
    }
  }

  function reset() {
    _project = null;
    if (_sseCtrl) { _sseCtrl.abort(); _sseCtrl = null; }
  }

  return { render, bindEvents, reset };
})();
