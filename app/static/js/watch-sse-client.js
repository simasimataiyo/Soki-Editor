/**
 * WatchSSEClient — ファイル監視 SSE クライアント
 * プロジェクト open 時に /api/projects/{id}/watch-events に接続し、
 * source_added/removed, material_added/removed イベントに応じてタブを更新する。
 */
const WatchSSEClient = (() => {
  const _TOKEN = window.__APP_TOKEN__ || '';
  let _projectId = null;
  let _eventSource = null;
  let _retryCount = 0;
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 5000;
  let _retryTimer = null;

  function connect(projectId) {
    // 既存接続があれば切断
    disconnect();

    _projectId = projectId;
    _retryCount = 0;
    _openConnection();
  }

  function disconnect() {
    if (_retryTimer) {
      clearTimeout(_retryTimer);
      _retryTimer = null;
    }
    if (_eventSource) {
      _eventSource.close();
      _eventSource = null;
    }
    _projectId = null;
    _retryCount = 0;
  }

  function _openConnection() {
    if (!_projectId) return;

    let url = `/api/projects/${encodeURIComponent(_projectId)}/watch-events`;
    if (_TOKEN) {
      url += `?app_token=${encodeURIComponent(_TOKEN)}`;
    }
    const es = new EventSource(url);
    _eventSource = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        _handleEvent(data);
      } catch (err) {
        // JSON parse エラーは無視（keepalive コメントは onmessage に来ない）
      }
    };

    es.onerror = () => {
      es.close();
      _eventSource = null;
      if (_projectId && _retryCount < MAX_RETRIES) {
        _retryCount++;
        console.warn(`[WatchSSEClient] 接続切断。${RETRY_DELAY_MS / 1000}秒後に再接続します（${_retryCount}/${MAX_RETRIES}）`);
        _retryTimer = setTimeout(_openConnection, RETRY_DELAY_MS);
      } else if (_retryCount >= MAX_RETRIES) {
        console.error('[WatchSSEClient] 最大再接続回数に達しました。監視を停止します。');
      }
    };

    es.onopen = () => {
      _retryCount = 0;
    };
  }

  function _handleEvent(data) {
    // 現在開いているプロジェクトのイベントのみ処理
    if (!data || !data.type) return;
    if (data.project_id && data.project_id !== _projectId) return;

    const currentProject = window.appState?.getProject?.();

    switch (data.type) {
      case 'source_added': {
        // ソースタブのリロード（スピナートースト → 完了トースト）
        _reloadSourceTab(currentProject, 'added');
        break;
      }
      case 'source_removed': {
        _reloadSourceTab(currentProject, 'removed');
        break;
      }
      case 'material_added': {
        _reloadMaterialTab(currentProject, 'added');
        break;
      }
      case 'material_removed': {
        _reloadMaterialTab(currentProject, 'removed');
        break;
      }
      case 'sync_complete': {
        // 同期完了後にタブを再読み込み
        if ((data.added || 0) + (data.removed || 0) > 0) {
          _reloadSourceTab(currentProject, null);
          _reloadMaterialTab(currentProject, null);
        }
        break;
      }
      default:
        break;
    }
  }

  function _reloadSourceTab(project, changeType) {
    if (!project) return;
    // 現在アクティブなタブが source の場合はトーストを表示
    const isSourceTabActive = document.querySelector('.nav-item[data-tab="source"]')?.classList.contains('active');
    const loadLatestProject = () => ApiClient.get(`/api/projects/${encodeURIComponent(project.id)}`);

    if (changeType === 'added' && isSourceTabActive) {
      const spinnerToast = showToast('ファイルを検出しました…', 'info', { persistent: true, spinner: true });
      if (typeof SourceTab !== 'undefined') {
        // APIから最新プロジェクトを再取得してタブを再描画
        loadLatestProject().then(updated => {
          window.appState.setProject(updated);
          SourceTab.render(updated);
          dismissToast(spinnerToast);
          showToast('ソースを追加しました', 'success');
        }).catch(() => {
          dismissToast(spinnerToast);
        });
      } else {
        dismissToast(spinnerToast);
      }
    } else if (typeof SourceTab !== 'undefined') {
      loadLatestProject().then(updated => {
        window.appState.setProject(updated);
        if (isSourceTabActive) {
          SourceTab.render(updated);
          if (changeType === 'removed') showToast('ソースを削除しました', 'info');
        }
      }).catch(() => {});
    }
  }

  function _reloadMaterialTab(project, changeType) {
    if (!project) return;
    const isMaterialTabActive = document.querySelector('.nav-item[data-tab="material"]')?.classList.contains('active');
    const loadLatestProject = () => ApiClient.get(`/api/projects/${encodeURIComponent(project.id)}`);

    if (changeType === 'added' && isMaterialTabActive) {
      const spinnerToast = showToast('ファイルを検出しました…', 'info', { persistent: true, spinner: true });
      if (typeof MaterialTab !== 'undefined') {
        loadLatestProject().then(updated => {
          window.appState.setProject(updated);
          MaterialTab.render(updated);
          dismissToast(spinnerToast);
          showToast('マテリアルを追加しました', 'success');
        }).catch(() => {
          dismissToast(spinnerToast);
        });
      } else {
        dismissToast(spinnerToast);
      }
    } else if (typeof MaterialTab !== 'undefined') {
      loadLatestProject().then(updated => {
        window.appState.setProject(updated);
        if (isMaterialTabActive) {
          MaterialTab.render(updated);
          if (changeType === 'removed') showToast('マテリアルを削除しました', 'info');
        }
      }).catch(() => {});
    }
  }

  return { connect, disconnect };
})();
