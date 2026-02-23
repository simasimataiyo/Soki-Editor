/**
 * ReviewTab — レビュー UI・marked.js プレビュー（タスク 17）
 */

const ReviewTab = (() => {
  let _project = null;
  let _sseCtrl = null;
  let _sectionCollapsed = {};

  function render(project) {
    _project = project;
    // レビュー用プロンプトの復元
    if (project.review_system_prompt) {
      document.getElementById('review-prompt').value = project.review_system_prompt;
    }
    // スコープセレクト
    const sel = document.getElementById('review-scope');
    sel.innerHTML = '<option value="all">全セクション(骨子)</option>';
    (project.sections || []).sort((a, b) => a.order - b.order).forEach(sec => {
      const opt = document.createElement('option');
      opt.value = sec.id;
      opt.textContent = sec.title;
      sel.appendChild(opt);
    });
    _renderPreview(project);
  }

  async function _renderPreview(project) {
    try {
      const previews = await ApiClient.get(`/api/projects/${project.id}/preview`);
      const container = document.getElementById('review-sections');
      const marked = window.marked;
      container.innerHTML = '';

      previews.forEach(p => {
        const isReferences = (p.section_id === '__references__');
        const sec = isReferences ? null : project.sections.find(s => s.id === p.section_id);
        const title = isReferences ? '参考文献' : (sec ? sec.title : p.section_id);
        const isCollapsed = _sectionCollapsed[p.section_id];

        const block = document.createElement('div');
        block.className = 'review-section-block';
        block.dataset.sectionId = p.section_id;

        // 折りたたみヘッダー
        const header = document.createElement('div');
        header.className = 'review-section-header';
        header.innerHTML = `
          <span class="chevron">${isCollapsed ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN}</span>
          <h3>${escHtml(title)}</h3>
        `;
        block.appendChild(header);

        // ボディ
        const body = document.createElement('div');
        body.className = 'review-section-body' + (isCollapsed ? ' collapsed' : '');

        const content = document.createElement('div');
        content.className = 'review-section-content';

        const textDiv = document.createElement('div');
        textDiv.className = 'review-section-text';
        textDiv.innerHTML = marked ? marked.parse(p.rendered_content) : escHtml(p.rendered_content);

        const commentsDiv = document.createElement('div');
        commentsDiv.className = 'review-section-comments';

        content.appendChild(textDiv);
        content.appendChild(commentsDiv);
        body.appendChild(content);
        block.appendChild(body);

        // 折りたたみイベント
        header.addEventListener('click', () => {
          _sectionCollapsed[p.section_id] = !_sectionCollapsed[p.section_id];
          header.querySelector('.chevron').innerHTML = _sectionCollapsed[p.section_id] ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN;
          body.classList.toggle('collapsed');
        });

        container.appendChild(block);
      });
    } catch (_) {}
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

  async function _startReview() {
    const project = window.appState.getProject();
    if (!project) return;
    if (_sseCtrl) _sseCtrl.abort();

    const systemPrompt = document.getElementById('review-prompt').value.trim();
    if (!systemPrompt) { showToast('レビュー指示を入力してください', 'error'); return; }

    const scope = document.getElementById('review-scope').value;
    const useFullSources = document.getElementById('review-full-sources').checked;

    // 各セクションのコメントエリアをクリア
    document.querySelectorAll('.review-section-comments').forEach(el => { el.innerHTML = ''; });

    const btn = document.getElementById('btn-review-send');
    btn.disabled = true;
    btn.textContent = '...';

    _sseCtrl = ApiClient.openSSE(
      `/api/projects/${project.id}/review`,
      { system_prompt: systemPrompt, context_scope: scope, use_full_sources: useFullSources },
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

  function reset() {
    _project = null;
    if (_sseCtrl) { _sseCtrl.abort(); _sseCtrl = null; }
    _sectionCollapsed = {};
  }

  return { render, bindEvents, reset };
})();
