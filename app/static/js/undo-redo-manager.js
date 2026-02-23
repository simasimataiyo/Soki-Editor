/**
 * UndoRedoManager — セクション操作の取り消し・やり直し管理（タスク 11.3）
 * スタック上限 50 件。
 */

const UndoRedoManager = (() => {
  const MAX_STACK = 50;
  let undoStack = [];
  let redoStack = [];

  /**
   * @param {{ do: () => Promise<void>, undo: () => Promise<void> }} operation
   */
  function push(operation) {
    undoStack.push(operation);
    if (undoStack.length > MAX_STACK) undoStack.shift();
    redoStack = [];
    _updateButtons();
  }

  async function undo() {
    if (!canUndo()) return;
    const op = undoStack.pop();
    await op.undo();
    redoStack.push(op);
    _updateButtons();
  }

  async function redo() {
    if (!canRedo()) return;
    const op = redoStack.pop();
    await op.do();
    undoStack.push(op);
    _updateButtons();
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }

  function clear() {
    undoStack = [];
    redoStack = [];
    _updateButtons();
  }

  function _updateButtons() {
    // キーボードショートカットのみで管理するためここでは何もしない
  }

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+S
  document.addEventListener('keydown', async (e) => {
    // contenteditable内ではブラウザのネイティブundo/redoに任せる
    const inEditable = document.activeElement?.getAttribute('contenteditable') === 'true';
    if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
      if (inEditable) return;
      e.preventDefault();
      await undo();
    } else if (e.ctrlKey && e.shiftKey && e.key === 'Z') {
      if (inEditable) return;
      e.preventDefault();
      await redo();
    } else if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      const project = window.appState.getProject();
      if (project) {
        try {
          await ApiClient.put(`/api/projects/${project.id}/save`);
          showToast('保存しました', 'success');
        } catch (_) {}
      }
    }
  });

  return { push, undo, redo, canUndo, canRedo, clear };
})();
