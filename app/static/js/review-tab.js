/**
 * ReviewTab — レビュー UI・marked.js プレビュー・コマンド対応（タスク 17）
 * 更新: チャットバー共通化、カード形式の指摘表示
 */

const ReviewTab = (() => {
  let _project = null;
  let _sseCtrl = null;
  let _commentsBySection = {}; // セクションIDごとのコメント配列

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
      ChatBarCommon.setValue('review-prompt', project.review_system_prompt);
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
    commentsDiv.dataset.sectionId = sec.id;

    // コメントエリアヘッダー
    const comments = _commentsBySection[sec.id] || [];
    if (comments.length > 0) {
      const commentsHeader = document.createElement('div');
      commentsHeader.className = 'review-comments-header';
      commentsHeader.innerHTML = `
        <span class="review-comments-title">${comments.length}件の指摘</span>
        <button class="btn-clear-comments" data-action="clear-comments" data-section-id="${sec.id}">すべて削除</button>
      `;
      commentsDiv.appendChild(commentsHeader);
    }

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

  /**
   * コメントをパースして問題点と改善策に分割
   * @param {string} comment - LLMからのコメント
   * @returns {{problem: string, solution: string}|null}
   */
  function _parseComment(comment) {
    // フォーマットの判定: 問題点と改善策の区切りを探す
    // パターン1: 「問題点:」「改善策:」「問題:」「解決策:」など
    const patterns = [
      /(?:問題点|問題)[：:]\s*(.+?)(?:\n|$)(?:改善策|解決策|対処法|改善)[：:]\s*(.+)/s,
      /(?:改善策|解決策|対処法|改善)[：:]\s*(.+?)(?:\n|$)(?:問題点|問題)[：:]\s*(.+)/s,
    ];

    for (const pattern of patterns) {
      const match = comment.match(pattern);
      if (match) {
        let problem = match[1].trim();
        let solution = match[2].trim();

        // 文字数制限（100-140文字以内）
        problem = _truncateText(problem, 140);
        solution = _truncateText(solution, 140);

        return { problem, solution, original: comment };
      }
    }

    // パターンが見つからない場合は全文を問題点として表示
    const truncated = _truncateText(comment, 140);
    return { problem: truncated, solution: '', original: comment };
  }

  /**
   * テキストを指定文字数以内に切り詰める
   */
  function _truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 1) + '…';
  }

  /**
   * コメントカードを追加
   */
  function _addCommentCard(sectionId, comment) {
    // コメントを保存
    if (!_commentsBySection[sectionId]) {
      _commentsBySection[sectionId] = [];
    }
    const parsed = _parseComment(comment);
    _commentsBySection[sectionId].push(parsed);

    // DOMを更新
    _updateCommentsSection(sectionId);
  }

  /**
   * セクションのコメントエリアを更新
   */
  function _updateCommentsSection(sectionId) {
    const block = document.querySelector(`.review-section-block[data-section-id="${sectionId}"]`);
    if (!block) return;

    const commentsDiv = block.querySelector('.review-section-comments');
    if (!commentsDiv) return;

    // 既存のカードを削除（ヘッダーは残す）
    const existingCards = commentsDiv.querySelectorAll('.comment-card');
    existingCards.forEach(card => card.remove());

    const comments = _commentsBySection[sectionId] || [];

    // ヘッダーの更新
    const existingHeader = commentsDiv.querySelector('.review-comments-header');
    if (comments.length === 0) {
      if (existingHeader) existingHeader.remove();
    } else if (existingHeader) {
      // 件数テキストを更新
      const countEl = existingHeader.querySelector('.review-comments-title');
      if (countEl) countEl.textContent = `${comments.length}件の指摘`;
    } else {
      const header = document.createElement('div');
      header.className = 'review-comments-header';
      header.innerHTML = `
        <span class="review-comments-title">${comments.length}件の指摘</span>
        <button class="btn-clear-comments" data-action="clear-comments" data-section-id="${sectionId}">すべて削除</button>
      `;
      commentsDiv.insertBefore(header, commentsDiv.firstChild);
    }

    // カードを追加
    comments.forEach((comment, index) => {
      const card = _createCommentCard(sectionId, comment, index);
      commentsDiv.appendChild(card);
    });

    // ヘッダーのボタンイベント
    const header = commentsDiv.querySelector('.review-comments-header');
    if (header) {
      const clearBtn = header.querySelector('[data-action="clear-comments"]');
      if (clearBtn) {
        clearBtn.onclick = (e) => {
          e.stopPropagation();
          _clearComments(sectionId);
        };
      }
    }
  }

  /**
   * コメントカードを作成
   */
  function _createCommentCard(sectionId, parsed, index) {
    const card = document.createElement('div');
    card.className = 'comment-card';
    card.dataset.commentIndex = index;

    card.innerHTML = `
      <div class="comment-card-header">
        <span class="comment-label" data-action="copy-to-edit">プロンプトにコピー</span>
        <button class="comment-close" data-action="close">×</button>
      </div>
      <div class="comment-card-section">
        ${parsed.problem ? `<div class="comment-card-problem">${escHtml(parsed.problem)}</div>` : ''}
        ${parsed.solution ? `<div class="comment-card-solution">${escHtml(parsed.solution)}</div>` : ''}
      </div>
      <div class="comment-card-actions">
        <button class="btn btn-secondary btn-sm" data-action="copy-to-edit">プロンプトにコピー</button>
      </div>
    `;

    // プロンプトにコピー
    const copyToEdit = () => {
      const textToCopy = `問題: ${parsed.problem}\n改善: ${parsed.solution}`;
      // エディットタブに切り替えてチャット入力欄にセット
      document.getElementById('chat-input').value = textToCopy;
      AppShell.switchTab('edit');
      showToast('エディットタブにコピーしました', 'success');
    };

    card.querySelectorAll('[data-action="copy-to-edit"]').forEach(el => {
      el.addEventListener('click', copyToEdit);
    });

    // 個別削除
    card.querySelector('[data-action="close"]').addEventListener('click', () => {
      _removeComment(sectionId, index);
    });

    return card;
  }

  /**
   * コメントを削除
   */
  function _removeComment(sectionId, index) {
    if (!_commentsBySection[sectionId]) return;
    _commentsBySection[sectionId].splice(index, 1);
    _updateCommentsSection(sectionId);
  }

  /**
   * セクションの全コメントを削除
   */
  function _clearComments(sectionId) {
    if (!_commentsBySection[sectionId]) return;

    const comments = _commentsBySection[sectionId];
    if (comments.length === 0) return;

    Modal.confirm(`${comments.length}件の指摘を削除しますか？`).then(confirmed => {
      if (confirmed) {
        _commentsBySection[sectionId] = [];
        _updateCommentsSection(sectionId);

        const block = document.querySelector(`.review-section-block[data-section-id="${sectionId}"]`);
        if (block) {
          const header = block.querySelector('.review-comments-header');
          if (header) header.remove();
        }
        showToast('指摘を削除しました', 'success');
      }
    });
  }

  function bindEvents() {
    // チャットバー共通処理を使用
    ChatBarCommon.init('review-prompt', 'btn-review-send', 'review', {
      onSend: _startReview,
    });
  }

  // ─── コマンド対応レビュー送信 ──────────────────────────

  async function _startReview(parsed) {
    const project = window.appState.getProject();
    if (!project) return;
    if (_sseCtrl) _sseCtrl.abort();

    const freeText = parsed.freeText || '';

    // 不明コマンドエラー
    if (parsed.error) {
      showToast(parsed.error, 'error');
      return;
    }

    // /prompt コマンド（LLMを介さない即時実行）
    if (parsed.command && parsed.command.name === 'prompt') {
      await _handlePromptCommand(parsed.command.args, freeText);
      return;
    }

    // /review コマンド（フォーカス付きレビュー）
    if (parsed.command && parsed.command.name === 'review') {
      const focus = parsed.command.args[0] || null; // "structure", "rule", "source"
      await _doReview(project, freeText, focus, parsed.refs);
      return;
    }

    // 通常レビュー（コマンドなし）
    await _doReview(project, freeText, null, parsed.refs);
  }

  function _doReview(project, systemPrompt, reviewFocus, refs) {
    const scope = document.getElementById('review-scope').value;
    // 各セクションのコメントをクリア
    _commentsBySection = {};
    document.querySelectorAll('.review-section-comments').forEach(el => {
      el.innerHTML = '';
      const header = el.parentElement?.querySelector('.review-comments-header');
      if (header) header.remove();
    });

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

    // チャット応答表示用コンテナ（review-bar の先頭に追加）
    const reviewBar = document.getElementById('review-bar');
    // 前回のレスポンスエリアがあれば削除
    const existingResponseEl = reviewBar.querySelector('.llm-response-area');
    if (existingResponseEl) existingResponseEl.remove();

    const responseEl = document.createElement('div');
    responseEl.className = 'llm-response-area';
    reviewBar.insertBefore(responseEl, reviewBar.firstChild);

    let isStreaming = false;
    let isHovering = false;
    let hoverTimer = null;

    function startLoading() {
      responseEl.innerHTML = '<div class="pdf-analysis-spinner"></div>';
    }

    function scheduleAutoClose() {
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (!isHovering && !isStreaming) {
          responseEl.remove();
        }
      }, 3000);
    }

    function clearAutoClose() {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    }

    responseEl.addEventListener('mouseenter', () => {
      isHovering = true;
      clearAutoClose();
    });

    responseEl.addEventListener('mouseleave', () => {
      isHovering = false;
      if (!isStreaming) {
        scheduleAutoClose();
      }
    });

    startLoading();

    return new Promise((resolve) => {
      _sseCtrl = ApiClient.openSSE(
        `/api/projects/${project.id}/review`,
        body,
        {
          onChunk: (text) => {
            if (!isStreaming) {
              responseEl.innerHTML = '';
              isStreaming = true;
            }
            responseEl.textContent += text;
            responseEl.scrollTop = responseEl.scrollHeight;
          },
          onReviewComment: (sectionId, comment) => _addCommentCard(sectionId, comment),
          onDone: () => {
            isStreaming = false;
            if (!responseEl.textContent.trim()) {
              responseEl.textContent = '完了!';
            }
            if (!isHovering) {
              scheduleAutoClose();
            }
            resolve();
          },
          onError: (msg) => {
            isStreaming = false;
            responseEl.remove();
            showToast(`レビューエラー: ${msg}`, 'error');
            resolve();
          },
        }
      );
    });
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
      const prompt = ChatBarCommon.getValue('review-prompt');
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
          ChatBarCommon.setValue('review-prompt', prompts[name]);
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
    _commentsBySection = {};
    if (_sseCtrl) { _sseCtrl.abort(); _sseCtrl = null; }
  }

  return { render, bindEvents, reset };
})();
