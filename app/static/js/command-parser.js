/**
 * CommandParser — スラッシュコマンド解析・レジストリ・@参照抽出
 */

const CommandParser = (() => {
  // タブごとのコマンドレジストリ
  const COMMANDS = {
    edit: {
      structure: {
        description: '骨子を生成・修正・追加',
        knownArgs: ['section', 'replace'],
        requiresLLM: true,
        dangerous: (args) => args.includes('replace'),
      },
      draft: {
        description: '現在のセクションを概要から本文生成',
        knownArgs: [],
        requiresLLM: true,
      },
      rewrite: {
        description: '現在のセクションを書き直し',
        knownArgs: [],
        requiresLLM: true,
      },
      expand: {
        description: '現在のセクションを指定文字数分加筆',
        knownArgs: [],
        requiresLLM: true,
        parseArgs: (parts) => {
          const charCount = parts.length > 0 && /^\d+$/.test(parts[0]) ? parts.shift() : '500';
          return { charCount, rest: parts };
        },
      },
      shorten: {
        description: '現在のセクションを指定文字数に圧縮',
        knownArgs: [],
        requiresLLM: true,
        parseArgs: (parts) => {
          const charCount = parts.length > 0 && /^\d+$/.test(parts[0]) ? parts.shift() : '500';
          return { charCount, rest: parts };
        },
      },
      tone: {
        description: '文体を変換して書き直し',
        knownArgs: [],
        requiresLLM: true,
        parseArgs: (parts) => {
          const style = parts.length > 0 ? parts.shift() : 'フォーマル';
          return { style, rest: parts };
        },
      },
      clear: {
        description: '新しいスコープを作成して会話をリセット',
        knownArgs: [],
        requiresLLM: false,
      },
    },
    review: {
      review: {
        description: 'レビューを実行',
        knownArgs: ['structure', 'rule', 'source'],
        requiresLLM: true,
      },
      prompt: {
        description: 'プロンプトの保存・読み込み',
        knownArgs: ['save', 'load'],
        requiresLLM: false,
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

    // 引数解析
    let commandArgs = [];
    let freeText = '';

    if (def.parseArgs) {
      // カスタム引数パーサー
      const parsed = def.parseArgs([...remainingParts]);
      commandArgs = Object.entries(parsed)
        .filter(([k]) => k !== 'rest')
        .map(([, v]) => v);
      freeText = parsed.rest ? parsed.rest.join(' ') : '';
    } else {
      // 既知の引数を抽出、残りはフリーテキスト
      const freeTextParts = [];
      for (const part of remainingParts) {
        if (def.knownArgs.includes(part)) {
          commandArgs.push(part);
        } else {
          freeTextParts.push(part);
        }
      }
      freeText = freeTextParts.join(' ');
    }

    return {
      command: {
        name: cmdName,
        args: commandArgs,
        def,
        isDangerous: def.dangerous ? def.dangerous(commandArgs) : false,
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
