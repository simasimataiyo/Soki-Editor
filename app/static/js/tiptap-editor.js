/**
 * tiptap-editor.js — Tiptap WYSIWYG統合レイヤー（新アーキテクチャ）
 *
 * 本文はマーカー付きMarkdown（project.content）として管理する。
 * window.TiptapEditor として公開し、edit-tab.js / app.js から利用する。
 *
 * マーカー形式: <!-- soki-section:uuid --> を見出し直前に挿入
 */

import { Editor, Node, Extension, mergeAttributes, textblockTypeInputRule } from 'https://esm.sh/@tiptap/core@2';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2';
import { marked } from 'https://esm.sh/marked@12';

// marked の設定: GFMオン、改行保持
marked.setOptions({ gfm: true, breaks: false });

// ─── カスタムノード: SectionHeading ─────────────────────────
// セクションIDを data-section-id 属性として保持する見出しノード
// level: 2-6 (h2-h6)、sectionId: UUID or null（新規見出しはnull）

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
        parseHTML: el => el.getAttribute('data-section-id') || null,
        renderHTML: attrs => (attrs.sectionId ? { 'data-section-id': attrs.sectionId } : {}),
      },
    };
  },

  parseHTML() {
    // IDあり・なし両方の見出しを SectionHeading として取り込む
    return [2, 3, 4, 5, 6].map(level => ({
      tag: `h${level}`,
      attrs: { level },
    }));
  },

  renderHTML({ node, HTMLAttributes }) {
    const level = node.attrs.level;
    return [`h${level}`, mergeAttributes(HTMLAttributes), 0];
  },

  addKeyboardShortcuts() {
    return {
      // Enterで見出しの後に段落を挿入
      Enter: ({ editor }) => {
        const { $from } = editor.state.selection;
        if ($from.parent.type.name !== 'sectionHeading') return false;

        const { state, dispatch } = editor.view;
        const { schema } = state;

        // 見出しノードは depth=1 のブロック。afterPos = 見出しノードの直後
        const headingNodeEnd = $from.after(1); // 見出しノード全体の直後
        const inlineEnd = $from.end(1);         // 見出し内テキスト末尾

        // カーソル以降のテキスト（カット）
        const remainingText = $from.pos < inlineEnd
          ? state.doc.textBetween($from.pos, inlineEnd)
          : '';

        const tr = state.tr;

        // 1. カーソル以降を見出しから削除
        if (remainingText.length > 0) {
          tr.delete($from.pos, inlineEnd);
        }

        // 2. 削除後の見出しノード直後に空段落（またはテキスト付き段落）を挿入
        //    削除でheadingNodeEndが remainingText.length 分ずれる
        const insertAt = headingNodeEnd - remainingText.length;
        const paraContent = remainingText ? [schema.text(remainingText)] : [];
        const para = schema.nodes.paragraph.create(null, paraContent);
        tr.insert(insertAt, para);

        // 3. カーソルを段落先頭へ（段落の開始トークン直後 = insertAt + 1）
        try {
          const newPos = tr.doc.resolve(insertAt + 1);
          tr.setSelection(state.selection.constructor.near(newPos));
        } catch (_) { /* 位置解決失敗時はデフォルトのままに */ }

        dispatch(tr);
        return true;
      },
    };
  },

  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^(#{1,6})\s$/,
        type: this.type,
        getAttributes: match => ({ level: match[1].length }),
      }),
    ];
  },
});

const TabHandler = Extension.create({
  name: 'tabHandler',
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        // もしリスト内ならデフォルトのTab（インデント変更）に任せる
        if (editor.isActive('listItem')) return false;
        // それ以外はテキスト入力エリアにインデント（スペース2つ）を挿入
        editor.commands.insertContent('  ');
        return true;
      },
    };
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
      TabHandler,
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'tiptap-prosemirror',
      },
    },
  });
}

// ─── Markdown → HTML 変換 ────────────────────────────────────

/**
 * マーカー付きMarkdown文字列をTiptap用HTMLに変換する
 * <!-- soki-section:uuid --> を検出してdata-section-id属性を付与する
 */
function _markdownWithMarkersToHtml(markdownContent) {
  if (!markdownContent || markdownContent.trim() === '') return '<p></p>';

  const MARKER_RE = /<!-- soki-section:([a-f0-9-]+) -->\n?/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  // マーカーで分割して各チャンクを処理
  const segments = []; // { sectionId: string|null, text: string }
  let prevEnd = 0;

  const allMatches = [...markdownContent.matchAll(MARKER_RE)];

  if (allMatches.length === 0) {
    // マーカーなし: 全体をそのままMarkdown→HTMLに変換
    segments.push({ sectionId: null, text: markdownContent });
  } else {
    // マーカー前のテキスト
    if (allMatches[0].index > 0) {
      segments.push({ sectionId: null, text: markdownContent.slice(0, allMatches[0].index) });
    }
    for (let i = 0; i < allMatches.length; i++) {
      const m = allMatches[i];
      const sectionId = m[1];
      const start = m.index + m[0].length;
      const end = i + 1 < allMatches.length ? allMatches[i + 1].index : markdownContent.length;
      segments.push({ sectionId, text: markdownContent.slice(start, end) });
    }
  }

  let html = '';
  for (const seg of segments) {
    if (!seg.text.trim()) continue;
    let segHtml = marked.parse(seg.text);
    // 最初の見出しにdata-section-id属性を付与
    if (seg.sectionId) {
      segHtml = segHtml.replace(
        /^(<h[2-6])(\s|>)/,
        (_, tag, rest) => `${tag} data-section-id="${seg.sectionId}"${rest}`
      );
    }
    html += segHtml;
  }

  return html || '<p></p>';
}

// ─── Markdown シリアライザー ─────────────────────────────────

/**
 * インラインノード（bold, italic, code, text, hardBreak）をMarkdownに変換する
 */
function _serializeInline(node) {
  let text = '';
  node.forEach(child => {
    if (child.type.name === 'hardBreak') {
      text += '\n';
    } else if (child.type.name === 'text') {
      let t = child.text || '';
      const marks = child.marks || [];
      // マークを内から外へ適用（逆順）
      const markNames = marks.map(m => m.type.name);
      if (markNames.includes('code')) {
        t = `\`${t}\``;
      } else {
        if (markNames.includes('bold')) t = `**${t}**`;
        if (markNames.includes('italic')) t = `*${t}*`;
        if (markNames.includes('strike')) t = `~~${t}~~`;
      }
      text += t;
    }
  });
  return text;
}

/**
 * ProseMirrorのドキュメントをマーカー付きMarkdown文字列に変換する
 */
function _serializeToMarkdown(doc) {
  const lines = [];

  function serializeNode(node, listDepth, listType) {
    switch (node.type.name) {
      case 'sectionHeading': {
        const level = node.attrs.level || 2;
        const id = node.attrs.sectionId;
        const title = _serializeInline(node);
        if (id) {
          lines.push(`<!-- soki-section:${id} -->`);
        }
        lines.push(`${'#'.repeat(level)} ${title}`);
        lines.push('');
        break;
      }
      case 'paragraph': {
        const text = _serializeInline(node);
        if (listDepth > 0) {
          const indent = '  '.repeat(listDepth - 1);
          const bullet = listType === 'orderedList' ? '1. ' : '- ';
          lines.push(`${indent}${bullet}${text}`);
        } else {
          lines.push(text);
          lines.push('');
        }
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        node.forEach(child => serializeNode(child, listDepth + 1, node.type.name));
        if (listDepth === 0) lines.push('');
        break;
      }
      case 'listItem': {
        node.forEach(child => serializeNode(child, listDepth, listType));
        break;
      }
      case 'blockquote': {
        node.forEach(child => {
          const savedLen = lines.length;
          serializeNode(child, 0, null);
          // 追加された行に > プレフィックスを付ける
          for (let i = savedLen; i < lines.length; i++) {
            lines[i] = '> ' + lines[i];
          }
        });
        break;
      }
      case 'codeBlock': {
        const lang = node.attrs.language || '';
        lines.push(`\`\`\`${lang}`);
        lines.push(node.textContent);
        lines.push('```');
        lines.push('');
        break;
      }
      case 'horizontalRule': {
        lines.push('---');
        lines.push('');
        break;
      }
      default: {
        // doc などのコンテナ
        node.forEach(child => serializeNode(child, listDepth, listType));
      }
    }
  }

  serializeNode(doc, 0, null);

  // 末尾の余分な空行を整理
  let result = lines.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

// ─── セクションID管理ユーティリティ ──────────────────────────

/**
 * 現在のTiptapドキュメントからsectionIdのSetを返す
 */
function _parseSectionIds() {
  if (!editor) return new Set();
  const ids = new Set();
  editor.state.doc.forEach(node => {
    if (node.type.name === 'sectionHeading' && node.attrs.sectionId) {
      ids.add(node.attrs.sectionId);
    }
  });
  return ids;
}

/**
 * sectionIdがnullの見出しノードを返す（新規見出し検知用）
 * @returns {{ title: string, level: number, pos: number }[]}
 */
function _getHeadingsWithoutSectionId() {
  if (!editor) return [];
  const result = [];
  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === 'sectionHeading' && !node.attrs.sectionId) {
      result.push({
        title: node.textContent,
        level: node.attrs.level,
        pos,
        nodeSize: node.nodeSize,
      });
    }
  });
  return result;
}

/**
 * 指定セクションのコンテンツ末尾のProseMirror位置を返す
 */
function _getSectionContentEnd(sectionId) {
  if (!editor) return null;
  let targetEnd = null;
  let inTarget = false;

  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === 'sectionHeading') {
      if (node.attrs.sectionId === sectionId) {
        targetEnd = pos + node.nodeSize;
        inTarget = true;
      } else if (inTarget) {
        inTarget = false;
      }
    } else if (inTarget) {
      targetEnd = pos + node.nodeSize;
    }
  });

  return targetEnd;
}

/**
 * 指定セクションの見出しにスクロールする
 */
function _scrollToSection(sectionId) {
  if (!editor) return;
  const dom = editor.view.dom;
  const heading = dom.querySelector(`[data-section-id="${sectionId}"]`);
  if (heading) {
    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/**
 * アウトラインからセクション追加時: 親セクションのブロック末尾に見出しを挿入する
 * @param {string} sectionId - 新しいセクションのID
 * @param {string} title - 見出しタイトル
 * @param {number} level - 見出しレベル（2-6）
 * @param {string|null} afterSectionId - この直後に挿入（null=文書末尾）
 */
function _insertSectionHeading(sectionId, title, level, afterSectionId) {
  if (!editor) return;

  _suppressUpdate = true;

  const headingNode = editor.schema.nodes.sectionHeading.create(
    { level, sectionId },
    editor.schema.text(title)
  );
  const paraNode = editor.schema.nodes.paragraph.create();

  let insertPos = editor.state.doc.content.size - 1;

  if (afterSectionId) {
    // 親セクションのブロック末尾を探す
    let inTarget = false;
    editor.state.doc.forEach((node, pos) => {
      if (node.type.name === 'sectionHeading') {
        if (node.attrs.sectionId === afterSectionId) {
          inTarget = true;
          insertPos = pos + node.nodeSize;
        } else if (inTarget) {
          // 親と同じかより浅いレベルの見出しが来たら終了
          const otherLevel = node.attrs.level;
          const targetLevel = level - 1; // 親のレベル
          if (otherLevel <= targetLevel) {
            inTarget = false;
          } else {
            insertPos = pos + node.nodeSize;
          }
        }
      } else if (inTarget) {
        insertPos = pos + node.nodeSize;
      }
    });
  }

  editor.chain()
    .insertContentAt(insertPos, [headingNode.toJSON(), paraNode.toJSON()])
    .run();

  setTimeout(() => { _suppressUpdate = false; }, 50);
}

/**
 * 指定IDの見出しノードにsectionId属性を付与する
 * @param {number} pos - ProseMirror位置
 * @param {string} sectionId - 付与するセクションID
 */
function _assignSectionId(pos, sectionId) {
  if (!editor) return;
  _suppressUpdate = true;
  const { tr } = editor.state;
  tr.setNodeMarkup(pos, null, {
    ...editor.state.doc.nodeAt(pos).attrs,
    sectionId,
  });
  editor.view.dispatch(tr);
  setTimeout(() => { _suppressUpdate = false; }, 50);
}

/**
 * 指定セクションのコンテンツをTiptap上で更新する
 * app.js の update_section ツールハンドラから呼ばれる（PATCH後のビュー更新）
 * 現在はsetContentFromMarkdownで全体更新するため、レガシー互換として残す
 */
function _updateSectionContent(sectionId, newContent) {
  if (!editor) return;

  let contentStart = null;
  let contentEnd = null;
  let inTarget = false;

  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === 'sectionHeading') {
      if (node.attrs.sectionId === sectionId) {
        contentStart = pos + node.nodeSize;
        contentEnd = contentStart;
        inTarget = true;
      } else if (inTarget) {
        inTarget = false;
      }
    } else if (inTarget) {
      contentEnd = pos + node.nodeSize;
    }
  });

  if (contentStart === null) return;

  const htmlContent = newContent
    ? marked.parse(newContent)
    : '<p></p>';

  _suppressUpdate = true;

  if (contentEnd > contentStart) {
    editor.chain()
      .focus()
      .deleteRange({ from: contentStart, to: contentEnd })
      .insertContentAt(contentStart, htmlContent)
      .run();
  } else {
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
  set _suppressUpdate(v) { _suppressUpdate = v; },

  /**
   * マーカー付きMarkdown文字列をTiptapにセットする
   * @param {string} markdownContent - <!-- soki-section:uuid --> マーカー付きMarkdown
   */
  setContentFromMarkdown(markdownContent) {
    if (!editor) return;
    _suppressUpdate = true;
    const html = _markdownWithMarkersToHtml(markdownContent);
    editor.commands.setContent(html, false);
    setTimeout(() => { _suppressUpdate = false; }, 50);
  },

  /**
   * 現在のTiptapドキュメントをマーカー付きMarkdown文字列に変換して返す
   * @returns {string}
   */
  getContentAsMarkdown() {
    if (!editor) return '';
    return _serializeToMarkdown(editor.state.doc);
  },

  /**
   * 現在のTiptapドキュメントからsectionIdのSetを返す（削除検知用）
   * @returns {Set<string>}
   */
  parseSectionIds() {
    return _parseSectionIds();
  },

  /**
   * sectionIdがnull（未割当）の見出しを返す（新規見出し検知用）
   * @returns {{ title: string, level: number, pos: number }[]}
   */
  getHeadingsWithoutSectionId() {
    return _getHeadingsWithoutSectionId();
  },

  /**
   * 指定位置の見出しノードにsectionIdを割り当てる
   * @param {number} pos
   * @param {string} sectionId
   */
  assignSectionId(pos, sectionId) {
    _assignSectionId(pos, sectionId);
  },

  /**
   * アウトラインから追加: 親セクションブロック末尾に見出しを挿入する
   */
  insertSectionHeading(sectionId, title, level, afterSectionId) {
    _insertSectionHeading(sectionId, title, level, afterSectionId);
  },

  /**
   * 指定セクションにスクロールする
   */
  scrollToSection(sectionId) {
    _scrollToSection(sectionId);
  },

  /** rawのTiptapエディタインスタンスを返す */
  getEditor() {
    return editor;
  },

  /**
   * エディタの編集可否を切り替える（LLM実行中ロック用）
   */
  setEditable(editable) {
    if (!editor) return;
    editor.setEditable(editable);
    const mount = document.getElementById('tiptap-editor-mount');
    if (mount) mount.classList.toggle('tiptap-locked', !editable);
  },

  /**
   * 指定セクションのコンテンツをTiptap上で更新する（app.js ツールハンドラ用）
   * setContentFromMarkdown での全体更新が推奨。レガシー互換として維持。
   */
  updateSectionContent(sectionId, content) {
    _updateSectionContent(sectionId, content);
  },

  /**
   * 指定セクションのコンテンツ末尾のProseMirror位置を返す
   */
  getSectionContentEnd(sectionId) {
    return _getSectionContentEnd(sectionId);
  },

  // 後方互換: setContentFromSections は不使用だが残す
  setContentFromSections(sections) {
    // 新アーキテクチャでは setContentFromMarkdown を使う
    // フォールバック: セクション配列から簡易的にHTMLを生成
    if (!editor) return;
    _suppressUpdate = true;
    const html = sections.map(sec => {
      const level = 2;
      return `<h${level} data-section-id="${sec.id}">${sec.title}</h${level}><p>${sec.content || ''}</p>`;
    }).join('');
    editor.commands.setContent(html || '<p></p>', false);
    setTimeout(() => { _suppressUpdate = false; }, 50);
  },

  // 後方互換: parseSections
  parseSections() {
    if (!editor) return [];
    const sections = [];
    let current = null;
    let body = '';
    editor.state.doc.forEach(node => {
      if (node.type.name === 'sectionHeading') {
        if (current) { current.content = body.trim(); sections.push(current); }
        current = { id: node.attrs.sectionId, title: node.textContent, content: '' };
        body = '';
      } else {
        body += node.textContent + '\n\n';
      }
    });
    if (current) { current.content = body.trim(); sections.push(current); }
    return sections;
  },
};

// ─── 初期化 ──────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    _initEditor();
    document.dispatchEvent(new Event('tiptap-ready'));
  });
} else {
  _initEditor();
  document.dispatchEvent(new Event('tiptap-ready'));
}
