/**
 * tiptap-editor.js — Tiptap WYSIWYG統合レイヤー
 * window.TiptapEditor として公開し、edit-tab.js / app.js から利用する
 */

import { Editor, Node, mergeAttributes } from 'https://esm.sh/@tiptap/core@2';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2';

// ─── カスタムノード: SectionHeading ─────────────────────────
// セクションIDを data-section-id 属性として保持する見出しノード
// depth 1 → h2, depth 2 → h3, ..., depth 5以上 → h6

const SectionHeading = Node.create({
  name: 'sectionHeading',
  group: 'block',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return {
      level: {
        default: 2,
        parseHTML: el => parseInt(el.tagName.slice(1), 10),
        renderHTML: () => ({}),
      },
      sectionId: {
        default: null,
        parseHTML: el => el.getAttribute('data-section-id'),
        renderHTML: attrs => (attrs.sectionId ? { 'data-section-id': attrs.sectionId } : {}),
      },
    };
  },

  parseHTML() {
    return [2, 3, 4, 5, 6].map(level => ({
      tag: `h${level}[data-section-id]`,
      attrs: { level },
    }));
  },

  renderHTML({ node, HTMLAttributes }) {
    const level = node.attrs.level;
    return [`h${level}`, mergeAttributes(HTMLAttributes), 0];
  },
});

// ─── Tiptap Editor インスタンス ──────────────────────────────

let editor = null;
let _suppressUpdate = false;

function _initEditor() {
  const mountEl = document.getElementById('tiptap-editor-mount');
  if (!mountEl) return;

  editor = new Editor({
    element: mountEl,
    extensions: [
      StarterKit.configure({
        heading: false, // 組み込みHeadingを無効化してSectionHeadingを使用
      }),
      SectionHeading,
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'tiptap-prosemirror',
      },
    },
  });
}

// ─── ユーティリティ ──────────────────────────────────────────

/**
 * ProseMirrorのparagraphノードをプレーンテキストに変換する
 * hard_break ノードを \n に変換する
 */
function _paragraphToPlainText(node) {
  let text = '';
  node.forEach(child => {
    if (child.type.name === 'hardBreak') {
      text += '\n';
    } else {
      text += child.text || '';
    }
  });
  return text;
}

/**
 * プレーンテキストをTiptap用のHTMLに変換する
 * - 空文字 → <p></p>
 * - \n\n 区切りで<p>に分割
 * - \n は <br> に変換
 */
function _contentToTiptapHtml(content) {
  if (!content || content.trim() === '') return '<p></p>';
  const paragraphs = content.split(/\n{2,}/);
  return paragraphs.map(para => {
    const inner = para.split('\n').map(line => _escHtml(line)).join('<br>');
    return `<p>${inner || ''}</p>`;
  }).join('');
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * セクション配列からTiptap用のHTML文字列を生成する
 * summaryは表示しない（メタデータとして管理）
 */
function _sectionsToHtml(sections) {
  const sorted = [...sections].sort((a, b) => a.order - b.order);

  function renderSection(sec, depth) {
    const level = Math.min(depth + 1, 6);
    const headingHtml = `<h${level} data-section-id="${sec.id}">${_escHtml(sec.title)}</h${level}>`;
    const contentHtml = _contentToTiptapHtml(sec.content);
    const children = sorted.filter(s => s.parent_id === sec.id);
    const childrenHtml = children.map(c => renderSection(c, depth + 1)).join('');
    return headingHtml + contentHtml + childrenHtml;
  }

  const roots = sorted.filter(s => !s.parent_id);
  return roots.map(r => renderSection(r, 1)).join('');
}

/**
 * 現在のTiptapドキュメントをセクション配列に変換する
 * sectionHeadingノードをセクション区切りとして扱う
 */
function _parseSections() {
  if (!editor) return [];
  const sections = [];
  let current = null;
  let paraLines = [];

  editor.state.doc.forEach(node => {
    if (node.type.name === 'sectionHeading') {
      if (current) {
        current.content = paraLines.join('\n\n').trim();
        sections.push(current);
      }
      current = {
        id: node.attrs.sectionId,
        title: node.textContent,
        content: '',
      };
      paraLines = [];
    } else if (node.type.name === 'paragraph') {
      const text = _paragraphToPlainText(node);
      paraLines.push(text);
    } else if (node.type.name === 'bulletList' || node.type.name === 'orderedList') {
      // リスト系ノードもテキストとして取得
      const text = node.textContent;
      if (text) paraLines.push(text);
    }
  });

  if (current) {
    current.content = paraLines.join('\n\n').trim();
    sections.push(current);
  }

  return sections;
}

/**
 * 指定セクションのコンテンツ末尾のProseMirror位置を返す
 * _insertAtCursor のフォールバック用
 */
function _getSectionContentEnd(sectionId) {
  if (!editor) return null;
  let targetPos = null;
  let targetEnd = null;
  let inTarget = false;

  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === 'sectionHeading') {
      if (node.attrs.sectionId === sectionId) {
        targetPos = pos;
        inTarget = true;
        targetEnd = pos + node.nodeSize;
      } else if (inTarget) {
        // 次の見出しが来たらターゲット終了
        inTarget = false;
      }
    } else if (inTarget) {
      targetEnd = pos + node.nodeSize;
    }
  });

  return targetEnd;
}

/**
 * 指定セクションのコンテンツをTiptap上で更新する
 * app.js の update_section ツールハンドラから呼ばれる
 */
function _updateSectionContent(sectionId, newContent) {
  if (!editor) return;

  // 対象セクションの見出しノードを探す
  let headingPos = null;
  let contentStart = null;
  let contentEnd = null;
  let inTarget = false;

  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === 'sectionHeading') {
      if (node.attrs.sectionId === sectionId) {
        headingPos = pos;
        contentStart = pos + node.nodeSize;
        contentEnd = contentStart;
        inTarget = true;
      } else if (inTarget) {
        // 次の見出しでターゲット終了
        inTarget = false;
      }
    } else if (inTarget) {
      contentEnd = pos + node.nodeSize;
    }
  });

  if (headingPos === null) return;

  // 新しいコンテンツノードを構築
  const htmlContent = _contentToTiptapHtml(newContent);

  // suppress を有効にして自動保存をスキップ
  _suppressUpdate = true;

  if (contentStart !== null && contentEnd > contentStart) {
    // 既存コンテンツを新しいもので置き換え
    editor.chain()
      .focus()
      .deleteRange({ from: contentStart, to: contentEnd })
      .insertContentAt(contentStart, htmlContent)
      .run();
  } else if (contentStart !== null) {
    // コンテンツなし → 挿入
    editor.chain()
      .focus()
      .insertContentAt(contentStart, htmlContent)
      .run();
  }

  setTimeout(() => { _suppressUpdate = false; }, 50);
}

// ─── 公開 API ────────────────────────────────────────────────

window.TiptapEditor = {
  /** _suppressUpdate フラグ（edit-tab.js から参照） */
  get _suppressUpdate() { return _suppressUpdate; },

  /**
   * Tiptapエディタにコンテンツをセットする
   * setContent後はupdateイベントを抑制する
   * @param {string[]} sections - セクション配列
   */
  setContentFromSections(sections) {
    if (!editor) return;
    _suppressUpdate = true;
    const html = _sectionsToHtml(sections);
    editor.commands.setContent(html, false);
    setTimeout(() => { _suppressUpdate = false; }, 50);
  },

  /**
   * 生のHTML文字列をTiptapにセットする
   */
  setContent(html) {
    if (!editor) return;
    _suppressUpdate = true;
    editor.commands.setContent(html, false);
    setTimeout(() => { _suppressUpdate = false; }, 50);
  },

  /** rawのTiptapエディタインスタンスを返す */
  getEditor() {
    return editor;
  },

  /**
   * エディタの編集可否を切り替える（LLM実行中ロック用）
   * @param {boolean} editable
   */
  setEditable(editable) {
    if (!editor) return;
    editor.setEditable(editable);
    const mount = document.getElementById('tiptap-editor-mount');
    if (mount) mount.classList.toggle('tiptap-locked', !editable);
  },

  /**
   * 指定セクションのコンテンツをTiptap上で更新する（app.js ツールハンドラ用）
   * @param {string} sectionId
   * @param {string} content
   */
  updateSectionContent(sectionId, content) {
    _updateSectionContent(sectionId, content);
  },

  /**
   * 現在のTiptapドキュメントをセクション配列に変換する
   * @returns {{ id: string|null, title: string, content: string }[]}
   */
  parseSections() {
    return _parseSections();
  },

  /**
   * 指定セクションのコンテンツ末尾のProseMirror位置を返す
   * @param {string} sectionId
   * @returns {number|null}
   */
  getSectionContentEnd(sectionId) {
    return _getSectionContentEnd(sectionId);
  },
};

// ─── 初期化 ──────────────────────────────────────────────────

// DOMContentLoadedまたは即時実行（type="module"はdeferred）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    _initEditor();
    document.dispatchEvent(new Event('tiptap-ready'));
  });
} else {
  _initEditor();
  document.dispatchEvent(new Event('tiptap-ready'));
}
