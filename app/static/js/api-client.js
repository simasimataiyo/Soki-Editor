/**
 * ApiClient — HTTP/SSE 通信ラッパー（タスク 10.3）
 * すべての API 呼び出しをラップし、エラーハンドリングを統一する。
 */

class ApiError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

const ApiClient = (() => {
  const BASE = '';  // 同一オリジン

  async function _fetch(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(BASE + path, opts);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        detail = data.detail || detail;
      } catch (_) {}
      const err = new ApiError(res.status, detail);
      _handleError(err);
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function _handleError(err) {
    showToast(err.detail || err.message, 'error');
  }

  /**
   * SSE ストリームを POST リクエストで開始し、イベントをハンドラに渡す。
   * @param {string} path
   * @param {object} body
   * @param {{onChunk, onToolCall, onReviewComment, onDone, onError}} handlers
   * @returns {AbortController}
   */
  function openSSE(path, body, handlers) {
    const ctrl = new AbortController();

    (async () => {
      try {
        const res = await fetch(BASE + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });

        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try { const d = await res.json(); detail = d.detail || detail; } catch (_) {}
          handlers.onError && handlers.onError(detail);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n\n');
          buffer = lines.pop();  // 未完了の最後の部分を保持

          for (const block of lines) {
            const line = block.trim();
            if (!line.startsWith('data:')) continue;
            try {
              const data = JSON.parse(line.slice(5).trim());
              switch (data.type) {
                case 'chunk':
                  handlers.onChunk && handlers.onChunk(data.text);
                  break;
                case 'tool_call':
                  handlers.onToolCall && handlers.onToolCall(data.tool, data.args);
                  break;
                case 'review_comment':
                  handlers.onReviewComment && handlers.onReviewComment(data.section_id, data.comment);
                  break;
                case 'done':
                  handlers.onDone && handlers.onDone();
                  break;
                case 'error':
                  handlers.onError && handlers.onError(data.message);
                  break;
              }
            } catch (e) {
              console.warn('SSE パースエラー:', e, line);
            }
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          handlers.onError && handlers.onError(e.message);
        }
      }
    })();

    return ctrl;
  }

  async function openFileDialog(fileTypes) {
    return _fetch('POST', '/api/dialog/open-file', { file_types: fileTypes || null });
  }

  async function saveFileDialog(defaultFilename) {
    return _fetch('POST', '/api/dialog/save-file', { default_filename: defaultFilename || '' });
  }

  async function openDirectoryDialog() {
    return _fetch('POST', '/api/dialog/open-directory', {});
  }

  async function writeFile(path, content) {
    return _fetch('POST', '/api/dialog/write-file', { path, content });
  }

  return {
    get: (path) => _fetch('GET', path),
    post: (path, body) => _fetch('POST', path, body),
    put: (path, body) => _fetch('PUT', path, body),
    delete: (path) => _fetch('DELETE', path),
    openSSE,
    openFileDialog,
    saveFileDialog,
    openDirectoryDialog,
    writeFile,
  };
})();
