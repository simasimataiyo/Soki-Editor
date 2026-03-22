/**
 * StateManager — アプリ全体状態管理シングルトン
 */

const StateManager = (() => {
  const state = {
    project: null,
    activeTab: 'edit',
    activeSourceId: null,
    activeMaterialId: null,
    activeSectionId: null,
    selectedSectionId: null,
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

  function setSelectedSectionId(id) {
    // 選択変更は UI 側で _updateDocViewEditMode() が処理するため
    // statechange (フルレンダリング) はトリガーしない
    state.selectedSectionId = id;
  }

  function getSelectedSectionId() {
    return state.selectedSectionId;
  }

  /** プロジェクト切り替え時に選択状態をリセットする。 */
  function resetSelections() {
    state.activeSourceId = null;
    state.activeMaterialId = null;
    state.activeSectionId = null;
    state.selectedSectionId = null;
  }

  return { setState, setProject, setActiveTab, getState, getProject, setSelectedSectionId, getSelectedSectionId, resetSelections };
})();

export { StateManager as appState };
