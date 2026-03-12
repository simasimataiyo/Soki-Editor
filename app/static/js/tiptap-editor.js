/**
 * tiptap-editor.js — Tiptap WYSIWYG統合レイヤー（新アーキテクチャ）
 *
 * 本文はマーカー付きMarkdown（project.content）として管理する。
 * window.TiptapEditor として公開し、edit-tab.js / app.js から利用する。
 *
 * マーカー形式: <!-- soki-section:uuid --> を見出し直前に挿入
 */

import { Editor, Node, Extension, InputRule, mergeAttributes, textblockTypeInputRule } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Fragment } from '@tiptap/pm/model';
import CharacterCount from '@tiptap/extension-character-count';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import UniqueID from '@tiptap/extension-unique-id';
import DragHandle from '@tiptap/extension-drag-handle';
import TableOfContents from '@tiptap/extension-table-of-contents';
import { marked } from 'marked';

// marked の設定: GFMオン、改行保持
marked.setOptions({ gfm: true, breaks: false });

// ─── カスタムノード: SectionHeading ─────────────────────────
// セクションIDを data-section-id 属性として保持する見出しノード
// level: 1-6 (h1-h6)、sectionId: UUID or null（新規見出しはnull）

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
    return [1, 2, 3, 4, 5, 6].map(level => ({
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

const ReferenceNode = Node.create({
  name: 'referenceNode',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return {
      refId: {
        default: null,
        parseHTML: el => el.getAttribute('data-ref-id'),
        renderHTML: attrs => ({ 'data-ref-id': attrs.refId }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-ref-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'reference-node', contenteditable: 'false' })];
  },
  addInputRules() {
    return [
      new InputRule({
        find: /\[\^(ref-[^\]]+)\]$/,
        handler: ({ state, range, match }) => {
          const { tr } = state;
          tr.replaceWith(range.from, range.to, this.type.create({ refId: match[1] }));
        },
      }),
    ];
  },
});

const FigureNode = Node.create({
  name: 'figureNode',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return {
      figId: {
        default: null,
        parseHTML: el => el.getAttribute('data-fig-id'),
        renderHTML: attrs => ({ 'data-fig-id': attrs.figId }),
      },
      altText: {
        default: '',
        parseHTML: el => el.getAttribute('data-alt-text'),
        renderHTML: attrs => ({ 'data-alt-text': attrs.altText }),
      }
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-fig-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'figure-node', contenteditable: 'false' }), ''];
  },
  addInputRules() {
    return [
      new InputRule({
        find: /!\[([^\]]*)\]\([^)]*"([^"]+)"\)$/,
        handler: ({ state, range, match }) => {
          const { tr } = state;
          tr.replaceWith(range.from, range.to, this.type.create({ altText: match[1], figId: match[2] }));
        },
      }),
    ];
  },
});

// FigureBlockNode: ブロック要素として図表を埋め込む
const FigureBlockNode = Node.create({
  name: 'figureBlockNode',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      figId: {
        default: null,
        parseHTML: el => el.getAttribute('data-fig-block-id'),
        renderHTML: attrs => ({ 'data-fig-block-id': attrs.figId }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-fig-block-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'figure-block-node', contenteditable: 'false' }), 0];
  },
});

// ─── 図表番号自動採番プラグイン ──────────────────────────────
const FigureNumberPluginKey = new PluginKey('figureNumberPlugin');
const FigureNumberExtension = Extension.create({
  name: 'figureNumber',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: FigureNumberPluginKey,
        props: {
          decorations(state) {
            const materials = (window.TiptapEditor && window.TiptapEditor._materialsData) || [];
            const matById = {};
            materials.forEach(m => { matById[m.id] = m; });

            // 図・表それぞれの採番カウンター
            const figCounter = {};  // figId -> 図N
            const tabCounter = {};  // figId -> 表N
            let figNum = 0;
            let tabNum = 0;

            state.doc.descendants((node) => {
              if (node.type.name === 'figureNode') {
                const id = node.attrs.figId;
                if (!id) return;
                if (figCounter[id] !== undefined || tabCounter[id] !== undefined) return;
                const mat = matById[id];
                if (mat && mat.type === 'table') {
                  tabNum++;
                  tabCounter[id] = tabNum;
                } else {
                  figNum++;
                  figCounter[id] = figNum;
                }
              }
              if (node.type.name === 'figureBlockNode') {
                const id = node.attrs.figId;
                if (!id) return;
                if (figCounter[id] !== undefined || tabCounter[id] !== undefined) return;
                const mat = matById[id];
                if (mat && mat.type === 'table') {
                  tabNum++;
                  tabCounter[id] = tabNum;
                } else {
                  figNum++;
                  figCounter[id] = figNum;
                }
              }
            });

            const decorations = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name === 'figureNode') {
                const id = node.attrs.figId;
                if (!id) return;
                const mat = matById[id];
                let label;
                if (mat && mat.type === 'table') {
                  label = `表${tabCounter[id] || '?'}`;
                } else {
                  label = `図${figCounter[id] || '?'}`;
                }
                const widget = document.createElement('span');
                widget.className = 'figure-ref-badge';
                widget.setAttribute('data-fig-id', id);
                widget.textContent = label;
                widget.contentEditable = 'false';
                decorations.push(Decoration.widget(pos, widget, { side: 1, key: `fig-num-${id}-${pos}` }));
              }
            });

            return DecorationSet.create(state.doc, decorations);
          }
        }
      })
    ];
  }
});

// ─── 図表ブロックレンダリングプラグイン ──────────────────────
const FigureBlockPluginKey = new PluginKey('figureBlockPlugin');
const FigureBlockExtension = Extension.create({
  name: 'figureBlock',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: FigureBlockPluginKey,
        props: {
          decorations(state) {
            const materials = (window.TiptapEditor && window.TiptapEditor._materialsData) || [];
            const projectId = window.appState && window.appState.getProject && window.appState.getProject()?.id;
            const matById = {};
            materials.forEach(m => { matById[m.id] = m; });

            // 図・表の全採番（figureNode含む）
            const figCounter = {};
            const tabCounter = {};
            let figNum = 0;
            let tabNum = 0;
            state.doc.descendants((node) => {
              if (node.type.name === 'figureNode' || node.type.name === 'figureBlockNode') {
                const id = node.attrs.figId;
                if (!id) return;
                if (figCounter[id] !== undefined || tabCounter[id] !== undefined) return;
                const mat = matById[id];
                if (mat && mat.type === 'table') {
                  tabNum++;
                  tabCounter[id] = tabNum;
                } else {
                  figNum++;
                  figCounter[id] = figNum;
                }
              }
            });

            const decorations = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name === 'figureBlockNode') {
                const id = node.attrs.figId;
                const mat = matById[id];
                if (!mat) return;

                const isTable = mat.type === 'table';
                const num = isTable ? tabCounter[id] : figCounter[id];
                const prefix = isTable ? '表' : '図';
                const caption = mat.caption || mat.name || '';
                const captionText = caption ? `${prefix}${num || '?'}: ${caption}` : `${prefix}${num || '?'}`;

                const wrapper = document.createElement('div');
                wrapper.className = 'figure-block-inner';
                wrapper.contentEditable = 'false';

                const dragHandle = document.createElement('div');
                dragHandle.className = 'figure-block-drag-handle';
                dragHandle.setAttribute('data-drag-handle', '');
                wrapper.appendChild(dragHandle);

                const contentArea = document.createElement('div');
                contentArea.className = 'figure-block-content';

                if (isTable && mat.table_content) {
                  const tableWrap = document.createElement('div');
                  tableWrap.className = 'figure-block-table-wrap';
                  tableWrap.innerHTML = marked.parse(mat.table_content);
                  contentArea.appendChild(tableWrap);
                } else if (!isTable && mat.thumbnail_path && projectId) {
                  const img = document.createElement('img');
                  img.src = `/api/files?path=${encodeURIComponent(mat.thumbnail_path)}&project_id=${projectId}`;
                  img.alt = caption;
                  img.className = 'figure-block-img';
                  contentArea.appendChild(img);
                } else if (!isTable && mat.file_path && projectId) {
                  const img = document.createElement('img');
                  img.src = `/api/files?path=${encodeURIComponent(mat.file_path)}&project_id=${projectId}`;
                  img.alt = caption;
                  img.className = 'figure-block-img';
                  contentArea.appendChild(img);
                } else {
                  const placeholder = document.createElement('div');
                  placeholder.className = 'figure-block-placeholder';
                  placeholder.textContent = isTable ? '（表データなし）' : '（画像なし）';
                  contentArea.appendChild(placeholder);
                }

                const cap = document.createElement('div');
                cap.className = 'figure-block-caption';
                cap.textContent = captionText;
                contentArea.appendChild(cap);
                wrapper.appendChild(contentArea);

                decorations.push(Decoration.widget(pos + 1, wrapper, { side: 0, key: `fig-block-${id}-${pos}` }));
              }
            });

            return DecorationSet.create(state.doc, decorations);
          }
        }
      })
    ];
  }
});

const ReferenceListPluginKey = new PluginKey('referenceListPlugin');
const ReferenceListExtension = Extension.create({
  name: 'referenceList',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: ReferenceListPluginKey,
        state: {
          init() { return null; },
          apply(tr, oldState) { return null; }
        },
        props: {
          decorations(state) {
            const isEnabled = window.TiptapEditor && window.TiptapEditor._referencesEnabled;
            if (!isEnabled) return DecorationSet.empty;
            const refMap = {};
            let counter = 0;
            state.doc.descendants(node => {
              if (node.type.name === 'referenceNode') {
                const srcId = node.attrs.refId;
                if (!refMap[srcId]) {
                  counter++;
                  refMap[srcId] = counter;
                }
              }
            });
            const entries = Object.entries(refMap).sort((a, b) => a[1] - b[1]);
            const block = document.createElement('div');
            block.className = 'section-block references-block';
            block.contentEditable = 'false';

            const sources = (window.TiptapEditor && window.TiptapEditor._sourcesData) ? window.TiptapEditor._sourcesData : [];
            const srcById = {};
            sources.forEach(s => {
              if (s.bibliography && s.bibliography.include_in_references) {
                srcById[s.id] = s;
              }
            });

            const escapeHTML = str => str ? String(str).replace(/[&<>'"]/g, t => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[t])) : '';

            let entriesHtml = '';
            if (entries.length === 0) {
              entriesHtml = '<p class="references-empty">参考文献はまだありません。本文中に [^ref-xxx] 形式で文献を挿入してください。</p>';
            } else {
              entriesHtml = entries.map(([srcId, num]) => {
                const src = srcById[srcId];
                if (!src) return '';
                const bib = src.bibliography;
                if (!bib) return ''; // Add extra safety for bib
                const parts = [];
                if (bib.author) parts.push(escapeHTML(bib.author));
                if (bib.title) parts.push(`『${escapeHTML(bib.title)}』`);
                if (bib.journal) parts.push(escapeHTML(bib.journal));
                if (bib.year) parts.push(`(${escapeHTML(bib.year)})`);
                if (bib.url) parts.push(escapeHTML(bib.url));
                const text = parts.length ? parts.join(' ') : '(文献情報なし)';
                return `<div class="references-entry">[${num}] ${text}</div>`;
              }).join('');
            }
            block.innerHTML = `
              <div class="section-header references-header" style="margin-top: 2rem;">
                <h2 class="section-title"><span class="section-bullet">≡</span> 参考文献</h2>
              </div>
              <div class="section-body references-body">
                ${entriesHtml}
              </div>
            `;
            const dec = Decoration.widget(state.doc.content.size, block, { side: 1, marks: [] });
            return DecorationSet.create(state.doc, [dec]);
          }
        }
      })
    ];
  }
});

// ─── 文献番号自動採番バッジプラグイン ────────────────────
const ReferenceNumberPluginKey = new PluginKey('referenceNumberPlugin');
const ReferenceNumberExtension = Extension.create({
  name: 'referenceNumber',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: ReferenceNumberPluginKey,
      props: {
        decorations(state) {
          const isEnabled = window.TiptapEditor && window.TiptapEditor._referencesEnabled;
          if (!isEnabled) return DecorationSet.empty;
          const refMap = {};
          let counter = 0;
          state.doc.descendants(node => {
            if (node.type.name === 'referenceNode') {
              const srcId = node.attrs.refId;
              if (srcId && refMap[srcId] === undefined) {
                counter++;
                refMap[srcId] = counter;
              }
            }
          });
          const decorations = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'referenceNode') {
              const num = refMap[node.attrs.refId];
              if (num === undefined) return;
              const widget = document.createElement('span');
              widget.className = 'reference-ref-badge';
              widget.setAttribute('data-ref-id', node.attrs.refId);
              widget.textContent = `[${num}]`;
              widget.contentEditable = 'false';
              decorations.push(Decoration.widget(pos, widget, { side: 1, key: `ref-num-${node.attrs.refId}-${pos}` }));
            }
          });
          return DecorationSet.create(state.doc, decorations);
        }
      }
    })];
  }
});

let _tooltipEl = null;
function _getTooltip() {
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.className = 'section-tooltip';
    _tooltipEl.style.display = 'none';
    document.body.appendChild(_tooltipEl);
  }
  return _tooltipEl;
}

const TooltipPluginKey = new PluginKey('tooltipPlugin');
const TooltipExtension = Extension.create({
  name: 'tooltipExtension',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: TooltipPluginKey,
        props: {
          handleDOMEvents: {
            mouseover(view, event) {
              const target = event.target;
              if (!target) return false;

              const tooltip = _getTooltip();
              const showTooltip = (text) => {
                tooltip.textContent = text;
                tooltip.style.display = 'block';
                tooltip.style.left = (event.pageX + 10) + 'px';
                tooltip.style.top = (event.pageY + 10) + 'px';
              };

              const heading = target.closest('h1, h2, h3, h4, h5, h6');
              if (heading && heading.hasAttribute('data-summary')) {
                const summary = heading.getAttribute('data-summary');
                if (summary) { showTooltip(summary); return false; }
              }
              if (target.matches('span.reference-node') || target.matches('span.reference-ref-badge')) {
                const srcId = target.getAttribute('data-ref-id');
                const src = ((window.TiptapEditor && window.TiptapEditor._sourcesData) || []).find(s => s.id === srcId);
                if (src) { showTooltip(src.bibliography?.title || src.name); return false; }
              }
              if (target.matches('span.figure-node')) {
                const figId = target.getAttribute('data-fig-id');
                const mat = ((window.TiptapEditor && window.TiptapEditor._materialsData) || []).find(s => s.id === figId);
                if (mat) { showTooltip(mat.caption || mat.name); return false; }
              }

              tooltip.style.display = 'none';
              return false;
            },
            mouseout(view, event) {
              if (_tooltipEl) _tooltipEl.style.display = 'none';
              return false;
            }
          }
        }
      })
    ];
  }
});

// ─── SearchAndReplace Extension ──────────────────────────────

const searchPluginKey = new PluginKey('searchReplace');

const SearchAndReplaceExtension = Extension.create({
  name: 'searchAndReplace',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchPluginKey,
        state: {
          init() {
            return { query: '', caseSensitive: false, decorations: DecorationSet.empty, results: [], current: -1 };
          },
          apply(tr, prev) {
            const meta = tr.getMeta(searchPluginKey);
            if (meta) {
              return _buildSearchState(tr.doc, meta.query ?? prev.query, meta.caseSensitive ?? prev.caseSensitive, meta.current ?? -1);
            }
            if (tr.docChanged && prev.query) {
              return _buildSearchState(tr.doc, prev.query, prev.caseSensitive, prev.current);
            }
            if (tr.docChanged) {
              return { ...prev, decorations: DecorationSet.empty, results: [] };
            }
            return prev;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state).decorations;
          },
        },
      }),
    ];
  },
});

function _buildSearchState(doc, query, caseSensitive, currentIdx) {
  if (!query) return { query, caseSensitive, decorations: DecorationSet.empty, results: [], current: -1 };

  const results = [];
  const flags = caseSensitive ? 'g' : 'gi';
  let re;
  try { re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); } catch (_) {
    return { query, caseSensitive, decorations: DecorationSet.empty, results: [], current: -1 };
  }

  doc.descendants((node, pos) => {
    if (!node.isText) return;
    let m;
    while ((m = re.exec(node.text)) !== null) {
      results.push({ from: pos + m.index, to: pos + m.index + m[0].length });
    }
  });

  const safeIdx = results.length === 0 ? -1 : ((currentIdx % results.length) + results.length) % results.length;

  const decos = results.map((r, i) => {
    const cls = i === safeIdx ? 'search-highlight-current' : 'search-highlight';
    return Decoration.inline(r.from, r.to, { class: cls });
  });

  return { query, caseSensitive, decorations: DecorationSet.create(doc, decos), results, current: safeIdx };
}

// ─── Tiptap Editor インスタンス ──────────────────────────────

let editor = null;
let _suppressUpdate = false;

function _initEditor() {
  const mountEl = document.getElementById('tiptap-editor-mount');
  if (!mountEl) return;

  const toolbarEl = document.getElementById('tiptap-toolbar');

  editor = new Editor({
    element: mountEl,
    extensions: [
      StarterKit.configure({
        heading: false, // 組み込みHeadingを無効化してSectionHeadingを使用
      }),
      SectionHeading,
      TabHandler,
      ReferenceNode,
      FigureNode,
      FigureBlockNode,
      UniqueID.configure({
        types: ['sectionHeading'],
        attributeName: 'sectionId',
      }),
      DragHandle.configure({
        nested: true, // Allow nesting if needed, or false to just drag top level nodes
        render: () => {
          const element = document.createElement('div');
          element.className = 'custom-drag-handle';
          element.innerHTML = '⋮⋮';
          return element;
        },
        shouldShow: ({ state, from }) => {
          const node = state.doc.nodeAt(from);
          if (node && node.type.name === 'figureBlockNode') return false;
          return true;
        },
      }),
      TableOfContents.configure({
        anchorTypes: ['sectionHeading'],
        onUpdate: (data) => {
          if (window.TiptapEditor && window.TiptapEditor._onTOCUpdate) {
            window.TiptapEditor._onTOCUpdate(data);
          }
        },
      }),
      CharacterCount.configure({ limit: null }),
      ReferenceListExtension,
      ReferenceNumberExtension,
      FigureNumberExtension,
      FigureBlockExtension,
      TooltipExtension,
      Placeholder.configure({
        placeholder: '本文を入力...',
      }),
      SearchAndReplaceExtension,
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'tiptap-prosemirror',
      },
      handleKeyDown: (view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
          event.preventDefault();
          if (!window.BubblePrompt) return false;
          const { selection } = view.state;
          const coords = view.coordsAtPos(selection.head);
          const rect = { top: coords.top, bottom: coords.bottom, left: coords.left };
          const selectedText = selection.empty
            ? ''
            : view.state.doc.textBetween(selection.from, selection.to, ' ');
          window.BubblePrompt.toggle(rect, selectedText);
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'h') {
          event.preventDefault();
          _toggleSearchBar();
          return true;
        }
        return false;
      },
    },
  });

  if (toolbarEl) {
    const btnBold = toolbarEl.querySelector('[data-action="bold"]');
    const btnItalic = toolbarEl.querySelector('[data-action="italic"]');
    const btnStrike = toolbarEl.querySelector('[data-action="strike"]');
    const btnCode = toolbarEl.querySelector('[data-action="code"]');

    if (btnBold) btnBold.addEventListener('mousedown', e => e.preventDefault());
    if (btnBold) btnBold.addEventListener('click', () => editor.chain().focus().toggleBold().run());

    if (btnItalic) btnItalic.addEventListener('mousedown', e => e.preventDefault());
    if (btnItalic) btnItalic.addEventListener('click', () => editor.chain().focus().toggleItalic().run());

    if (btnStrike) btnStrike.addEventListener('mousedown', e => e.preventDefault());
    if (btnStrike) btnStrike.addEventListener('click', () => editor.chain().focus().toggleStrike().run());

    if (btnCode) btnCode.addEventListener('mousedown', e => e.preventDefault());
    if (btnCode) btnCode.addEventListener('click', () => editor.chain().focus().toggleCode().run());

    editor.on('selectionUpdate', () => {
      if (btnBold) btnBold.classList.toggle('is-active', editor.isActive('bold'));
      if (btnItalic) btnItalic.classList.toggle('is-active', editor.isActive('italic'));
      if (btnStrike) btnStrike.classList.toggle('is-active', editor.isActive('strike'));
      if (btnCode) btnCode.classList.toggle('is-active', editor.isActive('code'));
    });

    // 検索ボタン
    const btnSearchToggle = document.getElementById('btn-search-toggle');
    if (btnSearchToggle) {
      btnSearchToggle.addEventListener('mousedown', e => e.preventDefault());
      btnSearchToggle.addEventListener('click', () => _toggleSearchBar());
    }
  }

  _initSearchBar();
}

// ─── 検索・置換バーロジック ───────────────────────────────────

function _toggleSearchBar() {
  const bar = document.getElementById('search-replace-bar');
  if (!bar) return;
  const isVisible = bar.style.display !== 'none';
  if (isVisible) {
    bar.style.display = 'none';
    document.getElementById('btn-search-toggle')?.classList.remove('is-active');
    _clearSearch();
    editor && editor.commands.focus();
  } else {
    bar.style.display = '';
    document.getElementById('btn-search-toggle')?.classList.add('is-active');
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }
}

function _clearSearch() {
  if (!editor) return;
  editor.view.dispatch(editor.state.tr.setMeta(searchPluginKey, { query: '', caseSensitive: false, current: -1 }));
  const countEl = document.getElementById('search-match-count');
  if (countEl) countEl.textContent = '';
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.classList.remove('search-no-match');
}

function _applySearch(moveTo) {
  if (!editor) return;
  const query = document.getElementById('search-input')?.value || '';
  const caseSensitive = document.getElementById('search-case-sensitive')?.checked || false;

  const prevState = searchPluginKey.getState(editor.state);
  let current = prevState?.current ?? -1;

  if (moveTo === 'next') current = current < 0 ? 0 : current + 1;
  else if (moveTo === 'prev') current = current <= 0 ? -1 : current - 1;
  else current = query !== prevState?.query ? 0 : current;

  editor.view.dispatch(editor.state.tr.setMeta(searchPluginKey, { query, caseSensitive, current }));

  // 結果数表示 & カレント位置スクロール
  requestAnimationFrame(() => {
    const st = searchPluginKey.getState(editor.state);
    const countEl = document.getElementById('search-match-count');
    const searchInput = document.getElementById('search-input');
    if (!st) return;
    if (query === '') {
      if (countEl) countEl.textContent = '';
      if (searchInput) searchInput.classList.remove('search-no-match');
      return;
    }
    const total = st.results.length;
    const cur = st.current;
    if (countEl) countEl.textContent = total === 0 ? '0件' : `${cur + 1}/${total}`;
    if (searchInput) searchInput.classList.toggle('search-no-match', total === 0);
    // カレントハイライトにスクロール
    if (total > 0 && cur >= 0 && cur < st.results.length) {
      const pos = st.results[cur].from;
      const coords = editor.view.coordsAtPos(pos);
      const editorDom = editor.view.dom;
      const container = editorDom.closest('#tiptap-editor-mount') || editorDom.parentElement;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const offset = coords.top - containerRect.top + container.scrollTop - container.clientHeight / 2;
        container.scrollTop = offset;
      }
    }
  });
}

function _replaceOne() {
  if (!editor) return;
  const query = document.getElementById('search-input')?.value || '';
  const replacement = document.getElementById('replace-input')?.value || '';
  if (!query) return;

  const st = searchPluginKey.getState(editor.state);
  if (!st || st.results.length === 0 || st.current < 0) {
    _applySearch();
    return;
  }
  const { from, to } = st.results[st.current];
  editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, replacement).run();
  _applySearch();
}

function _replaceAll() {
  if (!editor) return;
  const query = document.getElementById('search-input')?.value || '';
  const replacement = document.getElementById('replace-input')?.value || '';
  const caseSensitive = document.getElementById('search-case-sensitive')?.checked || false;
  if (!query) return;

  // 最新の状態で全件取得
  editor.view.dispatch(editor.state.tr.setMeta(searchPluginKey, { query, caseSensitive, current: 0 }));

  const st = searchPluginKey.getState(editor.state);
  if (!st || st.results.length === 0) return;

  // 後ろから順に置換（位置ズレ防止）
  let { tr } = editor.state;
  const results = [...st.results].reverse();
  for (const { from, to } of results) {
    tr = tr.replaceWith(from, to, editor.schema.text(replacement));
  }
  editor.view.dispatch(tr);
  showToast(`${st.results.length}件を置換しました`, 'success');
  _applySearch();
}

function _initSearchBar() {
  const searchInput = document.getElementById('search-input');
  const replaceInput = document.getElementById('replace-input');
  const caseCheck = document.getElementById('search-case-sensitive');

  if (searchInput) {
    searchInput.addEventListener('input', () => _applySearch());
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); _applySearch(e.shiftKey ? 'prev' : 'next'); }
      if (e.key === 'Escape') { e.preventDefault(); _toggleSearchBar(); }
    });
  }
  if (replaceInput) {
    replaceInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); _toggleSearchBar(); }
    });
  }
  if (caseCheck) caseCheck.addEventListener('change', () => _applySearch());

  document.getElementById('btn-search-prev')?.addEventListener('click', () => _applySearch('prev'));
  document.getElementById('btn-search-next')?.addEventListener('click', () => _applySearch('next'));
  document.getElementById('btn-replace-one')?.addEventListener('click', () => _replaceOne());
  document.getElementById('btn-replace-all')?.addEventListener('click', () => _replaceAll());
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

    // Replace markdown refs and figs with spans so marked doesn't touch them and parseHTML picks them up
    // Also replace <!-- fig-block:fig-xxx --> with div elements for FigureBlockNode
    let textForMarked = seg.text
      .replace(/\[\^(ref-[^\]]+)\]/g, '<span data-ref-id="$1"></span>')
      .replace(/!\[([^\]]*)\]\([^)]*"([^"]+)"\)/g, (_, alt, id) => `<span data-alt-text="${alt}" data-fig-id="${id}"></span>`)
      .replace(/<!-- fig-block:(fig-[a-z0-9]+) -->/g, (_, id) => `<div data-fig-block-id="${id}"></div>`);

    let segHtml = marked.parse(textForMarked);
    // 最初の見出しにdata-*属性を付与
    if (seg.sectionId) {
      const escSummary = (seg.summary || '').replace(/"/g, '&quot;');
      const escParentId = seg.parentId || '';
      segHtml = segHtml.replace(
        /(<h[1-6])(\s|>)/,
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
    } else if (child.type.name === 'referenceNode') {
      text += `[^${child.attrs.refId}]`;
    } else if (child.type.name === 'figureNode') {
      text += `![${child.attrs.altText}]("${child.attrs.figId}")`;
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
      case 'figureBlockNode': {
        lines.push(`<!-- fig-block:${node.attrs.figId} -->`);
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
  tr.setMeta('addToHistory', false);
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

function _getSectionBlockPos(sectionId) {
  if (!editor) return null;
  let targetFrom = null;
  let targetTo = null;
  let targetLevel = null;
  let found = false;

  editor.state.doc.forEach((node, pos) => {
    if (!found) {
      if (node.type.name === 'sectionHeading' && node.attrs.sectionId === sectionId) {
        targetFrom = pos;
        targetLevel = node.attrs.level;
        found = true;
      }
    } else {
      if (targetTo === null) {
        if (node.type.name === 'sectionHeading' && node.attrs.level <= targetLevel) {
          targetTo = pos;
        }
      }
    }
  });

  if (targetFrom === null) return null;
  if (targetTo === null) targetTo = editor.state.doc.content.size;
  return { from: targetFrom, to: targetTo, level: targetLevel };
}

/**
 * IDで見出しノードを探し、その見出しおよび後続の子セクションを含むブロック全体をTiptapから削除する
 * @param {string} sectionId
 */
function _deleteSectionBlock(sectionId) {
  const block = _getSectionBlockPos(sectionId);
  if (!block) return;

  _suppressUpdate = true;
  editor.chain().deleteRange({ from: block.from, to: block.to }).run();
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

/**
 * ブロックを別のブロックを基準に移動する（Drag & Drop用）
 */
function _moveSectionBlock(draggedId, targetId, position) {
  if (!editor) return;

  const draggedBlock = _getSectionBlockPos(draggedId);
  if (!draggedBlock) { console.warn('[moveSectionBlock] draggedBlock not found:', draggedId); return; }

  const targetBlock = _getSectionBlockPos(targetId);
  if (!targetBlock) { console.warn('[moveSectionBlock] targetBlock not found:', targetId); return; }

  // 挿入位置と新しい見出しレベルを計算
  let insertPos;
  let newLevel;
  if (position === 'before') {
    insertPos = targetBlock.from;
    newLevel = targetBlock.level;
  } else if (position === 'after') {
    insertPos = targetBlock.to;
    newLevel = targetBlock.level;
  } else if (position === 'child') {
    insertPos = targetBlock.to;
    newLevel = Math.min(6, targetBlock.level + 1);
  } else {
    return;
  }

  const levelDelta = newLevel - draggedBlock.level;

  const { state } = editor;
  const { tr } = state;

  // ドラッグブロックのノード配列を取得し、レベル変更を事前適用
  const draggedNodes = [];
  state.doc.nodesBetween(draggedBlock.from, draggedBlock.to, (node, pos, parent) => {
    if (parent && parent.type.name === 'doc') {
      if (levelDelta !== 0 && node.type.name === 'sectionHeading') {
        const newNodeLevel = Math.max(1, Math.min(6, node.attrs.level + levelDelta));
        draggedNodes.push(node.type.create({ ...node.attrs, level: newNodeLevel }, node.content, node.marks));
      } else {
        draggedNodes.push(node);
      }
    }
  });

  if (draggedNodes.length === 0) {
    console.warn('[moveSectionBlock] no nodes found in dragged block');
    return;
  }

  const draggedFragment = Fragment.fromArray(draggedNodes);

  // 削除してから挿入
  tr.delete(draggedBlock.from, draggedBlock.to);
  const mappedPos = tr.mapping.map(insertPos);
  tr.insert(mappedPos, draggedFragment);

  // Undo履歴に通常の操作として追加される
  editor.view.dispatch(tr);
}

// ─── 公開 API ────────────────────────────────────────────────

window.TiptapEditor = {
  _referencesEnabled: false,
  _sourcesData: [],
  _materialsData: [],
  _onTOCUpdate: null,

  setProjectData(enabled, sources, materials) {
    this._referencesEnabled = enabled;
    this._sourcesData = sources;
    this._materialsData = materials;
    if (editor && editor.view) {
      editor.view.dispatch(editor.state.tr.setMeta('projectDataUpdate', true));
    }
  },

  getCharacterCount() {
    return editor ? editor.storage.characterCount.characters() : 0;
  },

  /** _suppressUpdate フラグ（edit-tab.js から参照） */
  get _suppressUpdate() { return _suppressUpdate; },
  set _suppressUpdate(v) { _suppressUpdate = v; },

  /**
   * マーカー付きMarkdown文字列をTiptapにセットする
   * @param {string} markdownContent - <!-- soki-section:uuid --> マーカー付きMarkdown
   */
  setContentFromMarkdown(markdownContent, addToHistory = false) {
    if (!editor) return;
    _suppressUpdate = true;
    const html = _markdownWithMarkersToHtml(markdownContent);
    
    if (addToHistory) {
      editor.chain()
        .selectAll()
        .insertContent(html)
        .run();
    } else {
      editor.commands.setContent(html, false);
    }
    
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
   * IDで見出しノードを探し、その見出しおよび後続の子セクションを含むブロック全体をTiptapから削除する
   * @param {string} sectionId
   */
  deleteSectionBlock(sectionId) {
    _deleteSectionBlock(sectionId);
  },

  /**
   * ブロックを別のブロックを基準に移動する（Drag & Drop用）
   * @param {string} draggedId
   * @param {string} targetId
   * @param {'before'|'after'|'child'} position
   */
  moveSectionBlock(draggedId, targetId, position) {
    _moveSectionBlock(draggedId, targetId, position);
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

// markedをグローバルに公開（material-tab.js等の非モジュールスクリプトから参照するため）
window.marked = marked;

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
