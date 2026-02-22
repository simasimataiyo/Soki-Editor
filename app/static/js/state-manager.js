/**
 * StateManager — アプリ全体状態管理シングルトン（タスク 10.2）
 * window.appState としてグローバルに公開。
 */

const StateManager = (() => {
  const state = {
    project: null,
    activeTab: 'edit',
    activeSourceId: null,
    activeMaterialId: null,
    activeRuleCategoryId: null,
    activeRuleId: null,
    activeSectionId: null,
  };

  /** 状態を更新して statechange イベントを dispatch する。 */
  function setState(updates) {
    Object.assign(state, updates);
    document.dispatchEvent(new CustomEvent('statechange', { detail: { ...state } }));
  }

  /** API レスポンスでプロジェクトを更新する。 */
  function setProject(project) {
    setState({ project });
  }

  /** アクティブタブを変更する。 */
  function setActiveTab(tab) {
    setState({ activeTab: tab });
  }

  function getState() {
    return { ...state };
  }

  function getProject() {
    return state.project;
  }

  return { setState, setProject, setActiveTab, getState, getProject };
})();

// グローバル公開
window.appState = StateManager;
