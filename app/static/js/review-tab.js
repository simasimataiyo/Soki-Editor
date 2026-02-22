/**
 * ReviewTab — レビュー UI・marked.js プレビュー（タスク 17）
 */

const ReviewTab = (() => {
  let _project = null;
  let _sseCtrl = null;

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
      const container = document.getElementById('review-content');
      const marked = window.marked;
      container.innerHTML = '';
      previews.forEach(p => {
        const sec = project.sections.find(s => s.id === p.section_id);
        const div = document.createElement('div');
        div.className = 'section-block';
        div.dataset.sectionId = p.section_id;
        div.innerHTML = `
          <div class="section-header">
            <strong>${escHtml(sec ? sec.title : p.section_id)}</strong>
          </div>
          <div style="padding:14px;line-height:1.7">
            ${marked ? marked.parse(p.rendered_content) : escHtml(p.rendered_content)}
          </div>
        `;
        container.appendChild(div);
      });
    } catch (_) {}
  }

  function _addCommentCard(sectionId, comment) {
    const panel = document.getElementById('review-comments-panel');
    const project = window.appState.getProject();
    const sec = project?.sections.find(s => s.id === sectionId);

    const card = document.createElement('div');
    card.className = 'comment-card';
    card.innerHTML = `
      <div class="comment-section">${escHtml(sec ? sec.title : sectionId)}</div>
      <div class="comment-text">${escHtml(comment)}</div>
      <div class="comment-actions">
        <button class="btn btn-sm btn-secondary" data-action="copy">プロンプトにコピー</button>
        <button class="btn btn-sm btn-icon" data-action="close">×</button>
      </div>
    `;

    card.querySelector('[data-action="copy"]').addEventListener('click', () => {
      document.getElementById('chat-input').value = comment;
      // Edit タブへ切り替え
      AppShell.switchTab('edit');
    });

    card.querySelector('[data-action="close"]').addEventListener('click', () => {
      card.remove();
    });

    panel.appendChild(card);

    // セクションブロックを強調
    const secBlock = document.querySelector(`[data-section-id="${sectionId}"]`);
    if (secBlock) secBlock.style.borderColor = 'var(--color-primary)';
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

    // コメントパネルをクリア
    document.getElementById('review-comments-panel').innerHTML = '';

    const btn = document.getElementById('btn-review-send');
    btn.disabled = true;
    btn.textContent = 'レビュー中...';

    _sseCtrl = ApiClient.openSSE(
      `/api/projects/${project.id}/review`,
      { system_prompt: systemPrompt, context_scope: scope, use_full_sources: useFullSources },
      {
        onReviewComment: (sectionId, comment) => _addCommentCard(sectionId, comment),
        onDone: () => {
          btn.disabled = false;
          btn.textContent = 'レビュー実行';
          showToast('レビュー完了', 'success');
        },
        onError: (msg) => {
          btn.disabled = false;
          btn.textContent = 'レビュー実行';
          showToast(`レビューエラー: ${msg}`, 'error');
        },
      }
    );
  }

  return { render, bindEvents };
})();
