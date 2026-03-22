/**
 * CommandParser — スラッシュコマンド解析・レジストリ・@参照抽出
 *
 * コマンドは引数を取らず、ユーザー指示はフリーテキストとして処理されます。
 */

export const CommandParser = (() => {
  // タブごとのコマンドレジストリ
  const COMMANDS = {
    edit: {
      // 構造生成コマンド（引数なし、ユーザー指示で文字数等を指定）
      'structure-replace': {
        description: '既存のセクション構造を破棄して新しく骨子を生成',
        requiresLLM: true,
        dangerous: true,
      },
      'structure-section': {
        description: '現在のセクション配下のみ骨子を生成・修正',
        requiresLLM: true,
        dangerous: false,
      },
      'structure-add': {
        description: '既存のセクション構造を維持して骨子を追加',
        requiresLLM: true,
        dangerous: false,
      },
      // 執筆コマンド（引数なし、ユーザー指示で文字数等を指定）
      draft: {
        description: '現在のセクションを概要から本文生成',
        requiresLLM: true,
      },
      'draft-all': {
        description: '現在のセクションと子セクション（または全セクション）の本文を一括生成',
        requiresLLM: true,
      },
      rewrite: {
        description: '現在のセクションを書き直し',
        requiresLLM: true,
      },
      'rewrite-all': {
        description: '現在のセクションと子セクション（または全セクション）の本文を一括で書き直し',
        requiresLLM: true,
      },
      expand: {
        description: '現在のセクションを加筆（文字数はユーザー指示で指定）',
        requiresLLM: true,
      },
      shorten: {
        description: '現在のセクションを圧縮（文字数はユーザー指示で指定）',
        requiresLLM: true,
      },
      tone: {
        description: '文体を変換して書き直し（文体はユーザー指示で指定）',
        requiresLLM: true,
      },
      cite: {
        description: '現在のセクション本文に引用タグ [^ref-xxx] を自動挿入',
        requiresLLM: true,
      },
      clear: {
        description: '新しいスコープを作成して会話をリセット',
        requiresLLM: false,
      },
      'review-structure': {
        description: '文書構造にフォーカスしてレビュー',
        requiresLLM: true,
      },
      'review-rule': {
        description: '執筆ルールの適用にフォーカスしてレビュー',
        requiresLLM: true,
      },
      'review-source': {
        description: 'ソース/参考文献の活用にフォーカスしてレビュー',
        requiresLLM: true,
      },
      review: {
        description: 'レビューを実行（フォーカスなし）',
        requiresLLM: true,
      },
    },
  };

  // @参照のパターン
  const REF_PATTERN = /@(source|material):([a-z]+-[a-f0-9]+)/g;

  /**
   * 入力テキストを解析して構造化した結果を返す
   * @param {string} input — textarea のテキスト
   * @param {string} tab — 現在のタブ ('edit' | 'review')
   * @returns {{ command: object|null, refs: array, freeText: string, error: string|null }}
   */
  function parse(input, tab) {
    const trimmed = input.trim();
    if (!trimmed) {
      return { command: null, refs: [], freeText: '', error: null };
    }

    // @参照を抽出
    const refs = _extractRefs(trimmed);

    // @参照を除去したテキスト
    const textWithoutRefs = trimmed.replace(REF_PATTERN, '').replace(/\s+/g, ' ').trim();

    // コマンドでなければフリーテキスト
    if (!textWithoutRefs.startsWith('/')) {
      return { command: null, refs, freeText: textWithoutRefs, error: null };
    }

    // コマンド解析
    const parts = textWithoutRefs.split(/\s+/);
    const cmdName = parts[0].slice(1); // '/' を除去
    const remainingParts = parts.slice(1);

    const tabCommands = COMMANDS[tab] || {};
    const def = tabCommands[cmdName];

    if (!def) {
      return {
        command: null,
        refs,
        freeText: textWithoutRefs,
        error: `不明なコマンド: /${cmdName}`,
      };
    }

    // 引数はすべてフリーテキストとして扱う（引数廃止）
    // ただし、/prompt コマンドは特殊（save/loadを引数として受け取る）
    let commandArgs = [];
    let freeText = '';

    if (def.knownArgs) {
      // /prompt save や /prompt load などの特殊コマンド
      const action = remainingParts[0];
      if (def.knownArgs.includes(action)) {
        commandArgs = [action];
        freeText = remainingParts.slice(1).join(' ');
      } else {
        // 引数がない場合もフリーテキストとする
        freeText = remainingParts.join(' ');
      }
    } else {
      // その他のコマンドはすべてフリーテキスト
      freeText = remainingParts.join(' ');
    }

    return {
      command: {
        name: cmdName,
        args: commandArgs,
        def,
        isDangerous: def.dangerous || false,
        requiresLLM: def.requiresLLM,
      },
      refs,
      freeText,
      error: null,
    };
  }

  /**
   * @参照を抽出する
   * @param {string} text
   * @returns {Array<{type: string, id: string}>}
   */
  function _extractRefs(text) {
    const refs = [];
    let m;
    const pattern = new RegExp(REF_PATTERN.source, REF_PATTERN.flags);
    while ((m = pattern.exec(text)) !== null) {
      refs.push({ type: m[1], id: m[2] });
    }
    return refs;
  }

  /**
   * 指定タブで利用可能なコマンド一覧を返す（ヒント表示用）
   * @param {string} tab
   * @returns {Array<{name: string, description: string}>}
   */
  function getAvailableCommands(tab) {
    const tabCommands = COMMANDS[tab] || {};
    return Object.entries(tabCommands).map(([name, def]) => ({
      name: '/' + name,
      description: def.description,
      knownArgs: def.knownArgs || [],
    }));
  }

  return { parse, getAvailableCommands, COMMANDS };
})();
