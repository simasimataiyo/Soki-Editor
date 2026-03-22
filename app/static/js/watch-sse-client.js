/**
 * WatchSSEClient — ファイル監視 SSE クライアント
 * プロジェクト open 時に /api/projects/{id}/watch-events に接続し、
 * source_added/removed, material_added/removed イベントに応じて通知と状態同期を行う。
 */
const WatchSSEClient = (() => {
  const _global = typeof globalThis !== 'undefined' ? globalThis : {};
  const _TOKEN = (_global.window && _global.window.__APP_TOKEN__) || '';
  let _projectId = null;
  let _eventSource = null;
  let _retryCount = 0;
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 5000;
  const DEDUPE_WINDOW_MS = 1500;
  let _retryTimer = null;
  let _recentEventKeys = new Map();
  let _connectionState = 'disconnected';

  function isNotifiableEventType(type) {
    return (
      type === 'source_added' ||
      type === 'source_removed' ||
      type === 'material_added' ||
      type === 'material_removed'
    );
  }

  function shouldHandleProjectEvent(data, activeProjectId) {
    if (!activeProjectId) return false;
    if (!data || typeof data !== 'object') return false;
    if (!data.project_id) {
      return data.type === 'connected';
    }
    return data.project_id === activeProjectId;
  }

  function buildChangeToast(type, itemName = '') {
    const isSource = type.startsWith('source_');
    const isAdded = type.endsWith('_added');
    const target = isSource ? 'ソース' : 'マテリアル';
    const change = isAdded ? '追加されました' : '削除されました';
    const message = itemName ? `${target}：${itemName}が${change}` : `${target}が${change}`;
    return {
      level: isAdded ? 'success' : 'info',
      message,
    };
  }

  function _resolveItemNameFromProject(project, eventType, itemId) {
    if (!project || !itemId) return '';
    if (eventType.startsWith('source_')) {
      const src = (project.sources || []).find((s) => s.id === itemId);
      return src?.name || '';
    }
    const mat = (project.materials || []).find((m) => m.id === itemId);
    return mat?.name || '';
  }

  function buildConnectionToast(state) {
    if (state === 'retrying') {
      return { level: 'info', message: 'ファイル監視との接続が切断されました。再接続を試みています。' };
    }
    if (state === 'unavailable') {
      return { level: 'error', message: 'ファイル監視に接続できません。変更通知は一時停止中です。' };
    }
    if (state === 'recovered') {
      return { level: 'success', message: 'ファイル監視との接続が復旧しました。' };
    }
    return null;
  }

  function _makeEventKey(event) {
    return [
      event?.project_id || '',
      event?.type || '',
      event?.item_id || '',
      event?.added || 0,
      event?.removed || 0,
    ].join('|');
  }

  function shouldNotifyByDedupe(event, memory, nowMs, windowMs = DEDUPE_WINDOW_MS) {
    const pruneThreshold = windowMs * 4;
    for (const [k, ts] of memory.entries()) {
      if (typeof ts === 'number' && nowMs - ts > pruneThreshold) {
        memory.delete(k);
      }
    }

    const key = _makeEventKey(event);
    const lastTs = memory.get(key);
    if (typeof lastTs === 'number' && nowMs - lastTs < windowMs) {
      return false;
    }
    memory.set(key, nowMs);
    return true;
  }

  function _emitToast(message, type, options) {
    try {
      if (typeof showToast === 'function') {
        return showToast(message, type, options);
      }
    } catch (err) {
      try {
        if (typeof showToast === 'function') {
          showToast('通知表示中にエラーが発生しました', 'error');
        }
      } catch (_) {}
    }
    return null;
  }

  function _notifyConnectionState(nextState) {
    if (_connectionState === nextState) return;
    _connectionState = nextState;
    const toast = buildConnectionToast(nextState);
    if (toast) {
      _emitToast(toast.message, toast.level);
    }
  }

  function connect(projectId) {
    disconnect();

    _projectId = projectId;
    _retryCount = 0;
    _recentEventKeys = new Map();
    _connectionState = 'connecting';
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
    _recentEventKeys = new Map();
    _connectionState = 'disconnected';
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
        _emitToast('変更通知の解析に失敗しました', 'error');
      }
    };

    es.onerror = () => {
      es.close();
      _eventSource = null;
      if (_projectId && _retryCount < MAX_RETRIES) {
        _retryCount++;
        _notifyConnectionState('retrying');
        console.warn(`[WatchSSEClient] 接続切断。${RETRY_DELAY_MS / 1000}秒後に再接続します（${_retryCount}/${MAX_RETRIES}）`);
        _retryTimer = setTimeout(_openConnection, RETRY_DELAY_MS);
      } else if (_retryCount >= MAX_RETRIES) {
        _notifyConnectionState('unavailable');
        console.error('[WatchSSEClient] 最大再接続回数に達しました。監視を停止します。');
      }
    };

    es.onopen = () => {
      const needsRecoveredToast = _connectionState === 'retrying' || _connectionState === 'unavailable';
      _retryCount = 0;
      if (needsRecoveredToast) {
        _notifyConnectionState('recovered');
      } else {
        _connectionState = 'connected';
      }
    };
  }

  function _handleEvent(data) {
    if (!data || !data.type) return;
    if (!shouldHandleProjectEvent(data, _projectId)) return;

    const currentProject = window.appState?.getProject?.();
    if (!currentProject) return;

    if (isNotifiableEventType(data.type)) {
      if (!shouldNotifyByDedupe(data, _recentEventKeys, Date.now())) {
        return;
      }

      if (data.type.startsWith('source_')) {
        _reloadSourceTab(currentProject, data);
      } else {
        _reloadMaterialTab(currentProject, data);
      }
      return;
    }

    if (data.type === 'sync_complete') {
      if ((data.added || 0) + (data.removed || 0) > 0) {
        _reloadSourceTab(currentProject);
        _reloadMaterialTab(currentProject);
      }
    }
  }

  function _isTabActive(tabName) {
    return document.querySelector(`.nav-item[data-tab="${tabName}"]`)?.classList.contains('active');
  }

  function _reloadSourceTab(project, changeEvent = null) {
    if (!project) return;
    const loadLatestProject = () => ApiClient.get(`/api/projects/${encodeURIComponent(project.id)}`);

    loadLatestProject()
      .then((updated) => {
        if (changeEvent) {
          const resolvedName =
            _resolveItemNameFromProject(updated, changeEvent.type, changeEvent.item_id) ||
            _resolveItemNameFromProject(project, changeEvent.type, changeEvent.item_id) ||
            changeEvent.item_name ||
            '';
          const toast = buildChangeToast(changeEvent.type, resolvedName);
          _emitToast(toast.message, toast.level);
        }

        window.appState.setProject(updated);
        if (typeof SourceTab !== 'undefined' && _isTabActive('source')) {
          SourceTab.render(updated);
        }
      })
      .catch(() => {
        _emitToast('ソース変更の反映に失敗しました', 'error');
      });
  }

  function _reloadMaterialTab(project, changeEvent = null) {
    if (!project) return;
    const loadLatestProject = () => ApiClient.get(`/api/projects/${encodeURIComponent(project.id)}`);

    loadLatestProject()
      .then((updated) => {
        if (changeEvent) {
          const resolvedName =
            _resolveItemNameFromProject(updated, changeEvent.type, changeEvent.item_id) ||
            _resolveItemNameFromProject(project, changeEvent.type, changeEvent.item_id) ||
            changeEvent.item_name ||
            '';
          const toast = buildChangeToast(changeEvent.type, resolvedName);
          _emitToast(toast.message, toast.level);
        }

        window.appState.setProject(updated);
        if (typeof MaterialTab !== 'undefined' && _isTabActive('material')) {
          MaterialTab.render(updated);
        }
      })
      .catch(() => {
        _emitToast('マテリアル変更の反映に失敗しました', 'error');
      });
  }

  return {
    connect,
    disconnect,
    __test__: {
      isNotifiableEventType,
      shouldHandleProjectEvent,
      buildChangeToast,
      buildConnectionToast,
      shouldNotifyByDedupe,
      handleEvent: _handleEvent,
      setProjectId: (projectId) => { _projectId = projectId; },
      resetState: () => {
        _recentEventKeys = new Map();
        _retryCount = 0;
        _connectionState = 'disconnected';
      },
    },
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    __test__: WatchSSEClient.__test__,
  };
}
