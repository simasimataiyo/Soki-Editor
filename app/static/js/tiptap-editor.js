/**
 * tiptap-editor.js — Tiptap WYSIWYG統合レイヤー（新アーキテクチャ）
 *
 * 本文はマーカー付きMarkdown（project.content）として管理する。
 * window.TiptapEditor として公開し、edit-tab.js / app.js から利用する。
 *
 * マーカー形式: <!-- soki-section:uuid --> を見出し直前に挿入
 */

import { Editor, Node, Extension, mergeAttributes, textblockTypeInputRule } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import BubbleMenu from '@tiptap/extension-bubble-menu';
import Placeholder from '@tiptap/extension-placeholder';
import { marked } from 'marked';

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
      summary: {
        default: '',
        parseHTML: el => el.getAttribute('data-summary') || '',
        renderHTML: attrs => (attrs.summary ? { 'data-summary': attrs.summary } : {}),
      },
      parentId: {
        default: null,
        parseHTML: el => el.getAttribute('data-parent-id') || null,
        renderHTML: attrs => (attrs.parentId ? { 'data-parent-id': attrs.parentId } : {}),
      },
      sectionOrder: {
        default: 0,
        parseHTML: el => parseInt(el.getAttribute('data-section-order') || '0', 10),
        renderHTML: attrs => ({ 'data-section-order': String(attrs.sectionOrder) }),
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

  const bubbleMenuEl = document.getElementById('tiptap-bubble-menu');
  if (bubbleMenuEl) {
    bubbleMenuEl.style.display = ''; // tippyに管理を移す前に初期表示リセット
  }

  editor = new Editor({
    element: mountEl,
    extensions: [
      StarterKit.configure({
        heading: false, // 組み込みHeadingを無効化してSectionHeadingを使用
      }),
      SectionHeading,
      TabHandler,
      Placeholder.configure({
        placeholder: '本文を入力...',
      }),
      ...(bubbleMenuEl ? [
        BubbleMenu.configure({
          element: bubbleMenuEl,
          tippyOptions: { duration: 100 },
        })
      ] : []),
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'tiptap-prosemirror',
      },
    },
  });

  if (bubbleMenuEl) {
    const btnBold = bubbleMenuEl.querySelector('[data-action="bold"]');
    const btnItalic = bubbleMenuEl.querySelector('[data-action="italic"]');
    const btnStrike = bubbleMenuEl.querySelector('[data-action="strike"]');
    const btnCode = bubbleMenuEl.querySelector('[data-action="code"]');

    if (btnBold) btnBold.addEventListener('click', () => editor.chain().focus().toggleBold().run());
    if (btnItalic) btnItalic.addEventListener('click', () => editor.chain().focus().toggleItalic().run());
    if (btnStrike) btnStrike.addEventListener('click', () => editor.chain().focus().toggleStrike().run());
    if (btnCode) btnCode.addEventListener('click', () => editor.chain().focus().toggleCode().run());

    editor.on('selectionUpdate', () => {
      if (btnBold) btnBold.classList.toggle('is-active', editor.isActive('bold'));
      if (btnItalic) btnItalic.classList.toggle('is-active', editor.isActive('italic'));
      if (btnStrike) btnStrike.classList.toggle('is-active', editor.isActive('strike'));
      if (btnCode) btnCode.classList.toggle('is-active', editor.isActive('code'));
    });
  }
}

// ─── Markdown → HTML 変換 ────────────────────────────────────

/**
 * マーカー付きMarkdown文字列をTiptap用HTMLに変換する
 * <!-- soki-section:uuid --> を検出してdata-section-id属性を付与する
 */
/**
 * マーカー文字列からセクションメタデータを抽出する（新旧両形式対応）
 * 新形式: <!-- soki-section:{"id":"uuid","summary":"...","parentId":null,"sectionOrder":0} -->
 * 旧形式: <!-- soki-section:uuid -->
 * @returns {{ sectionId: string, summary: string, parentId: string|null, sectionOrder: number }}
 */
function _parseMarkerMeta(markerPayload) {
  if (markerPayload.startsWith('{')) {
    try {
      const meta = JSON.parse(markerPayload);
      return {
        sectionId: meta.id || null,
        summary: meta.summary || '',
        parentId: meta.parentId || null,
        sectionOrder: typeof meta.sectionOrder === 'number' ? meta.sectionOrder : 0,
      };
    } catch (_) { /* fallthrough */ }
  }
  // 旧形式: UUIDのみ
  return { sectionId: markerPayload, summary: '', parentId: null, sectionOrder: 0 };
}

function _markdownWithMarkersToHtml(markdownContent) {
  if (!markdownContent || markdownContent.trim() === '') return '<p></p>';

  // 新形式: {JSON} / 旧形式: uuid の両方にマッチ
  const MARKER_RE = /<!-- soki-section:(\{[^}]*\}|[a-f0-9-]+) -->\n?/g;

  // マーカーで分割して各チャンクを処理
  const segments = []; // { sectionId, summary, parentId, sectionOrder, text }

  const allMatches = [...markdownContent.matchAll(MARKER_RE)];

  if (allMatches.length === 0) {
    // マーカーなし: 全体をそのままMarkdown→HTMLに変換
    segments.push({ sectionId: null, summary: '', parentId: null, sectionOrder: 0, text: markdownContent });
  } else {
    // マーカー前のテキスト
    if (allMatches[0].index > 0) {
      segments.push({ sectionId: null, summary: '', parentId: null, sectionOrder: 0, text: markdownContent.slice(0, allMatches[0].index) });
    }
    for (let i = 0; i < allMatches.length; i++) {
      const m = allMatches[i];
      const meta = _parseMarkerMeta(m[1]);
      const start = m.index + m[0].length;
      const end = i + 1 < allMatches.length ? allMatches[i + 1].index : markdownContent.length;
      segments.push({ ...meta, text: markdownContent.slice(start, end) });
    }
  }

  let html = '';
  for (const seg of segments) {
    if (!seg.text.trim()) continue;
    let segHtml = marked.parse(seg.text);
    // 最初の見出しにdata-*属性を付与
    if (seg.sectionId) {
      const escSummary = (seg.summary || '').replace(/"/g, '&quot;');
      const escParentId = seg.parentId || '';
      segHtml = segHtml.replace(
        /^(<h[2-6])(\s|>)/,
        (_, tag, rest) => {
          let attrs = ` data-section-id="${seg.sectionId}"`;
          if (escSummary) attrs += ` data-summary="${escSummary}"`;
          if (escParentId) attrs += ` data-parent-id="${escParentId}"`;
          attrs += ` data-section-order="${seg.sectionOrder}"`;
          return `${tag}${attrs}${rest}`;
        }
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
          const meta = JSON.stringify({
            id,
            summary: node.attrs.summary || '',
            parentId: node.attrs.parentId || null,
            sectionOrder: node.attrs.sectionOrder ?? 0,
          });
          lines.push(`<!-- soki-section:${meta} -->`);
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
 * 現在のTiptapドキュメントから全セクション情報を配列で返す
 * @returns {{ id: string, title: string, level: number, summary: string, parentId: string|null, sectionOrder: number, pos: number }[]}
 */
function _parseSectionsFromDoc() {
  if (!editor) return [];
  const result = [];
  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === 'sectionHeading' && node.attrs.sectionId) {
      result.push({
        id: node.attrs.sectionId,
        title: node.textContent,
        level: node.attrs.level,
        summary: node.attrs.summary || '',
        parentId: node.attrs.parentId || null,
        sectionOrder: node.attrs.sectionOrder ?? 0,
        pos,
      });
    }
  });
  return result;
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
 * 指定位置の見出しノードにセクションメタデータ属性を付与する
 * @param {number} pos - ProseMirror位置
 * @param {{ sectionId: string, summary?: string, parentId?: string|null, sectionOrder?: number }} meta
 */
function _assignSectionMeta(pos, meta) {
  if (!editor) return;
  // IME変換中はdispatchを行わない（compositionを中断するとテキストが重複する）
  if (editor.view.composing) return;
  _suppressUpdate = true;
  const { tr } = editor.state;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) { _suppressUpdate = false; return; }
  tr.setNodeMarkup(pos, null, { ...node.attrs, ...meta });
  editor.view.dispatch(tr);
  setTimeout(() => { _suppressUpdate = false; }, 50);
}

/**
 * IDでノードを探してメタデータ属性を更新する（D&D後のorder/parentId更新用）
 * @param {string} sectionId
 * @param {{ summary?: string, parentId?: string|null, sectionOrder?: number }} attrs
 */
function _updateSectionMetaById(sectionId, attrs) {
  if (!editor) return;
  let targetPos = null;
  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === 'sectionHeading' && node.attrs.sectionId === sectionId) {
      targetPos = pos;
    }
  });
  if (targetPos !== null) {
    _assignSectionMeta(targetPos, attrs);
  }
}

/**
 * IDで見出しノードを探してTiptapドキュメントから削除する（アウトライン削除ボタン用）
 * @param {string} sectionId
 */
function _deleteSectionHeading(sectionId) {
  if (!editor) return;
  let targetFrom = null;
  let targetTo = null;
  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === 'sectionHeading' && node.attrs.sectionId === sectionId) {
      targetFrom = pos;
      targetTo = pos + node.nodeSize;
    }
  });
  if (targetFrom === null) return;
  _suppressUpdate = true;
  editor.chain().deleteRange({ from: targetFrom, to: targetTo }).run();
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
   * 指定位置の見出しノードにセクションメタデータを割り当てる
   * @param {number} pos
   * @param {{ sectionId: string, summary?: string, parentId?: string|null, sectionOrder?: number }} meta
   */
  assignSectionMeta(pos, meta) {
    _assignSectionMeta(pos, meta);
  },

  /**
   * タイトルで見出しノードを再検索してセクションメタデータを割り当てる
   * （非同期処理後にposが古くなっている場合に使用）
   * @param {string} title - 検索するタイトル文字列
   * @param {{ sectionId: string, summary?: string, parentId?: string|null, sectionOrder?: number }} meta
   */
  assignSectionMetaByTitle(title, meta) {
    if (!editor) return;
    let targetPos = null;
    editor.state.doc.forEach((node, pos) => {
      if (node.type.name === 'sectionHeading' && !node.attrs.sectionId) {
        const nodeTitle = node.textContent;
        if (nodeTitle === title) {
          targetPos = pos;
        }
      }
    });
    if (targetPos !== null) {
      _assignSectionMeta(targetPos, meta);
    }
  },

  /**
   * 全sectionHeadingノードの属性+titleを配列で返す（アウトライン更新用）
   * @returns {{ id, title, level, summary, parentId, sectionOrder, pos }[]}
   */
  parseSectionsFromDoc() {
    return _parseSectionsFromDoc();
  },

  /**
   * IDでノードを探してメタデータ属性を更新する（D&D後のorder/parentId更新用）
   * @param {string} sectionId
   * @param {{ summary?: string, parentId?: string|null, sectionOrder?: number }} attrs
   */
  updateSectionMetaById(sectionId, attrs) {
    _updateSectionMetaById(sectionId, attrs);
  },

  /**
   * IDで見出しノードをTiptapドキュメントから削除する（アウトライン削除ボタン用）
   * @param {string} sectionId
   */
  deleteSectionHeading(sectionId) {
    _deleteSectionHeading(sectionId);
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
