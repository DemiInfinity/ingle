// Ingle for VS Code — chat webview. Plain ES2020, no frameworks, no network.
// Talks to the extension only through the messages in src/shared/protocol.ts.
(function () {
  'use strict';

  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const post = (msg) => vscode.postMessage(msg);

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------

  const saved = safe(() => vscode.getState(), null) || {};

  const S = {
    assistants: [],
    currentAssistant: '',
    effort: 'medium',
    effortHelp: {},
    web: false,
    useContext: true,
    chats: [],
    chatId: '',
    messages: [],
    context: undefined,
    engine: { state: 'ready', text: '' },
    streaming: false,
    activity: null,
    approval: null,
    historyOpen: false,
    menuOpen: false,
    startingEngine: false,
    vision: true,
    contextUsage: null,
    /** Files waiting in the composer: protocol Attachment plus a local preview URL. */
    attachments: [],
    slashItems: [],
    mcpServers: null,   // non-null while the /mcp dialog is open
    secretPrompt: null, // non-null while "This looks like a secret" is asked
    tasks: [],          // the chat's task list (update_tasks), pinned under the latest reply
    workMode: 'ask',    // ask | edit | auto | plan | debug (Mode pill, ⇧Tab cycles); plan ends with a plan to Approve
    modes: [],          // [{ id, label, role, help }] from the engine
    queued: [],         // messages typed during the run, waiting for the model's next step
    draft: typeof saved.draft === 'string' ? saved.draft : '',
  };

  /** id → { root, role, ... } for every rendered message. */
  const entries = new Map();
  const openTools = new Set();
  const openThinking = new Set();
  const openSummaries = new Set();
  /** The changes panel under a run's last reply: which are open, refusals waiting for "Undo anyway"
   *  (id → { message, canForce }), each run's files and diffs from the engine, open file diffs ("id|index") and the
   *  Commit flow (id → { phase: 'drafting' | 'editing' | 'committing', message, error }). */
  const openUndo = new Set();
  const undoNotes = new Map();
  const changesData = new Map();
  const openDiffs = new Set();
  const commits = new Map();
  /** Message ids waiting for a throttled re-render while streaming. */
  const dirty = new Set();
  let flushTimer = 0;
  const THROTTLE_MS = 60;

  function safe(fn, fallback) {
    try { return fn(); } catch { return fallback; }
  }

  function saveState() {
    safe(() => vscode.setState({ draft: S.draft, chatId: S.chatId }));
  }

  function currentAssistant() {
    return S.assistants.find((a) => a.id === S.currentAssistant) || S.assistants[0] || null;
  }

  // ---------------------------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------------------------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }

  /** Element whose innerHTML is built only from esc()-ed text by the renderers below. */
  function htmlEl(tag, cls, html) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.innerHTML = html;
    return el;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  // ---------------------------------------------------------------------------------------------
  // Icons (inline SVG, 16×16 grid, stroked in currentColor)
  // ---------------------------------------------------------------------------------------------

  const ICONS = {
    terminal: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2"/><path d="M4.6 6.2l2 1.8-2 1.8M8.4 10.2h3"/>',
    file: '<path d="M4 1.9h4.9l3.1 3.1v9.1H4z"/><path d="M8.9 1.9V5H12"/>',
    folder: '<path d="M1.9 4.1a1 1 0 0 1 1-1h3.1l1.5 1.6h5.6a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H2.9a1 1 0 0 1-1-1z"/>',
    globe: '<circle cx="8" cy="8" r="6.1"/><path d="M1.9 8h12.2M8 1.9c1.7 1.8 2.5 3.9 2.5 6.1S9.7 12.3 8 14.1C6.3 12.3 5.5 10.2 5.5 8S6.3 3.7 8 1.9z"/>',
    search: '<circle cx="7" cy="7" r="4.4"/><path d="M10.2 10.2l3.7 3.7"/>',
    edit: '<path d="M10.7 2.5l2.8 2.8-7.8 7.8-3.4.6.6-3.4z"/><path d="M9.2 4l2.8 2.8"/>',
    book: '<path d="M2.4 3.1c2-.8 3.9-.6 5.6.7v9.9c-1.7-1.2-3.6-1.4-5.6-.6z"/><path d="M13.6 3.1c-2-.8-3.9-.6-5.6.7v9.9c1.7-1.2 3.6-1.4 5.6-.6z"/>',
    person: '<circle cx="8" cy="5.3" r="2.6"/><path d="M3 13.8c.6-2.6 2.6-4 5-4s4.4 1.4 5 4"/>',
    link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2A2.6 2.6 0 0 0 9 3.3l-.9.9"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9A2.6 2.6 0 0 0 7 12.7l.9-.9"/>',
    sparkle: '<path d="M7 1.9l1.3 3.5 3.5 1.3-3.5 1.3L7 11.5 5.7 8 2.2 6.7l3.5-1.3z"/><path d="M12.4 10.4l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z"/>',
    warning: '<path d="M8 2.2l6.2 10.9H1.8z"/><path d="M8 6.4v3M8 11.5v.1"/>',
    key: '<circle cx="5" cy="10.5" r="2.8"/><path d="M7 8.5l6-6M11 4.5l1.6 1.6M9.4 6.1l1.4 1.4"/>',
    wrench: '<path d="M10.4 2a3.3 3.3 0 0 0-3 4.5l-5.1 5a1.3 1.3 0 0 0 1.9 1.9l5-5.1A3.3 3.3 0 0 0 13.8 5l-2 2-1.9-.5-.5-1.9 2-2a3.3 3.3 0 0 0-1-.6z"/>',
    copy: '<rect x="5.3" y="5.3" width="8.2" height="8.2" rx="1.5"/><path d="M10.7 5.3V3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.6a1.3 1.3 0 0 0 1.3 1.3h1.5"/>',
    check: '<path d="M3 8.4l3.2 3.1L13 4.7"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M11.8 1.7v2.9H8.9"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    compose: '<path d="M13.4 8.6v3.9a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1h3.9"/><path d="M11.6 2.1l2.3 2.3-5.6 5.6-2.9.6.6-2.9z"/>',
    history: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.3 1.5"/>',
    trash: '<path d="M2.8 4.3h10.4M6.3 4.3V2.8h3.4v1.5M4.2 4.3l.6 9h6.4l.6-9"/>',
    close: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    chevron: '<path d="M6 3.6L10.4 8 6 12.4"/>',
    updown: '<path d="M5.2 6.2L8 3.4l2.8 2.8M5.2 9.8L8 12.6l2.8-2.8"/>',
    send: '<path d="M8 13V3.6M3.9 7.5L8 3.4l4.1 4.1"/>',
    stop: '<rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.4" fill="currentColor" stroke="none"/>',
    think: '<path d="M5.9 11.1c0-1.3-1.9-2.2-1.9-4.6a4 4 0 0 1 8 0c0 2.4-1.9 3.3-1.9 4.6z"/><path d="M6.3 13.5h3.4"/>',
    bolt: '<path d="M9 1.8L3.6 9h4l-1 5.2L12.4 7h-4z"/>',
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6L5 5M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4"/>',
    undo: '<path d="M5.2 3.4L2.4 6.2 5.2 9"/><path d="M2.6 6.2h6.6a3.9 3.9 0 0 1 0 7.8H6.4"/>',
    diff: '<rect x="1.9" y="2.5" width="5.2" height="11" rx="1"/><rect x="8.9" y="2.5" width="5.2" height="11" rx="1"/><path d="M3.4 6h2.2M10.4 10h2.2M11.5 8.9v2.2"/>',
    insert: '<path d="M8 2.4v7.2M5 6.7l3 3 3-3M3 13.4h10"/>',
    apply: '<path d="M2.8 5.4h9l-2.3-2.3M13.2 10.6h-9l2.3 2.3"/>',
    code: '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>',
    plug: '<path d="M5.6 1.9v2.9M10.4 1.9v2.9M3.8 4.8h8.4v2.5a4.2 4.2 0 0 1-8.4 0zM8 11.5v2.6"/>',
    eye: '<path d="M1.6 8S4 3.6 8 3.6s6.4 4.4 6.4 4.4S12 12.4 8 12.4 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.9"/>',
    database: '<ellipse cx="8" cy="3.9" rx="5" ry="1.8"/><path d="M3 3.9v8.2c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.9M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8"/>',
    list: '<path d="M5.6 4h7.9M5.6 8h7.9M5.6 12h7.9M2.5 4h.1M2.5 8h.1M2.5 12h.1"/>',
    memory: '<path d="M8 2.2a5.8 5.8 0 1 0 5.8 5.8"/><path d="M8 5v3l2 1.3M11 2.6l.4 1.6 1.6.4-1.6.4-.4 1.6-.4-1.6L9 4.6l1.6-.4z"/>',
    clip: '<path d="M13.2 7.6l-5.3 5.3a3.4 3.4 0 0 1-4.8-4.8l5.6-5.6a2.3 2.3 0 0 1 3.2 3.2l-5.5 5.5a1.1 1.1 0 0 1-1.6-1.6l5-5"/>',
    image: '<rect x="1.9" y="2.6" width="12.2" height="10.8" rx="1.8"/><circle cx="5.6" cy="6.1" r="1.2"/><path d="M2.2 11.6l3.4-3.2 2.6 2.4 2-1.8 3.7 3.4"/>',
    doc: '<path d="M4 1.9h4.9l3.1 3.1v9.1H4z"/><path d="M8.9 1.9V5H12M5.9 8.2h4.2M5.9 10.4h4.2"/>',
    compact: '<path d="M3 3.5h10M3 12.5h10M8 5.4v5.2M5.9 7.4L8 5.3l2.1 2.1M5.9 8.6L8 10.7l2.1-2.1"/>',
    helper: '<circle cx="5.3" cy="6" r="2.1"/><circle cx="11" cy="6.6" r="1.7"/><path d="M1.6 13.2c.4-2.2 1.9-3.4 3.7-3.4s3.3 1.2 3.7 3.4M9.6 10.1c.4-.2.9-.3 1.4-.3 1.6 0 2.8 1 3.2 3"/>',
  };

  const ICON_ALIASES = {
    console: 'terminal', 'debug-console': 'terminal', run: 'terminal', play: 'terminal', command: 'terminal', remote: 'terminal', ssh: 'terminal',
    'file-code': 'file', 'new-file': 'file', files: 'file', 'file-text': 'file', 'go-to-file': 'file', save: 'file', write: 'file', read: 'file',
    'folder-opened': 'folder', 'folder-library': 'folder', 'root-folder': 'folder',
    web: 'globe', 'cloud-download': 'globe', 'globe-search': 'globe',
    find: 'search', 'search-fuzzy': 'search', 'list-filter': 'search',
    pencil: 'edit', 'edit-file': 'edit', replace: 'edit',
    library: 'book', notebook: 'book', rule: 'book', report: 'book', law: 'book', note: 'book',
    account: 'person', organization: 'person', agent: 'helper', delegate: 'helper', robot: 'helper', hubot: 'helper', people: 'helper',
    'link-external': 'link', open: 'link', url: 'link',
    sparkles: 'sparkle', skill: 'sparkle', wand: 'sparkle', lightbulb: 'think', brain: 'think',
    error: 'warning', alert: 'warning', bug: 'warning', problem: 'warning', problems: 'warning',
    tools: 'wrench', tool: 'wrench', settings: 'gear', 'settings-gear': 'gear',
    extensions: 'plug', mcp: 'plug', server: 'database', 'server-process': 'database',
    preview: 'eye', 'list-tree': 'list', 'list-flat': 'list', checklist: 'list', 'symbol-method': 'code', 'file-symlink-file': 'file',
    archive: 'memory', 'bookmark': 'memory',
  };

  const iconCache = new Map();
  function icon(name, cls) {
    const key = ICONS[name] ? name : ICON_ALIASES[name] || 'wrench';
    let tpl = iconCache.get(key);
    if (!tpl) {
      tpl = document.createElement('template');
      const thick = key === 'send' ? '1.8' : '1.3';
      tpl.innerHTML = `<svg class="ic" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="${thick}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[key]}</svg>`;
      iconCache.set(key, tpl);
    }
    const svg = tpl.content.firstChild.cloneNode(true);
    if (cls) svg.classList.add(...cls.split(' '));
    return svg;
  }

  /** Ingle's three-node network mark; the top node is lit in ember. */
  function mark(cls, sides) {
    const tpl = document.createElement('template');
    tpl.innerHTML =
      '<svg class="mark" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true" focusable="false">' +
      '<path d="M6.9 5.5L4.7 9.9M9.1 5.5l2.2 4.4M5.6 11.6h4.8"/>' +
      '<circle class="lit" cx="8" cy="3.8" r="2"/>' +
      `<circle class="${sides ? 'lit' : ''}" cx="3.6" cy="11.6" r="2"/>` +
      `<circle class="${sides ? 'lit' : ''}" cx="12.4" cy="11.6" r="2"/>` +
      '</svg>';
    const svg = tpl.content.firstChild;
    if (cls) svg.classList.add(cls);
    return svg;
  }

  function spinner() {
    return h('span', { class: 'spinner', 'aria-hidden': 'true' });
  }

  // ---------------------------------------------------------------------------------------------
  // Syntax colouring — port of Sources/Ingle/CodeHighlight.swift
  // ---------------------------------------------------------------------------------------------

  const KEYWORDS = new Set([
    'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
    'defer', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'extension', 'false', 'final', 'finally',
    'for', 'func', 'function', 'go', 'guard', 'if', 'impl', 'implements', 'import', 'in', 'init', 'interface',
    'internal', 'is', 'let', 'match', 'mod', 'mut', 'namespace', 'new', 'nil', 'null', 'nullptr', 'of',
    'override', 'package', 'private', 'protected', 'protocol', 'pub', 'public', 'readonly', 'return', 'self',
    'Self', 'sealed', 'static', 'struct', 'super', 'switch', 'this', 'throw', 'throws', 'trait', 'true', 'try',
    'type', 'typeof', 'undefined', 'use', 'using', 'var', 'void', 'where', 'while', 'yield', 'fn', 'loop',
    'some', 'any', 'inout', 'lazy', 'weak', 'unowned', 'mutating', 'fileprivate', 'open', 'repeat',
    'virtual', 'volatile', 'get', 'set', 'value', 'record', 'required', 'with', 'from', 'select',
    'and', 'def', 'del', 'elif', 'except', 'global', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
    'None', 'True', 'False', 'print',
    'then', 'fi', 'done', 'esac', 'local', 'echo', 'source',
  ]);
  const SQL_KEYWORDS = new Set([
    'select', 'from', 'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'on', 'group', 'by',
    'order', 'having', 'limit', 'offset', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create',
    'table', 'index', 'view', 'drop', 'alter', 'add', 'column', 'primary', 'key', 'foreign', 'references',
    'not', 'null', 'and', 'or', 'as', 'distinct', 'count', 'sum', 'avg', 'min', 'max', 'case', 'when',
    'then', 'else', 'end', 'in', 'is', 'like', 'between', 'exists', 'union', 'all', 'with', 'desc', 'asc',
    'default', 'unique', 'constraint', 'returning', 'begin', 'commit', 'rollback', 'transaction',
  ]);
  const HASH_COMMENTS = new Set(['python', 'py', 'bash', 'sh', 'zsh', 'shell', 'yaml', 'yml', 'ruby', 'rb', 'toml',
    'dockerfile', 'makefile', 'r', 'perl', 'conf', 'ini', 'console', 'shellscript', 'powershell', 'ps1']);
  const DASH_COMMENTS = new Set(['sql', 'lua', 'haskell', 'hs', 'postgres', 'postgresql', 'mysql', 'sqlite']);
  const MARKUP = new Set(['html', 'xml', 'svg', 'jsx', 'tsx', 'vue', 'svelte', 'xaml', 'plist']);

  const RE = {
    blockComment: /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g,
    lineComment: /\/\/[^\n]*/g,
    hashComment: /(^|\s)#[^\n]*/gm,
    dashComment: /--[^\n]*/g,
    strings: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
    numbers: /\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g,
    words: /\b[A-Za-z_][A-Za-z0-9_]*\b/g,
    tags: /<\/?[A-Za-z][\w:.-]*|\/?>/g,
    attributes: /\b[A-Za-z_:][\w:.-]*(?==)/g,
    cssProps: /^\s*([a-z-]+)(?=\s*:)/gm,
  };

  // 0 = plain. Order matches CodeHighlight.Palette.
  const TOKEN_CLASS = ['', 'tk-com', 'tk-str', 'tk-tag', 'tk-attr', 'tk-num', 'tk-kw', 'tk-fn', 'tk-ty'];
  const T = { com: 1, str: 2, tag: 3, attr: 4, num: 5, kw: 6, fn: 7, ty: 8 };

  function highlight(code, language) {
    const lang = String(language || '').toLowerCase().trim();
    if (!code) return '';
    if (lang === 'diff' || lang === 'patch') return highlightDiff(code);
    if (code.length >= 60000) return esc(code);

    const n = code.length;
    const taken = new Uint8Array(n);
    const free = (s, e) => {
      for (let i = s; i < e; i++) if (taken[i]) return false;
      return true;
    };
    const paint = (s, len, cls) => {
      if (len <= 0 || s + len > n || !free(s, s + len)) return;
      taken.fill(cls, s, s + len);
    };
    const each = (re, fn) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        fn(m);
      }
    };

    // 1. Comments and strings win over everything inside them.
    each(RE.blockComment, (m) => paint(m.index, m[0].length, T.com));
    if (HASH_COMMENTS.has(lang)) each(RE.hashComment, (m) => paint(m.index, m[0].length, T.com));
    else if (DASH_COMMENTS.has(lang)) each(RE.dashComment, (m) => paint(m.index, m[0].length, T.com));
    else if (lang !== 'css' && lang !== 'html') each(RE.lineComment, (m) => paint(m.index, m[0].length, T.com));
    each(RE.strings, (m) => paint(m.index, m[0].length, T.str));

    // 2. Markup tags and attributes.
    if (MARKUP.has(lang)) {
      each(RE.tags, (m) => paint(m.index, m[0].length, T.tag));
      each(RE.attributes, (m) => paint(m.index, m[0].length, T.attr));
    }
    if (lang === 'css' || lang === 'scss') {
      each(RE.cssProps, (m) => paint(m.index + m[0].length - m[1].length, m[1].length, T.attr));
    }

    // 3. Numbers.
    each(RE.numbers, (m) => paint(m.index, m[0].length, T.num));

    // 4. Words: keywords, function calls, types.
    const isSQL = DASH_COMMENTS.has(lang);
    each(RE.words, (m) => {
      const word = m[0];
      const s = m.index;
      if (isSQL) {
        if (SQL_KEYWORDS.has(word.toLowerCase())) paint(s, word.length, T.kw);
        return;
      }
      if (KEYWORDS.has(word)) { paint(s, word.length, T.kw); return; }
      let next = s + word.length;
      while (next < n && code.charCodeAt(next) === 32) next++;
      if (next < n && code.charCodeAt(next) === 40) { paint(s, word.length, T.fn); return; }
      const c = word.charCodeAt(0);
      if (c >= 65 && c <= 90 && word.length > 1) paint(s, word.length, T.ty);
    });

    let out = '';
    let i = 0;
    while (i < n) {
      const cls = taken[i];
      let j = i + 1;
      while (j < n && taken[j] === cls) j++;
      const text = esc(code.slice(i, j));
      out += cls ? `<span class="${TOKEN_CLASS[cls]}">${text}</span>` : text;
      i = j;
    }
    return out;
  }

  function highlightDiff(code) {
    return code.split('\n').map((line) => {
      let cls = '';
      if (/^(\+\+\+|---|diff |index )/.test(line)) cls = 'tk-meta';
      else if (line.startsWith('+')) cls = 'tk-add';
      else if (line.startsWith('-')) cls = 'tk-del';
      else if (line.startsWith('@@')) cls = 'tk-hunk';
      return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
    }).join('\n');
  }

  // ---------------------------------------------------------------------------------------------
  // Markdown — small and safe: everything is escaped before any markup is added.
  // ---------------------------------------------------------------------------------------------

  const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
  const LIST_RE = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
  const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const QUOTE_RE = /^ {0,3}>/;

  function isFence(line) {
    const m = FENCE_RE.exec(line);
    return !!m && !(m[2][0] === '`' && m[3].includes('`'));
  }
  function isTableSep(line) {
    const t = line.trim();
    return t.includes('|') && t.includes('-') && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
  }
  function isBlockStart(line) {
    return isFence(line) || HR_RE.test(line) || HEADING_RE.test(line) || QUOTE_RE.test(line);
  }

  function parseBlocks(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    const flush = () => {
      if (para.length) {
        out.push({ t: 'p', lines: para, key: 'p\n' + para.join('\n') });
        para = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;

      if (isFence(line)) {
        flush();
        m = FENCE_RE.exec(line);
        const indent = m[1].length;
        const fence = m[2];
        const lang = (m[3].trim().split(/\s+/)[0] || '').replace(/^\{?\.?/, '').replace(/\}$/, '');
        const strip = indent ? new RegExp('^ {0,' + indent + '}') : null;
        const body = [];
        let closed = false;
        for (i++; i < lines.length; i++) {
          const c = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]);
          if (c && c[1][0] === fence[0] && c[1].length >= fence.length) { closed = true; break; }
          body.push(strip ? lines[i].replace(strip, '') : lines[i]);
        }
        const code = body.join('\n');
        out.push({ t: 'code', lang, code, open: !closed, key: `c${closed ? 1 : 0}${lang}\n${code}` });
        continue;
      }

      if (!line.trim()) { flush(); continue; }

      if (para.length && /^ {0,3}=+\s*$/.test(line)) {
        const textLines = para; para = [];
        out.push({ t: 'h', level: 1, text: textLines.join(' '), key: 'h1' + textLines.join('\n') });
        continue;
      }

      if (HR_RE.test(line)) { flush(); out.push({ t: 'hr', key: 'hr' }); continue; }

      if ((m = HEADING_RE.exec(line))) {
        flush();
        out.push({ t: 'h', level: m[1].length, text: m[2], key: 'h' + line });
        continue;
      }

      if (QUOTE_RE.test(line)) {
        flush();
        const q = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          q.push(lines[i].replace(/^ {0,3}> ?/, ''));
          i++;
        }
        i--;
        out.push({ t: 'quote', text: q.join('\n'), key: 'q\n' + q.join('\n') });
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const rows = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(lines[i]); i++; }
        i--;
        out.push({ t: 'table', rows, key: 't\n' + rows.join('\n') });
        continue;
      }

      if (LIST_RE.test(line)) {
        flush();
        const items = [];
        const raw = [];
        while (i < lines.length) {
          const l = lines[i];
          const lm = LIST_RE.exec(l);
          if (lm && !HR_RE.test(l)) {
            items.push({
              indent: lm[1].replace(/\t/g, '    ').length,
              ordered: /\d/.test(lm[2]),
              start: parseInt(lm[2], 10) || 1,
              text: [lm[3]],
            });
            raw.push(l);
            i++;
            continue;
          }
          if (!l.trim()) {
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && LIST_RE.test(lines[j]) && !HR_RE.test(lines[j])) { i = j; continue; }
            break;
          }
          if (isBlockStart(l) || (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) break;
          items[items.length - 1].text.push(l.trim());
          raw.push(l);
          i++;
        }
        i--;
        out.push({ t: 'list', items, key: 'l\n' + raw.join('\n') });
        continue;
      }

      para.push(line);
    }
    flush();
    return out;
  }

  function emphasis(s) {
    return s
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>');
  }

  /** Inline Markdown → HTML. Input is raw text; output contains only our own tags. */
  /** `path/to/file.ext`, `./x`, `~/x` or `/abs/x.ext` in a code span (not commands or plain words). */
  const FILE_PATH = /^(?:~\/|\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+ -]+)*\.[A-Za-z][A-Za-z0-9]{0,7}$/;

  function inline(src) {
    const slots = [];
    const put = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    let s = esc(String(src).replace(/\u0000/g, ''));

    // Code spans first: nothing inside them is formatted.
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => {
      const inner = /^ .* $/.test(code) ? code.slice(1, -1) : code;
      // A file path (has a folder or an extension) opens in the previewer.
      if (FILE_PATH.test(inner)) return put(`<code class="file-link" data-act="file-link" data-path="${inner}" title="Open Preview" role="button" tabindex="0">${inner}</code>`);
      return put(`<code>${inner}</code>`);
    });

    // [text](url) and ![alt](url): only http(s) becomes a link (VS Code opens it externally).
    s = s.replace(/!?\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+&quot;([^\n]*?)&quot;)?\s*\)/g, (_, text, url, title) => {
      if (!/^https?:\/\//i.test(url)) {
        // A link to a local file opens in the previewer.
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url) || /^file:/i.test(url)) {
          return put(`<a href="#" class="file-link" data-act="file-link" data-path="${url}" title="Open Preview">${emphasis(text)}</a>`);
        }
        return text;
      }
      return put(`<a href="${url}" title="${title || url}">${emphasis(text)}</a>`);
    });

    // Bare URLs.
    s = s.replace(/https?:\/\/[^\s<>&]+(?:&amp;[^\s<>&]+)*/g, (url) => {
      const trail = /[.,:;!?)\]]+$/.exec(url);
      const clean = trail ? url.slice(0, -trail[0].length) : url;
      return put(`<a href="${clean}" title="${clean}">${clean}</a>`) + (trail ? trail[0] : '');
    });

    s = emphasis(s);
    for (let guard = 0; guard < 4 && s.includes('\u0000'); guard++) {
      s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)] || '');
    }
    return s;
  }

  function splitRow(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  }

  function tableHTML(rows) {
    const head = splitRow(rows[0]);
    const aligns = splitRow(rows[1]).map((c) => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return l && r ? 'al-c' : r ? 'al-r' : '';
    });
    const cell = (tag, text, i) => `<${tag}${aligns[i] ? ` class="${aligns[i]}"` : ''}>${inline(text)}</${tag}>`;
    let html = '<table><thead><tr>' + head.map((c, i) => cell('th', c, i)).join('') + '</tr></thead><tbody>';
    for (const r of rows.slice(2)) {
      const cells = splitRow(r);
      html += '<tr>' + head.map((_, i) => cell('td', cells[i] || '', i)).join('') + '</tr>';
    }
    return html + '</tbody></table>';
  }

  function listHTML(items) {
    let html = '';
    const stack = [];
    const open = (it) => {
      const tag = it.ordered ? 'ol' : 'ul';
      html += it.ordered && it.start !== 1 ? `<ol start="${it.start}">` : `<${tag}>`;
      stack.push({ indent: it.indent, tag });
    };
    for (const it of items) {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) {
        html += `</li></${stack.pop().tag}>`;
      }
      if (!stack.length || it.indent > stack[stack.length - 1].indent + 1) open(it);
      else html += '</li>';
      let text = it.text.join(' ');
      let task = '';
      const tm = /^\[([ xX])\]\s+/.exec(text);
      if (tm) {
        task = `<span class="task${tm[1] === ' ' ? '' : ' done'}" aria-hidden="true"></span>`;
        text = text.slice(tm[0].length);
      }
      html += `<li${task ? ' class="task-item"' : ''}>${task}${inline(text)}`;
    }
    while (stack.length) html += `</li></${stack.pop().tag}>`;
    return html;
  }

  function blockEl(b) {
    switch (b.t) {
      case 'p': return htmlEl('p', 'md-p', inline(b.lines.join('\n')).replace(/\n/g, '<br>'));
      case 'h': return htmlEl('h' + b.level, 'md-h md-h' + b.level, inline(b.text));
      case 'hr': return h('hr', { class: 'md-hr' });
      case 'quote': {
        const q = h('blockquote', { class: 'md-quote' });
        for (const inner of parseBlocks(b.text)) q.append(blockEl(inner));
        return q;
      }
      case 'table': {
        const wrap = htmlEl('div', 'md-table', tableHTML(b.rows));
        wrap.tabIndex = 0;
        wrap.setAttribute('role', 'region');
        wrap.setAttribute('aria-label', 'Table');
        return wrap;
      }
      case 'list': return htmlEl('div', 'md-list', listHTML(b.items));
      case 'code': return codeBlockEl(b.lang, b.code, b.open);
      default: return h('div');
    }
  }

  function langLabel(lang) {
    return lang || 'code';
  }

  function codeBlockEl(lang, code, open) {
    const codeEl = document.createElement('code');
    codeEl.innerHTML = highlight(code, lang);
    const pre = h('pre', { class: 'cb-pre', tabindex: '0', 'aria-label': `${langLabel(lang)} code` }, codeEl);
    const btn = (ic, label, act, aria) =>
      h('button', { class: 'cb-btn', type: 'button', 'data-act': act, title: aria, 'aria-label': aria },
        icon(ic), h('span', { class: 'cb-btn-label', text: label }));
    const wrap = h('div', { class: 'cb' + (open ? ' cb-open' : '') },
      h('div', { class: 'cb-head' },
        h('span', { class: 'cb-lang', text: langLabel(lang) }),
        h('span', { class: 'cb-actions' },
          btn('copy', 'Copy', 'copy-code', 'Copy code'),
          btn('insert', 'Insert', 'insert-code', 'Insert at cursor'),
          btn('apply', 'Apply', 'apply-code', 'Apply to file'))),
      pre);
    wrap._code = code;
    wrap._lang = lang;
    return wrap;
  }

  /** Re-render Markdown into container, replacing only blocks that changed since last time. */
  function renderMarkdown(container, entry, text) {
    const blocks = parseBlocks(text);
    const old = entry.blocks || [];
    let k = 0;
    while (k < old.length && k < blocks.length && old[k].key === blocks[k].key) k++;
    let keepScroll = 0;
    if (k < old.length && k < blocks.length && blocks[k].t === 'code') {
      const pre = old[k].el.querySelector && old[k].el.querySelector('.cb-pre');
      if (pre) keepScroll = pre.scrollLeft;
    }
    for (let j = k; j < old.length; j++) old[j].el.remove();
    const next = old.slice(0, k);
    for (let j = k; j < blocks.length; j++) {
      const el = blockEl(blocks[j]);
      container.append(el);
      next.push({ key: blocks[j].key, el });
      if (j === k && keepScroll) {
        const pre = el.querySelector('.cb-pre');
        if (pre) pre.scrollLeft = keepScroll;
      }
    }
    entry.blocks = next;
  }

  /** Some models put their reasoning inline as <think>…</think>; move it out of the reply. */
  function splitThinking(content, extra) {
    let thinking = extra || '';
    let body = content || '';
    const trimmed = body.replace(/^\s+/, '');
    if (trimmed.startsWith('<think>')) {
      const rest = trimmed.slice(7);
      const end = rest.indexOf('</think>');
      if (end >= 0) {
        thinking += rest.slice(0, end);
        body = rest.slice(end + 8);
      } else {
        thinking += rest;
        body = '';
      }
    }
    return { thinking: thinking.trim(), body: body.trim() };
  }

  // ---------------------------------------------------------------------------------------------
  // Clipboard
  // ---------------------------------------------------------------------------------------------

  function copyText(text, button) {
    const done = () => flashCopied(button);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => { post({ type: 'copy', text }); done(); });
        return;
      }
    } catch { /* fall through */ }
    post({ type: 'copy', text });
    done();
  }

  function flashCopied(button) {
    if (!button) return;
    const svg = button.querySelector('svg');
    const label = button.querySelector('.cb-btn-label');
    if (svg) svg.replaceWith(icon('check'));
    const oldLabel = label ? label.textContent : '';
    if (label) label.textContent = 'Copied';
    button.classList.add('copied');
    clearTimeout(button._t);
    button._t = setTimeout(() => {
      const s = button.querySelector('svg');
      if (s) s.replaceWith(icon('copy'));
      if (label) label.textContent = oldLabel;
      button.classList.remove('copied');
    }, 1500);
    announce('Copied');
  }

  // ---------------------------------------------------------------------------------------------
  // Skeleton
  // ---------------------------------------------------------------------------------------------

  const app = document.getElementById('app') || document.body.appendChild(h('div', { id: 'app', class: 'app' }));

  // Header
  const asstName = h('span', { class: 'asst-name' });
  const asstRole = h('span', { class: 'asst-role' });
  const asstBtn = h('button', {
    class: 'asst-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    title: 'Choose which assistant answers in this chat',
  }, mark('asst-mark'), asstName, asstRole, icon('updown', 'asst-chev'));
  const asstMenu = h('div', { class: 'menu', role: 'menu', 'aria-label': 'Assistants', hidden: true });
  const newBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'New chat', title: 'New chat' }, icon('compose'));
  const histBtn = h('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Chat history', title: 'Chat history', 'aria-expanded': 'false',
  }, icon('history'));
  // The chat's mode when it isn't Ask, so it's visible at a glance.
  const modeBadge = h('span', { class: 'mode-badge', hidden: true });
  const header = h('header', { class: 'top' },
    h('div', { class: 'picker' }, asstBtn, asstMenu), modeBadge,
    h('span', { class: 'grow' }),
    newBtn, histBtn);

  // Engine banner
  const bannerText = h('span', { class: 'banner-text' });
  const bannerBtn = h('button', { class: 'banner-btn', type: 'button' }, 'Start engine');
  const bannerSpin = spinner();
  const banner = h('div', { class: 'banner', role: 'status', hidden: true },
    icon('bolt', 'banner-ic'), bannerSpin, bannerText, bannerBtn);

  // Messages
  const list = h('div', { class: 'list', role: 'log', 'aria-label': 'Conversation', 'aria-live': 'off' });
  const emptyName = h('p', { class: 'empty-sub' });
  const versionLine = h('p', { class: 'empty-version' });
  const starters = [
    ['Explain this file', 'Explain what this file does and how it fits into the project.'],
    ['Find the bug', 'Find the bug in this code and explain the fix.'],
    ['Write tests for this', 'Write tests for this.'],
    ['Review my changes', 'Review my uncommitted changes and point out anything risky.'],
  ];
  const empty = h('div', { class: 'empty' },
    h('div', { class: 'empty-mark' }, mark('empty-mark-svg')),
    h('h2', { class: 'empty-title', text: 'What are we working on?' }),
    emptyName,
    h('div', { class: 'starters' },
      starters.map(([title, text]) =>
        h('button', { class: 'starter', type: 'button', onclick: () => prefill(text) }, title))),
    versionLine);
  // The task list, pinned under the latest reply.
  const tasksBox = h('div', { class: 'tasks', role: 'region', 'aria-label': 'Task list', hidden: true });
  const scroller = h('div', { class: 'scroller' }, empty, list, tasksBox);

  // History overlay
  const histList = h('div', { class: 'hist-list', role: 'list' });
  const histClose = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close history', title: 'Close' }, icon('close'));
  const history = h('div', { class: 'history', role: 'dialog', 'aria-label': 'Chat history', hidden: true },
    h('div', { class: 'hist-head' }, h('span', { class: 'hist-title', text: 'Chats' }), h('span', { class: 'grow' }),
      h('button', { class: 'hist-new', type: 'button', onclick: () => { newChat(); } }, icon('plus'), 'New chat'),
      histClose),
    histList);

  const main = h('div', { class: 'main' }, scroller, history);

  // Activity line
  const activityText = h('span', { class: 'activity-text' });
  const activity = h('div', { class: 'activity idle', role: 'status', 'aria-live': 'polite' }, spinner(), activityText);

  // Approval card
  const approvalSlot = h('div', { class: 'approval-slot' });
  const secretSlot = h('div', { class: 'approval-slot' });

  // Context chip
  const chip = h('button', { class: 'ctx-chip', type: 'button', hidden: true });

  // Composer
  const input = h('textarea', {
    class: 'input', rows: '1', 'aria-label': 'Message', spellcheck: 'true',
    title: 'Enter to send · Shift+Enter for a new line',
  });
  // Effort: Low · Medium · High · Max (engine/effort.ts). A pill that opens a small menu.
  const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['max', 'Max']];
  const effortLabel = h('span', { text: 'Medium' });
  const effortPill = h('button', {
    class: 'pill effort-pill', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
  }, icon('think'), effortLabel, icon('chevron', 'chev'));
  const effortItems = EFFORTS.map(([id, label]) => h('button', {
    class: 'effort-item', type: 'button', role: 'menuitemradio', 'aria-checked': 'false', 'data-effort': id,
  }, h('span', { class: 'effort-name', text: label }), h('span', { class: 'effort-help' })));
  const effortPop = h('div', { class: 'meter-pop effort-pop', role: 'menu', 'aria-label': 'Effort', hidden: true }, ...effortItems);
  const webPill = h('button', {
    class: 'pill', type: 'button', 'aria-pressed': 'false',
    title: 'Let the assistant search and read web pages (read-only)',
  }, icon('globe'), h('span', { text: 'Web' }));
  // Mode: Ask · Edit · Auto · Plan · Debug (engine/modes.ts). A pill like Effort's; ⇧Tab in the message box cycles it.
  const MODE_IDS = ['ask', 'edit', 'auto', 'plan', 'debug'];
  const modeLabel = h('span', { text: 'Ask' });
  const modeRole = h('span', { class: 'pill-role', text: '' });
  const modePill = h('button', {
    class: 'pill mode-pill', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
  }, icon('list'), modeLabel, modeRole, icon('chevron', 'chev'));
  const modeItems = MODE_IDS.map((id) => h('button', {
    class: 'effort-item', type: 'button', role: 'menuitemradio', 'aria-checked': 'false', 'data-mode': id,
  }, h('span', { class: 'effort-name', text: id }), h('span', { class: 'effort-help' })));
  const modePop = h('div', { class: 'meter-pop effort-pop mode-pop', role: 'menu', 'aria-label': 'Mode', hidden: true }, ...modeItems);
  // Messages typed while it works: they join the run at its next step (× takes one back).
  const queuedRow = h('div', { class: 'queued-row', role: 'list', 'aria-label': 'Waiting to join the run', hidden: true });
  const sendBtn = h('button', { class: 'send', type: 'button', 'aria-label': 'Send', title: 'Send (Enter)' }, icon('send'));
  const clipBtn = h('button', {
    class: 'icon-btn clip', type: 'button', 'aria-label': 'Attach files', title: 'Attach files (or paste / drop them here)',
  }, icon('clip'));
  const attachRow = h('div', { class: 'attach-row', role: 'list', 'aria-label': 'Attachments', hidden: true });

  // Context meter: a thin ring + percentage; click for details and "Compact chat".
  const RING_R = 5.5;
  const RING_C = 2 * Math.PI * RING_R;
  const ringTpl = document.createElement('template');
  ringTpl.innerHTML = `<svg class="ring" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false"><circle class="ring-bg" cx="7" cy="7" r="${RING_R}" fill="none" stroke-width="2"/><circle class="ring-fg" cx="7" cy="7" r="${RING_R}" fill="none" stroke-width="2" stroke-linecap="round" transform="rotate(-90 7 7)" stroke-dasharray="0 ${RING_C}"/></svg>`;
  const ring = ringTpl.content.firstChild;
  const meterPct = h('span', { class: 'meter-pct' });
  const meterBtn = h('button', { class: 'meter', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', hidden: true }, ring, meterPct);
  const meterText = h('p', { class: 'meter-text' });
  const compactBtn = h('button', { class: 'btn compact-btn', type: 'button' }, icon('compact'), 'Compact chat');
  const meterPop = h('div', { class: 'meter-pop', role: 'dialog', 'aria-label': 'Context usage', hidden: true },
    meterText,
    h('p', { class: 'meter-hint', text: 'Compacting summarises older messages so the model can keep going. You can also type /compact.' }),
    compactBtn);

  const composer = h('div', { class: 'composer' },
    attachRow,
    input,
    h('div', { class: 'composer-row' }, clipBtn, h('span', { class: 'meter-wrap' }, effortPill, effortPop), h('span', { class: 'meter-wrap' }, modePill, modePop), webPill, h('span', { class: 'grow' }),
      h('span', { class: 'meter-wrap' }, meterBtn, meterPop), sendBtn));

  const HINT = 'Enter to send · Shift+Enter new line · / for commands';
  const STEER_HINT = 'Enter adds your message at the next step · Stop ends the run';
  const hint = h('div', { class: 'hint', role: 'status', 'aria-live': 'polite', text: HINT });

  const slashMenu = h('div', { class: 'slash', id: 'slash-menu', role: 'listbox', 'aria-label': 'Commands and skills', hidden: true });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'slash-menu');
  input.setAttribute('aria-expanded', 'false');

  const mcpList = h('div', { class: 'mcp-list' });
  const mcpReload = h('button', { class: 'btn', type: 'button' }, icon('refresh'), h('span', { text: 'Reload' }));
  const mcpDone = h('button', { class: 'btn primary', type: 'button' }, 'Done');
  const mcpEdit = h('button', { class: 'btn', type: 'button' }, icon('edit'), 'Edit mcp.json');
  const mcpClose = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close' }, icon('close'));
  const mcpCard = h('section', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mcp-title', 'aria-describedby': 'mcp-sub', tabindex: '-1' },
    h('div', { class: 'modal-head' },
      h('span', { class: 'modal-ic' }, icon('plug')),
      h('div', { class: 'modal-titles' },
        h('h2', { class: 'modal-title', id: 'mcp-title', text: 'MCP servers' }),
        h('p', { class: 'modal-sub', id: 'mcp-sub', text: 'From ~/.ingle/mcp.json, plus Cursor and Claude Code’s configs.' })),
      mcpClose),
    mcpList,
    h('div', { class: 'modal-foot' }, mcpEdit, mcpReload, h('span', { class: 'grow' }), mcpDone));
  const mcpModal = h('div', { class: 'modal-backdrop', hidden: true }, mcpCard);

  const announcer = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });

  app.append(header, banner, main, activity, secretSlot, approvalSlot,
    h('div', { class: 'bottom' }, slashMenu, chip, queuedRow, composer, hint), mcpModal, announcer);

  function announce(text) {
    announcer.textContent = '';
    setTimeout(() => { announcer.textContent = text; }, 30);
  }

  // ---------------------------------------------------------------------------------------------
  // Header: assistant picker, new chat, history
  // ---------------------------------------------------------------------------------------------

  function renderHeader() {
    const a = currentAssistant();
    setText(asstName, a ? a.name : 'Ingle');
    setText(asstRole, a && a.role ? `· ${a.role}` : '');
    asstBtn.setAttribute('aria-label', a ? `Assistant: ${a.name}${a.role ? ', ' + a.role : ''}. Change assistant` : 'Choose assistant');
    if (S.menuOpen) renderMenu();
  }

  function renderMenu() {
    asstMenu.replaceChildren();
    for (const a of S.assistants) {
      const on = a.id === S.currentAssistant;
      asstMenu.append(h('button', {
        class: 'menu-item' + (on ? ' on' : ''), type: 'button', role: 'menuitemradio', 'aria-checked': on ? 'true' : 'false',
        'data-id': a.id,
        onclick: () => { setAssistant(a.id); closeMenu(true); },
      },
      h('span', { class: 'menu-check' }, on ? icon('check') : null),
      h('span', { class: 'menu-text' },
        h('span', { class: 'menu-name' }, a.name, a.role ? h('span', { class: 'menu-role', text: ` · ${a.role}` }) : null),
        a.model ? h('span', { class: 'menu-model', text: a.model }) : null)));
    }
    if (S.assistants.length) asstMenu.append(h('div', { class: 'menu-sep', role: 'separator' }));
    if (S.messages.length) {
      asstMenu.append(h('button', {
        class: 'menu-item', type: 'button', role: 'menuitem', disabled: S.streaming,
        onclick: () => { post({ type: 'compact' }); closeMenu(false); input.focus(); },
      }, h('span', { class: 'menu-check' }, icon('compact')), h('span', { class: 'menu-text' }, h('span', { class: 'menu-name', text: 'Compact chat' }))));
    }
    asstMenu.append(h('button', {
      class: 'menu-item', type: 'button', role: 'menuitem',
      onclick: () => { post({ type: 'openSettings' }); closeMenu(true); },
    }, h('span', { class: 'menu-check' }, icon('gear')), h('span', { class: 'menu-text' }, h('span', { class: 'menu-name', text: 'Open Ingle folder' }))));
  }

  function openMenu() {
    S.menuOpen = true;
    renderMenu();
    asstMenu.hidden = false;
    asstBtn.setAttribute('aria-expanded', 'true');
    const first = asstMenu.querySelector('.menu-item.on') || asstMenu.querySelector('.menu-item');
    if (first) first.focus();
  }

  function closeMenu(refocus) {
    if (!S.menuOpen) return;
    S.menuOpen = false;
    asstMenu.hidden = true;
    asstBtn.setAttribute('aria-expanded', 'false');
    if (refocus) asstBtn.focus();
  }

  asstBtn.addEventListener('click', () => (S.menuOpen ? closeMenu(false) : openMenu()));
  asstBtn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(); }
  });
  asstMenu.addEventListener('keydown', (e) => {
    const items = [...asstMenu.querySelectorAll('.menu-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  document.addEventListener('mousedown', (e) => {
    if (S.menuOpen && !asstMenu.contains(e.target) && !asstBtn.contains(e.target)) closeMenu(false);
  });

  function setAssistant(id) {
    if (id === S.currentAssistant) return;
    S.currentAssistant = id;
    post({ type: 'setAssistant', id });
    renderHeader();
    renderEmpty();
    renderComposer();
  }

  function newChat() {
    closeHistory(false);
    post({ type: 'newChat' });
    input.focus();
  }
  newBtn.addEventListener('click', newChat);

  function relTime(t) {
    if (!t) return '';
    const ms = t < 1e12 ? t * 1000 : t;
    const diff = Math.max(0, Date.now() - ms);
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hrs = Math.floor(min / 60);
    const then = new Date(ms);
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= dayStart) return `${hrs} h ago`;
    if (ms >= dayStart - 86400000) return 'yesterday';
    const days = Math.ceil((dayStart - ms) / 86400000);
    if (days < 7) return `${days} days ago`;
    const opts = { day: 'numeric', month: 'short' };
    if (then.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return then.toLocaleDateString('en-GB', opts);
  }

  function renderHistory() {
    histList.replaceChildren();
    const chats = [...S.chats].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (!chats.length) {
      histList.append(h('p', { class: 'hist-empty', text: 'No chats yet.' }));
      return;
    }
    for (const c of chats) {
      const on = c.id === S.chatId;
      const title = c.title || 'New chat';
      histList.append(h('div', { class: 'hist-row' + (on ? ' on' : ''), role: 'listitem' },
        h('button', {
          class: 'hist-open', type: 'button', 'aria-current': on ? 'true' : null,
          onclick: () => { if (!on) post({ type: 'openChat', id: c.id }); closeHistory(false); input.focus(); },
        }, h('span', { class: 'hist-name', text: title }), h('span', { class: 'hist-time', text: relTime(c.updated) })),
        h('button', {
          class: 'icon-btn hist-del', type: 'button', 'aria-label': `Delete chat: ${title}`, title: 'Delete chat',
          onclick: (e) => {
            e.stopPropagation();
            const rows = [...histList.querySelectorAll('.hist-row')];
            const at = rows.indexOf(e.currentTarget.closest('.hist-row'));
            post({ type: 'deleteChat', id: c.id });
            S.chats = S.chats.filter((x) => x.id !== c.id);
            renderHistory();
            const dels = histList.querySelectorAll('.hist-del');
            (dels[Math.min(at, dels.length - 1)] || histClose).focus();
            announce('Chat deleted');
          },
        }, icon('trash'))));
    }
  }

  function openHistory() {
    closeMenu(false);
    S.historyOpen = true;
    renderHistory();
    history.hidden = false;
    histBtn.setAttribute('aria-expanded', 'true');
    histBtn.classList.add('on');
    const target = histList.querySelector('.hist-row.on .hist-open') || histList.querySelector('.hist-open') || histClose;
    target.focus();
  }

  function closeHistory(refocus) {
    if (!S.historyOpen) return;
    S.historyOpen = false;
    history.hidden = true;
    histBtn.setAttribute('aria-expanded', 'false');
    histBtn.classList.remove('on');
    if (refocus) histBtn.focus();
  }

  histBtn.addEventListener('click', () => (S.historyOpen ? closeHistory(true) : openHistory()));
  histClose.addEventListener('click', () => closeHistory(true));

  // ---------------------------------------------------------------------------------------------
  // Engine banner, activity, context chip
  // ---------------------------------------------------------------------------------------------

  function renderBanner() {
    const st = S.engine && S.engine.state;
    if (st === 'ready' || !st) {
      banner.hidden = true;
      S.startingEngine = false;
      return;
    }
    banner.hidden = false;
    const starting = st === 'starting' || S.startingEngine;
    banner.classList.toggle('starting', starting);
    bannerSpin.hidden = !starting;
    banner.querySelector('.banner-ic').classList.toggle('gone', starting);
    const text = S.engine.text || (starting ? 'Starting the engine…' : 'The AI engine isn’t running, so Ingle can’t reply yet.');
    setText(bannerText, starting && st !== 'starting' ? 'Starting the engine…' : text);
    bannerBtn.hidden = st !== 'offline';
    bannerBtn.disabled = starting;
    setText(bannerBtn, starting ? 'Starting…' : 'Start engine');
  }
  bannerBtn.addEventListener('click', () => {
    S.startingEngine = true;
    post({ type: 'startEngine' });
    renderBanner();
  });

  function renderActivity() {
    const text = S.streaming && S.activity ? S.activity : '';
    activity.classList.toggle('idle', !text);
    setText(activityText, text);
  }

  function renderChip() {
    const c = S.context;
    if (!c || (!c.project && !c.file)) { chip.hidden = true; return; }
    chip.hidden = false;
    const on = S.useContext;
    const where = [c.project, c.file].filter(Boolean).join(' · ');
    const extras = [];
    if (on && c.hasSelection) extras.push(h('span', { class: 'ctx-extra', text: '· selection' }));
    if (on && c.problems > 0) extras.push(h('span', { class: 'ctx-problems', text: `· ${c.problems} problem${c.problems === 1 ? '' : 's'}` }));
    chip.replaceChildren(
      icon('code', 'ctx-ic'),
      h('span', { class: 'ctx-lead', text: on ? 'Working in' : 'Not using' }),
      h('span', { class: 'ctx-where', text: where }),
      ...extras,
      icon(on ? 'close' : 'plus', 'ctx-x'));
    chip.classList.toggle('off', !on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.setAttribute('aria-label', `${on ? 'Using' : 'Not using'} editor context: ${where}${on && c.problems ? `, ${c.problems} problems` : ''}`);
    chip.title = on
      ? 'Ingle can see your project, open file, selection and problems. Click to leave them out of this chat.'
      : 'Click to let this chat see your project, open file, selection and problems.';
  }
  chip.addEventListener('click', () => {
    S.useContext = !S.useContext;
    post({ type: 'toggle', key: 'useContext', value: S.useContext });
    renderChip();
  });

  // ---------------------------------------------------------------------------------------------
  // Approval card
  // ---------------------------------------------------------------------------------------------

  const APPROVAL_ICONS = {
    command: 'terminal', write: 'file', edit: 'edit', open: 'link', mcp: 'plug', memory: 'memory',
    skill: 'sparkle', rule: 'book', read: 'eye', ssh: 'remote',
  };

  function renderApproval() {
    const a = S.approval;
    approvalSlot.replaceChildren();
    if (!a) return;

    const decide = (decision) => {
      if (!S.approval || S.approval.id !== a.id) return;
      post({ type: 'approve', id: a.id, decision });
      S.approval = null;
      renderApproval();
      announce(decision === 'deny' ? 'Denied' : 'Allowed');
      input.focus();
    };
    // Enter must never approve: only a click or Space does.
    const noEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); } };

    const titleId = 'approval-title-' + a.id.replace(/[^\w-]/g, '');
    const preview = a.preview
      ? htmlEl('pre', 'approval-preview' + (a.kind === 'edit' ? ' is-diff' : ''),
        a.kind === 'edit' || /^(---|\+\+\+|@@)/m.test(a.preview) ? highlightDiff(a.preview) : esc(a.preview))
      : null;
    if (preview) { preview.tabIndex = 0; preview.setAttribute('aria-label', 'Preview'); }

    const allow = h('button', { class: 'btn primary', type: 'button', onclick: () => decide('allow'), onkeydown: noEnter }, 'Allow');
    // A call that uses a secret asks every time: no "Allow for this session".
    const always = a.noSession ? null : h('button', { class: 'btn', type: 'button', onclick: () => decide('always'), onkeydown: noEnter }, 'Allow for this session');
    const scope = a.noSession ? '' : a.sessionScope ? `Allow for this session covers ${a.sessionScope}, until VS Code closes.` : '';
    if (scope && always) always.title = scope;
    const deny = h('button', { class: 'btn', type: 'button', onclick: () => decide('deny') }, 'Deny');
    const diff = a.canShowDiff
      ? h('button', { class: 'btn ghost', type: 'button', onclick: () => post({ type: 'showDiff', id: a.id }) }, icon('diff'), 'View Diff')
      : null;

    const detail = htmlEl('pre', 'approval-detail', esc(a.detail || ''));
    detail.tabIndex = 0;
    const card = h('section', { class: 'approval', role: 'group', 'aria-labelledby': titleId, tabindex: '-1' },
      h('div', { class: 'approval-head' },
        h('span', { class: 'approval-ic' }, icon(APPROVAL_ICONS[a.kind] || 'warning')),
        h('span', { class: 'approval-title', id: titleId, text: a.title || 'Allow this action?' })),
      a.secretLine ? h('p', { class: 'approval-secret' }, icon('key'), h('span', { text: a.secretLine })) : null,
      a.detail ? detail : null,
      preview,
      a.secretWarning ? h('p', { class: 'approval-warning' }, icon('warning'), h('span', { text: a.secretWarning })) : null,
      a.noSession && a.secrets ? h('p', { class: 'approval-scope', text: 'Secrets are approved one use at a time.' }) : null,
      scope ? h('p', { class: 'approval-scope', text: scope }) : null,
      h('div', { class: 'approval-actions' },
        deny, diff, h('span', { class: 'grow' }), always, allow));
    approvalSlot.append(card);
    announce(`Approval needed: ${a.title || 'an action'}`);
    // Don't pull focus out of the message box; otherwise park it on the card (not a button).
    if (document.activeElement === document.body || !document.activeElement) card.focus();
  }

  // ---------------------------------------------------------------------------------------------
  // "This looks like a secret" card (before a message is stored or sent)
  // ---------------------------------------------------------------------------------------------

  function renderSecretPrompt() {
    const p = S.secretPrompt;
    secretSlot.replaceChildren();
    if (!p) return;
    const rows = p.found.map((f) => {
      const name = h('input', { class: 'secret-name', type: 'text', value: f.suggested, 'aria-label': 'Name for this ' + f.kind, spellcheck: 'false' });
      const desc = h('input', { class: 'secret-desc', type: 'text', placeholder: 'What it’s for (optional)', 'aria-label': 'Description' });
      return { name, desc, el: h('div', { class: 'secret-row' },
        h('span', { class: 'secret-kind', text: `${f.kind} (${f.preview})` }), name, desc) };
    });
    const decide = (decision) => {
      if (!S.secretPrompt || S.secretPrompt.requestId !== p.requestId) return;
      const items = rows.map((r) => ({ name: r.name.value.trim().toLowerCase(), description: r.desc.value.trim() }));
      if (decision === 'save' && items.some((i) => !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(i.name))) {
        showNotice('Names can use lower-case letters, digits, dots and dashes.');
        return;
      }
      post({ type: 'secretDecision', requestId: p.requestId, decision, items: decision === 'save' ? items : undefined });
      S.secretPrompt = null;
      renderSecretPrompt();
      input.focus();
    };
    const many = p.found.length > 1;
    const card = h('section', { class: 'approval secret-prompt', role: 'group', 'aria-label': 'Possible secret', tabindex: '-1' },
      h('div', { class: 'approval-head' },
        h('span', { class: 'approval-ic' }, icon('key')),
        h('span', { class: 'approval-title', text: many ? 'These look like secrets' : 'This looks like a secret' })),
      h('p', { class: 'approval-scope', text: 'Save it in the Keychain and the message will use a placeholder instead. The assistant never sees the value; you approve each use.' }),
      rows.map((r) => r.el),
      h('div', { class: 'approval-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => decide('cancel') }, 'Cancel'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', type: 'button', onclick: () => decide('send') }, 'Send anyway'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => decide('save') }, many ? 'Save as secrets' : 'Save as secret')));
    secretSlot.append(card);
    announce('That looks like a secret. Save it as a secret, send anyway, or cancel.');
    rows[0]?.name.focus();
  }

  // ---------------------------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------------------------

  function liveInfo() {
    const msgs = S.messages;
    const last = msgs[msgs.length - 1];
    const liveId = S.streaming && last && last.role === 'assistant' && !last.compaction ? last.id : null;
    let lastAssistantId = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant' && !msgs[i].compaction) { lastAssistantId = msgs[i].id; break; }
    }
    return { liveId, lastAssistantId };
  }

  function kindOf(m) {
    return m.compaction ? 'compaction' : m.role;
  }

  function createEntry(m) {
    const kind = kindOf(m);
    const root = h('div', { class: 'msg msg-' + kind, 'data-id': m.id });
    const e = { root, role: kind, blocks: [] };
    if (kind === 'compaction') {
      e.head = h('button', { class: 'compact-head', type: 'button', 'data-act': 'toggle-summary', 'aria-expanded': 'false' });
      e.body = h('div', { class: 'compact-body md', hidden: true });
      root.append(h('div', { class: 'compact-line' }, e.head), e.body);
    } else if (kind === 'user') {
      e.files = h('div', { class: 'bubble-files', hidden: true });
      e.body = h('div', { class: 'bubble md' });
      e.steerTag = h('div', { class: 'steer-tag', text: 'Added while it was working', hidden: true });
      root.append(e.files, e.body, e.steerTag);
    } else if (m.role === 'assistant') {
      e.who = h('span', { class: 'who' });
      e.model = h('span', { class: 'model' });
      e.thinkBtn = h('button', { class: 'chip-btn think-btn', type: 'button', 'data-act': 'toggle-think', 'aria-expanded': 'false' },
        h('span', { class: 'think-label' }), icon('chevron', 'chev'));
      e.used = h('span', { class: 'used-chip', title: 'Rules, skills and memories Ingle matched to your message and gave the assistant' });
      e.chips = h('div', { class: 'msg-chips' }, e.thinkBtn, e.used);
      e.thinking = h('div', { class: 'thinking', hidden: true });
      e.dots = h('div', { class: 'typing', 'aria-label': 'Writing', role: 'img' }, h('span'), h('span'), h('span'));
      e.body = h('div', { class: 'md' });
      e.copyBtn = h('button', { class: 'icon-btn sm', type: 'button', 'data-act': 'copy-msg', 'aria-label': 'Copy reply', title: 'Copy' }, icon('copy'));
      e.regenBtn = h('button', { class: 'icon-btn sm', type: 'button', 'data-act': 'regen', 'aria-label': 'Regenerate reply', title: 'Regenerate' }, icon('refresh'));
      e.stats = h('span', { class: 'stats' });
      e.foot = h('div', { class: 'msg-foot' }, e.copyBtn, e.regenBtn, e.stats);
      e.undo = h('div', { class: 'undo-run changes', hidden: true });
      e.planBar = h('div', { class: 'plan-bar', hidden: true },
        h('span', { class: 'plan-text', text: 'Plan mode · Approve to start the work with this plan as the task list, or reply to change it.' }),
        h('button', { class: 'btn primary', type: 'button', 'data-act': 'approve-plan' }, icon('check'), 'Approve'));
      e.planCard = h('div', { class: 'plan-card', hidden: true });
      root.append(
        h('div', { class: 'msg-head' }, h('span', { class: 'avatar' }, mark()), e.who, e.model),
        e.chips, e.thinking, e.dots, e.body, e.foot, e.planCard, e.planBar, e.undo);
    } else {
      e.head = h('button', { class: 'tool-head', type: 'button', 'data-act': 'toggle-tool', 'aria-expanded': 'false' });
      e.prev = h('button', { class: 'icon-btn sm tool-preview', type: 'button', 'data-act': 'tool-preview', title: 'Open Preview', hidden: true }, icon('eye'));
      e.out = h('pre', { class: 'tool-out', hidden: true, tabindex: '0' });
      root.append(h('div', { class: 'tool-row' }, e.head, e.prev), e.out);
    }
    return e;
  }

  function fill(e, m, info) {
    if (e.role === 'compaction') fillCompaction(e, m);
    else if (m.role === 'user') fillUser(e, m);
    else if (m.role === 'assistant') fillAssistant(e, m, info);
    else fillTool(e, m);
  }

  function fillUser(e, m) {
    e.steerTag.hidden = !m.steer;
    const text = m.content || '';
    if (e.text !== text) {
      e.text = text;
      renderMarkdown(e.body, e, text);
    }
    e.body.hidden = !text;
    const files = Array.isArray(m.attachments) ? m.attachments : [];
    const fkey = files.map((a) => `${a.name}|${a.mime}|${a.thumbnail ? a.thumbnail.length : 0}`).join('\u0001');
    if (e.fkey !== fkey) {
      e.fkey = fkey;
      e.files.replaceChildren(...files.map((a) => {
        const img = isImage(a);
        if (img && a.thumbnail && /^data:image\//.test(a.thumbnail)) {
          return h('span', { class: 'bubble-thumb', title: a.name }, h('img', { src: a.thumbnail, alt: a.name }));
        }
        return h('span', { class: 'bubble-file', title: a.name }, icon(img ? 'image' : 'doc'), h('span', { class: 'bubble-file-name', text: a.name }));
      }));
    }
    e.files.hidden = !files.length;
  }

  function fillCompaction(e, m) {
    const c = m.compaction || { summarisedCount: 0, auto: false };
    const open = openSummaries.has(m.id);
    const n = c.summarisedCount || 0;
    const label = `Earlier messages summarised · ${n} message${n === 1 ? '' : 's'}`;
    const key = label + open + c.auto;
    if (e.key !== key) {
      e.key = key;
      e.head.replaceChildren(icon('compact'), h('span', { text: label }), icon('chevron', 'chev' + (open ? ' open' : '')));
      e.head.setAttribute('aria-expanded', open ? 'true' : 'false');
      e.head.title = (c.auto ? 'Summarised automatically to keep the chat within the model’s context.' : 'You compacted this chat.') +
        ' Click to read the summary the model now sees.';
    }
    e.body.hidden = !open;
    if (open && e.text !== (m.content || '')) {
      e.text = m.content || '';
      renderMarkdown(e.body, e, e.text || '_No summary._');
    }
  }

  function fillAssistant(e, m, info) {
    const p = splitThinking(m.content, m.thinking);
    const live = m.id === info.liveId;
    const failed = !!m.failed;
    e.root.classList.toggle('failed', failed);
    e.root.classList.toggle('live', live);

    setText(e.who, m.assistantName || (currentAssistant() || {}).name || 'Ingle');
    setText(e.model, m.model || '');
    e.model.hidden = !m.model;

    // Thinking toggle
    const hasThinking = !!p.thinking;
    e.thinkBtn.hidden = !hasThinking;
    if (hasThinking) {
      const open = openThinking.has(m.id);
      let label = 'Thoughts';
      if (live && !p.body) label = 'Thinking…';
      else if (m.thoughtSeconds != null) label = `Thought for ${Math.max(1, Math.round(m.thoughtSeconds))}s`;
      setText(e.thinkBtn.firstChild, label);
      e.thinkBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      e.thinkBtn.classList.toggle('open', open);
      e.thinking.hidden = !open;
      if (open) setText(e.thinking, p.thinking);
    } else {
      e.thinking.hidden = true;
    }

    // Used context
    const used = Array.isArray(m.usedContext) ? m.usedContext.filter(Boolean) : [];
    e.used.hidden = !used.length;
    if (used.length) {
      const text = used.join(' · ');
      if (e.usedText !== text) {
        e.usedText = text;
        e.used.replaceChildren(icon('sparkle'), h('span', { text }));
        e.used.setAttribute('aria-label', `Used context: ${used.join(', ')}`);
      }
    }
    e.chips.hidden = !hasThinking && !used.length;

    // Body
    e.dots.hidden = !(live && !p.body);
    const body = p.body || (failed ? 'Something went wrong.' : '');
    if (e.text !== body) {
      e.text = body;
      renderMarkdown(e.body, e, body);
    }
    e.body.hidden = !body;

    // Footer
    e.foot.hidden = live || !p.body;
    e.regenBtn.hidden = !(m.id === info.lastAssistantId && !S.streaming);
    const st = m.stats;
    const statsText = st && isFinite(st.tokensPerSecond)
      ? `${Math.round(st.tokensPerSecond)} tok/s${isFinite(st.seconds) ? ` · ${Number(st.seconds).toFixed(1)}s` : ''}`
      : '';
    setText(e.stats, statsText);
    e.stats.hidden = !statsText;

    const canApprove = S.workMode === 'plan' && !S.streaming && m.id === info.lastAssistantId && !failed && !!p.body;
    fillPlanCard(e, m, canApprove);
    e.planBar.hidden = !canApprove || !!m.plan;
    fillUndo(e, m);
    e.root.hidden = !body && !hasThinking && !live && !m.checkpoint && !m.plan;
  }

  const UNDO_VERB = { restore: 'Put back', remove: 'Remove', recreate: 'Bring back' };
  const CHANGE_VERB = { restore: 'Edited', remove: 'Created', recreate: 'Deleted' };

  /** A unified diff with added lines green and removed ones red. */
  function diffPre(text) {
    const pre = h('pre', { class: 'run-diff', tabindex: '0' });
    for (const line of String(text || '').split('\n')) {
      const cls = line.startsWith('@@') ? 'd-hunk' : (line.startsWith('+++') || line.startsWith('---')) ? 'd-file'
        : line.startsWith('+') ? 'd-add' : line.startsWith('-') ? 'd-del' : '';
      pre.append(h('span', { class: cls, text: (line || ' ') + '\n' }));
    }
    if (!text) pre.append(h('span', { class: 'd-file', text: 'No text changes (a binary file, or it ended up the same).' }));
    return pre;
  }

  /** The changes panel under the last reply of a run that changed files: each file with its diff, Open and Diff,
   *  plus Undo this run and Commit (in a git repo). */
  function fillUndo(e, m) {
    const cp = m.checkpoint;
    const files = cp && Array.isArray(cp.files) ? cp.files : [];
    if (!cp || !files.length) { e.undo.hidden = true; e.undoKey = ''; return; }
    e.undo.hidden = false;
    if (cp.committed) commits.delete(m.id);
    const open = openUndo.has(m.id);
    const note = undoNotes.get(m.id);
    const data = changesData.get(m.id);
    const commit = commits.get(m.id);
    const diffs = data && data !== 'loading' ? data.files.map((_, i) => openDiffs.has(m.id + '|' + i)) : [];
    const key = JSON.stringify([files, !!cp.undone, cp.committed || '', open, note || null, S.streaming, !!data, data === 'loading', diffs,
      commit ? [commit.phase, commit.error || ''] : null]);
    if (e.undoKey === key) return;
    e.undoKey = key;
    const n = files.length;
    const count = `${n} file${n === 1 ? '' : 's'}`;
    const tags = [];
    if (cp.committed) tags.push(h('span', { class: 'undo-done' }, icon('check'), h('span', { text: `Committed ${cp.committed}` })));
    if (cp.undone) tags.push(h('span', { class: 'undo-done' }, icon('undo'), h('span', { text: `Run undone · ${count} put back` })));
    const head = h('button', {
      class: 'chip-btn undo-btn' + (open ? ' open' : ''), type: 'button', 'data-act': 'undo-toggle', 'aria-expanded': open ? 'true' : 'false',
      title: 'Every file this run changed, with its diff',
    }, icon('diff'), h('span', { text: `Changes · ${count}` }), icon('chevron', 'chev' + (open ? ' open' : '')));
    if (!open) { e.undo.replaceChildren(h('div', { class: 'changes-head' }, head, ...tags)); return; }
    const kids = [h('div', { class: 'changes-head' }, head, ...tags)];
    const rows = files.map((f, i) => {
      const full = data && data !== 'loading' ? data.files.find((x) => x.display === f.path) || data.files[i] : null;
      const stats = full ? h('span', { class: 'chg-stats' }, h('span', { class: 'd-add', text: `+${full.added}` }), h('span', { class: 'd-del', text: ` −${full.removed}` })) : null;
      const isOpen = openDiffs.has(m.id + '|' + i);
      const li = h('li', null,
        h('div', { class: 'chg-row' },
          h('button', { class: 'chg-file', type: 'button', 'data-act': 'chg-file', 'data-i': String(i), 'aria-expanded': isOpen ? 'true' : 'false', disabled: !full },
            icon('chevron', 'chev' + (isOpen ? ' open' : '')),
            h('span', { class: 'undo-verb undo-' + f.action, text: CHANGE_VERB[f.action] || 'Edited' }),
            h('span', { class: 'undo-path', text: f.path, title: f.path }), stats),
          full ? h('button', { class: 'icon-btn sm', type: 'button', 'data-act': 'chg-diff', 'data-i': String(i), title: 'Open in VS Code’s diff editor', 'aria-label': 'Diff ' + f.path }, icon('diff')) : null,
          full && f.action !== 'remove' ? h('button', { class: 'icon-btn sm', type: 'button', 'data-act': 'chg-preview', 'data-i': String(i), title: 'Open Preview', 'aria-label': 'Preview ' + f.path }, icon('eye')) : null,
          full && f.action !== 'recreate' ? h('button', { class: 'icon-btn sm', type: 'button', 'data-act': 'chg-open', 'data-i': String(i), title: 'Open in editor', 'aria-label': 'Open ' + f.path }, icon('file')) : null));
      if (isOpen && full) li.append(diffPre(full.diff));
      return li;
    });
    kids.push(h('ul', { class: 'undo-list changes-list', 'aria-label': 'Files this run changed' }, rows));
    if (data === 'loading') kids.push(h('p', { class: 'undo-note', text: 'Loading the diffs…' }));
    kids.push(h('p', { class: 'undo-note', text: 'Undo puts these files back. Changes made by commands, or on other computers over SSH, can’t be undone here.' }));
    if (note) kids.push(h('p', { class: 'approval-warning undo-warning', role: 'alert' }, icon('warning'), h('span', { text: note.message })));
    const busy = S.streaming;
    const actions = [];
    if (!cp.undone) {
      actions.push(note && note.canForce
        ? h('button', { class: 'btn', type: 'button', 'data-act': 'undo-force', disabled: busy }, icon('undo'), 'Undo anyway')
        : h('button', { class: 'btn', type: 'button', 'data-act': 'undo-go', disabled: busy, title: 'Put back every file this run changed' }, icon('undo'), 'Undo this run'));
    }
    const canCommit = data && data !== 'loading' && data.repo && !cp.committed && !cp.undone;
    if (canCommit && !commit) actions.push(h('button', { class: 'btn primary', type: 'button', 'data-act': 'commit-draft', disabled: busy, title: 'Draft a commit message for exactly these files' }, icon('check'), 'Commit…'));
    if (data && data !== 'loading' && !data.repo && data.noCommit && !cp.committed) kids.push(h('p', { class: 'undo-note', text: 'Commit: ' + data.noCommit }));
    if (actions.length) kids.push(h('div', { class: 'approval-actions' }, actions));
    if (commit) {
      if (commit.phase === 'drafting') kids.push(h('p', { class: 'undo-note' }, spinner(), ' Drafting a commit message…'));
      else {
        const box = h('textarea', { class: 'commit-msg', rows: '4', 'aria-label': 'Commit message', disabled: commit.phase === 'committing' });
        box.value = commit.message || '';
        box.addEventListener('input', () => { commit.message = box.value; });
        kids.push(h('div', { class: 'commit-box' },
          h('label', { class: 'undo-note', text: `Commit message (only this run’s files${data && data.repo ? ' in ' + data.repo.split('/').pop() : ''}; never pushed)` }),
          box,
          commit.error ? h('p', { class: 'approval-warning undo-warning', role: 'alert' }, icon('warning'), h('span', { text: commit.error })) : null,
          h('div', { class: 'approval-actions' },
            h('button', { class: 'btn', type: 'button', 'data-act': 'commit-cancel' }, 'Cancel'),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn primary', type: 'button', 'data-act': 'commit-go', disabled: commit.phase === 'committing' || busy }, icon('check'), commit.phase === 'committing' ? 'Committing…' : 'Commit'))));
      }
    }
    e.undo.replaceChildren(...kids);
  }

  const PLAN_STATUS = { draft: 'Draft', approved: 'Approved', done: 'Done' };

  /** A plan saved as a Markdown file: its name and status, Open (preview), Edit (the file) and, in Plan mode, Approve
   *  (which reads the file, so your edits are what runs). */
  function fillPlanCard(e, m, canApprove) {
    const pl = m.plan;
    e.planCard.hidden = !pl;
    if (!pl) { e.planKey = ''; return; }
    const key = JSON.stringify([pl, canApprove && pl.status === 'draft']);
    if (e.planKey === key) return;
    e.planKey = key;
    e.planCard.replaceChildren(
      h('span', { class: 'plan-ic' }, icon('doc')),
      h('span', { class: 'plan-name', text: pl.name, title: pl.file }),
      h('span', { class: 'plan-status plan-' + pl.status, text: PLAN_STATUS[pl.status] || pl.status }),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', type: 'button', 'data-act': 'plan-open', title: 'Show the plan rendered beside the editor' }, icon('eye'), 'Open Preview'),
      h('button', { class: 'btn', type: 'button', 'data-act': 'plan-edit', title: 'Edit the plan file — Approve uses what the file says' }, icon('edit'), 'Edit'),
      canApprove && pl.status === 'draft'
        ? h('button', { class: 'btn primary', type: 'button', 'data-act': 'approve-plan', title: 'Start the work with this plan (read from the file) as the task list' }, icon('check'), 'Approve')
        : null);
  }

  /** The task list, pinned under the latest reply: ticks as it goes. */
  function renderTasks() {
    const list = Array.isArray(S.tasks) ? S.tasks : [];
    tasksBox.hidden = !list.length || !S.messages.length;
    if (tasksBox.hidden) { tasksBox.replaceChildren(); tasksBox._key = ''; return; }
    const done = list.filter((t) => t.status === 'done').length;
    const key = JSON.stringify([list, S.streaming]);
    if (tasksBox._key === key) return;
    tasksBox._key = key;
    const all = done === list.length;
    tasksBox.classList.toggle('all-done', all);
    const head = h('div', { class: 'tasks-head' }, icon('list'), h('span', { text: all ? `All ${list.length} tasks done` : 'Tasks' }),
      h('span', { class: 'grow' }), h('span', { class: 'tasks-count', text: `${done}/${list.length}` }));
    if (all && !S.streaming) { tasksBox.replaceChildren(head); return; }
    const rows = list.map((t) => h('li', { class: 'task task-' + t.status },
      t.status === 'done' ? icon('check', 'task-ic')
        : t.status === 'in_progress' ? (S.streaming ? spinner() : h('span', { class: 'task-dot now' }))
        : h('span', { class: 'task-dot' }),
      h('span', { class: 'task-text', text: t.content })));
    tasksBox.replaceChildren(head, h('ul', { class: 'tasks-list' }, rows));
  }

  /** Messages waiting to join the run. */
  function renderQueued() {
    const q = Array.isArray(S.queued) ? S.queued : [];
    queuedRow.hidden = !q.length;
    queuedRow.replaceChildren(...q.map((m) => h('div', { class: 'queued', role: 'listitem', title: m.text },
      h('span', { class: 'queued-label', text: 'Next step:' }),
      h('span', { class: 'queued-text', text: m.text }),
      h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Take this message back', title: 'Take it back', onclick: () => {
        post({ type: 'unqueue', id: m.id });
        if (!S.draft.trim()) prefill(m.text);
      } }, icon('close')))));
  }

  const PREVIEW_TOOLS = new Set(['write_file', 'edit_file', 'read_file', 'open_preview']);

  function fillTool(e, m) {
    const t = m.tool || { name: 'tool', title: 'Tool', detail: '', icon: '' };
    const denied = !!t.denied;
    const output = t.output != null ? String(t.output) : (m.content || '');
    const running = !denied && t.output == null && !m.content && S.streaming;
    const open = openTools.has(m.id);
    e.root.classList.toggle('denied', denied);
    e.root.classList.toggle('running', running);

    const key = [t.icon, t.title, t.detail, denied, running, open, t.auto || ''].join('\u0001');
    if (e.key !== key) {
      e.key = key;
      const title = denied ? `Denied: ${t.title || t.name}` : (t.title || t.name || 'Tool');
      e.head.replaceChildren(
        h('span', { class: 'tool-ic' }, icon(t.icon || t.name)),
        h('span', { class: 'tool-title', text: title }),
        h('span', { class: 'tool-detail', text: t.detail || '', title: t.detail || null }),
        t.auto ? h('span', { class: 'tool-auto', text: 'Auto approved', title: t.auto }) : null,
        running ? spinner() : icon('chevron', 'chev' + (open ? ' open' : '')));
      e.head.setAttribute('aria-expanded', open ? 'true' : 'false');
      e.head.setAttribute('aria-label', `${title}${t.detail ? ': ' + t.detail : ''}. ${open ? 'Hide' : 'Show'} output`);
    }
    // Files the assistant wrote, edited, read or showed get an Open Preview button.
    e.prev.hidden = denied || running || !PREVIEW_TOOLS.has(t.name) || !t.detail;
    e.prev.setAttribute('aria-label', 'Preview ' + (t.detail || ''));
    e.out.hidden = !open;
    if (open) setText(e.out, output || (running ? 'Running…' : denied ? 'You denied this step.' : 'No output.'));
  }

  function isNearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  }

  function stick(fn, force) {
    const was = force || isNearBottom();
    fn();
    if (was) scroller.scrollTop = scroller.scrollHeight;
  }

  function renderAllMessages() {
    list.replaceChildren();
    entries.clear();
    dirty.clear();
    const info = liveInfo();
    const frag = document.createDocumentFragment();
    for (const m of S.messages) {
      const e = createEntry(m);
      entries.set(m.id, e);
      fill(e, m, info);
      frag.append(e.root);
    }
    list.append(frag);
    renderEmpty();
    scroller.scrollTop = scroller.scrollHeight;
  }

  /** Cheap pass over every message for things that depend on position / streaming (footers, dots, spinners). */
  function refreshMeta() {
    const info = liveInfo();
    for (const m of S.messages) {
      const e = entries.get(m.id);
      if (e && e.role !== 'user') fill(e, m, info);
    }
  }

  function findMessage(id) {
    return S.messages.find((m) => m.id === id);
  }

  function addMessage(m) {
    if (!m || !m.id) return;
    if (findMessage(m.id)) { updateMessage(m); return; }
    stick(() => {
      S.messages.push(m);
      const e = createEntry(m);
      entries.set(m.id, e);
      list.append(e.root);
      if (e.role === 'user') fill(e, m, liveInfo());
      refreshMeta();
      renderEmpty();
    }, m.role === 'user');
  }

  function updateMessage(m) {
    if (!m || !m.id) return;
    const i = S.messages.findIndex((x) => x.id === m.id);
    if (i < 0) { addMessage(m); return; }
    dirty.delete(m.id);
    stick(() => {
      S.messages[i] = m;
      let e = entries.get(m.id);
      if (!e || e.role !== kindOf(m)) {
        const fresh = createEntry(m);
        if (e) e.root.replaceWith(fresh.root); else list.append(fresh.root);
        entries.set(m.id, fresh);
        e = fresh;
      }
      refreshMeta();
      if (e.role === 'user') fill(e, m, liveInfo());
    });
  }

  function deltaMessage(id, content, thinking) {
    const m = findMessage(id);
    if (!m) return;
    if (content) m.content = (m.content || '') + content;
    if (thinking) m.thinking = (m.thinking || '') + thinking;
    dirty.add(id);
    if (!flushTimer) flushTimer = setTimeout(flushDirty, THROTTLE_MS);
  }

  function flushDirty() {
    flushTimer = 0;
    if (!dirty.size) return;
    const info = liveInfo();
    stick(() => {
      for (const id of dirty) {
        const m = findMessage(id);
        const e = entries.get(id);
        if (m && e) fill(e, m, info);
      }
      dirty.clear();
    });
  }

  // Clicks inside messages: code block buttons, copy, regenerate, toggles.
  list.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !list.contains(btn)) return;
    const msgEl = btn.closest('.msg');
    const id = msgEl && msgEl.dataset.id;
    const act = btn.dataset.act;
    if (act === 'copy-code' || act === 'insert-code' || act === 'apply-code') {
      const cb = btn.closest('.cb');
      if (!cb) return;
      if (act === 'copy-code') copyText(cb._code, btn);
      else if (act === 'insert-code') { post({ type: 'insertCode', code: cb._code }); announce('Inserted at cursor'); }
      else post({ type: 'applyCode', code: cb._code, language: cb._lang || undefined });
      return;
    }
    const m = id && findMessage(id);
    if (!m) return;
    const e = entries.get(id);
    if (act === 'copy-msg') copyText(splitThinking(m.content, m.thinking).body, btn);
    else if (act === 'regen') post({ type: 'regenerate' });
    else if (act === 'toggle-think') {
      if (openThinking.has(id)) openThinking.delete(id); else openThinking.add(id);
      fill(e, m, liveInfo());
    } else if (act === 'toggle-tool') {
      if (openTools.has(id)) openTools.delete(id); else openTools.add(id);
      fill(e, m, liveInfo());
    } else if (act === 'undo-toggle') {
      if (openUndo.has(id)) { openUndo.delete(id); undoNotes.delete(id); } else {
        openUndo.add(id);
        if (!changesData.has(id)) { changesData.set(id, 'loading'); post({ type: 'runChanges', id }); }
      }
      fill(e, m, liveInfo());
    } else if (act === 'undo-go' || act === 'undo-force') {
      undoNotes.delete(id);
      post({ type: 'undoRun', id, force: act === 'undo-force' });
    } else if (act === 'chg-file' || act === 'chg-diff' || act === 'chg-open' || act === 'chg-preview') {
      const data = changesData.get(id);
      const i = Number(btn.dataset.i);
      const f = data && data !== 'loading' ? data.files[i] : null;
      if (!f) return;
      if (act === 'chg-diff') post({ type: 'showRunDiff', id, path: f.path });
      else if (act === 'chg-open') post({ type: 'openFile', path: f.path });
      else if (act === 'chg-preview') post({ type: 'previewFile', path: f.path });
      else {
        const k = id + '|' + i;
        if (openDiffs.has(k)) openDiffs.delete(k); else openDiffs.add(k);
        fill(e, m, liveInfo());
      }
    } else if (act === 'commit-draft') {
      commits.set(id, { phase: 'drafting', message: '' });
      post({ type: 'draftCommit', id });
      fill(e, m, liveInfo());
    } else if (act === 'commit-cancel') {
      commits.delete(id);
      fill(e, m, liveInfo());
    } else if (act === 'commit-go') {
      const c = commits.get(id);
      if (!c || !c.message.trim()) return;
      c.phase = 'committing'; c.error = '';
      post({ type: 'commit', id, message: c.message });
      fill(e, m, liveInfo());
    } else if (act === 'tool-preview') {
      if (m.tool && m.tool.detail) post({ type: 'previewFile', path: m.tool.detail });
    } else if (act === 'file-link') {
      post({ type: 'previewFile', path: btn.dataset.path || '' });
    } else if (act === 'plan-open' || act === 'plan-edit') {
      if (m.plan) post({ type: act === 'plan-open' ? 'openPlan' : 'editPlan', file: m.plan.file });
    } else if (act === 'approve-plan') {
      renderComposer();
      post({ type: 'approvePlan', id });
      stick(refreshMeta);
    } else if (act === 'toggle-summary') {
      if (openSummaries.has(id)) openSummaries.delete(id); else openSummaries.add(id);
      fill(e, m, liveInfo());
    }
  });

  function renderEmpty() {
    const isEmpty = S.messages.length === 0;
    empty.hidden = !isEmpty;
    list.hidden = isEmpty;
    const a = currentAssistant();
    const sides = !!(a && /hard/i.test(a.role || ''));
    const svg = empty.querySelector('.mark');
    if (svg && svg._sides !== sides) {
      const fresh = mark('empty-mark-svg', sides);
      fresh._sides = sides;
      svg.replaceWith(fresh);
    }
    if (a) setText(emptyName, `${a.name}${a.role ? ' · ' + a.role : ''}${a.model ? ' on ' + a.model : ''}`);
    else setText(emptyName, 'Local models, on your machine');
  }

  // ---------------------------------------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------------------------------------

  function autosize() {
    input.style.height = 'auto';
    const max = 200;
    const next = Math.min(input.scrollHeight, max);
    input.style.height = next + 'px';
    input.classList.toggle('scrolls', input.scrollHeight > max);
  }

  function renderComposer() {
    const a = currentAssistant();
    input.placeholder = `Ask ${a ? a.name : 'Ingle'} anything…`;
    const eff = EFFORTS.find(([id]) => id === S.effort) || EFFORTS[1];
    setText(effortLabel, eff[1]);
    effortPill.title = (S.effortHelp[eff[0]] || 'How hard the assistant tries') + ' Click to change.';
    effortPill.setAttribute('aria-label', `Effort: ${eff[1]}`);
    effortPill.classList.toggle('on', S.effort === 'high' || S.effort === 'max');
    for (const item of effortItems) {
      const id = item.getAttribute('data-effort');
      item.setAttribute('aria-checked', id === S.effort ? 'true' : 'false');
      setText(item.lastChild, (S.effortHelp[id] || '').replace(/^[A-Za-z]+: /, ''));
    }
    webPill.setAttribute('aria-pressed', S.web ? 'true' : 'false');
    webPill.classList.toggle('on', S.web);
    const m = modeInfo(S.workMode);
    setText(modeLabel, m.label);
    setText(modeRole, m.role);
    modePill.title = (m.help || 'How much the assistant may do without asking') + ' Click to change, or ⇧Tab in the message box.';
    modePill.setAttribute('aria-label', `Mode: ${m.label}`);
    for (const item of modeItems) {
      const id = item.getAttribute('data-mode');
      const info = modeInfo(id);
      item.setAttribute('aria-checked', id === S.workMode ? 'true' : 'false');
      setText(item.firstChild, info.label);
      setText(item.lastChild, (info.help || '').replace(/^[A-Za-z]+: /, ''));
    }
    modeBadge.hidden = S.workMode === 'ask';
    setText(modeBadge, m.label);
    modeBadge.title = m.help || '';
    renderSend();
  }

  function canSendNow() {
    if (S.attachments.some((a) => a.reading)) return false;
    return !!S.draft.trim() || S.attachments.length > 0;
  }

  function renderSend() {
    const canSend = canSendNow();
    sendBtn.classList.toggle('stop', S.streaming);
    sendBtn.classList.toggle('ready', S.streaming || canSend);
    sendBtn.disabled = !S.streaming && !canSend;
    const want = S.streaming ? 'stop' : 'send';
    if (sendBtn._icon !== want) {
      sendBtn._icon = want;
      sendBtn.replaceChildren(icon(want));
    }
    sendBtn.setAttribute('aria-label', S.streaming ? 'Stop' : 'Send');
    sendBtn.title = S.streaming ? 'Stop (Enter adds your message to the run instead)' : 'Send (Enter)';
    if (!hint.classList.contains('notice')) setText(hint, S.streaming ? STEER_HINT : HINT);
  }

  function send() {
    const text = S.draft.trim();
    if (!canSendNow()) return;
    if (S.streaming) {
      // Steer: the message waits and joins the run at the model's next step.
      if (S.attachments.length) { showNotice('Attach files once the reply has finished.'); return; }
      if (!text || text.startsWith('/')) { showNotice('Commands wait until the reply has finished.'); return; }
      post({ type: 'send', text });
      S.draft = '';
      input.value = '';
      saveState();
      autosize();
      renderSend();
      return;
    }
    if (text === '/compact' && !S.attachments.length) {
      post({ type: 'slash', name: 'compact' });
    } else {
      const files = S.attachments.map((a) => a.att);
      post(files.length ? { type: 'send', text, attachments: files } : { type: 'send', text });
      S.attachments = [];
      renderAttachments();
    }
    S.draft = '';
    input.value = '';
    saveState();
    autosize();
    renderSend();
    closeHistory(false);
  }

  function prefill(text) {
    S.draft = String(text || '');
    input.value = S.draft;
    saveState();
    autosize();
    renderSend();
    closeHistory(false);
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }

  // ----- Attachments -----

  const MAX_BYTES = 20 * 1024 * 1024;
  const MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
    json: 'application/json', html: 'text/html', htm: 'text/html', rtf: 'application/rtf',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text', pages: 'application/vnd.apple.pages',
    numbers: 'application/vnd.apple.numbers', key: 'application/vnd.apple.keynote',
  };
  let attachSeq = 0;

  function mimeFor(name, type) {
    if (type) return type;
    const ext = String(name || '').toLowerCase().split('.').pop();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
  }

  function isImage(a) {
    return /^image\//.test(a.mime || '') || /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i.test(a.name || '');
  }

  function fmtBytes(n) {
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  }

  let noticeTimer = 0;
  const attachNotice = h('p', { class: 'attach-notice', role: 'alert', hidden: true });
  function notice(text) {
    attachNotice.textContent = text;
    attachNotice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { attachNotice.hidden = true; }, 5000);
  }

  /** A small JPEG data URL for a decodable image (not HEIC — the engine makes those). */
  function makeThumbnail(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const max = 256;
          const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * scale));
          c.height = Math.max(1, Math.round(img.naturalHeight * scale));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.8));
        } catch { resolve(undefined); }
      };
      img.onerror = () => resolve(undefined);
      img.src = dataUrl;
    });
  }

  function addFiles(fileList) {
    for (const file of [...fileList]) {
      if (file.size > MAX_BYTES) {
        notice(`${file.name} is ${fmtBytes(file.size)} — files can be up to 20 MB.`);
        continue;
      }
      const item = {
        id: ++attachSeq,
        reading: true,
        att: { name: file.name || 'pasted-file', mime: mimeFor(file.name, file.type) },
      };
      if (!file.name && item.att.mime.startsWith('image/')) item.att.name = `pasted-image.${item.att.mime.split('/')[1] || 'png'}`;
      S.attachments.push(item);
      const reader = new FileReader();
      reader.onload = async () => {
        const url = String(reader.result || '');
        const comma = url.indexOf(',');
        item.att.dataBase64 = comma >= 0 ? url.slice(comma + 1) : '';
        if (isImage(item.att) && !/heic|heif/i.test(item.att.mime)) {
          const thumb = await makeThumbnail(url);
          if (thumb) item.att.thumbnail = thumb;
        }
        item.reading = false;
        renderAttachments();
        renderSend();
      };
      reader.onerror = () => {
        S.attachments = S.attachments.filter((x) => x !== item);
        notice(`Couldn’t read ${item.att.name}.`);
        renderAttachments();
        renderSend();
      };
      reader.readAsDataURL(file);
    }
    renderAttachments();
    renderSend();
  }

  function addAttachments(list) {
    for (const a of list || []) {
      if (!a || !a.name) continue;
      S.attachments.push({ id: ++attachSeq, reading: false, att: { ...a, mime: mimeFor(a.name, a.mime) } });
    }
    renderAttachments();
    renderSend();
    input.focus();
  }

  function renderAttachments() {
    attachRow.replaceChildren();
    for (const item of S.attachments) {
      const a = item.att;
      const img = isImage(a);
      const thumb = a.thumbnail && /^data:image\//.test(a.thumbnail)
        ? h('img', { class: 'att-thumb', src: a.thumbnail, alt: '' })
        : h('span', { class: 'att-icon' }, icon(img ? 'image' : 'doc'));
      const hint = item.reading ? 'reading…' : img && S.vision === false ? 'read as text' : '';
      attachRow.append(h('div', { class: 'att' + (item.reading ? ' reading' : ''), role: 'listitem', title: a.path || a.name },
        thumb,
        h('span', { class: 'att-text' },
          h('span', { class: 'att-name', text: a.name }),
          hint ? h('span', { class: 'att-hint', text: hint, title: hint === 'read as text' ? 'This model can’t see images, so Ingle will read the text in it instead.' : null }) : null),
        h('button', {
          class: 'att-x', type: 'button', 'aria-label': `Remove ${a.name}`, title: 'Remove',
          onclick: () => {
            S.attachments = S.attachments.filter((x) => x !== item);
            renderAttachments();
            renderSend();
            input.focus();
          },
        }, icon('close'))));
    }
    attachRow.append(attachNotice);
    attachRow.hidden = !S.attachments.length && attachNotice.hidden;
  }
  // The notice can show with no chips; keep the row visible while it does.
  new MutationObserver(() => { attachRow.hidden = !S.attachments.length && attachNotice.hidden; })
    .observe(attachNotice, { attributes: true, attributeFilter: ['hidden'] });

  clipBtn.addEventListener('click', () => post({ type: 'pickFiles' }));

  input.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  let dragDepth = 0;
  const hasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  composer.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    composer.classList.add('drop');
  });
  composer.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  composer.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) composer.classList.remove('drop');
  });
  composer.addEventListener('drop', (e) => {
    dragDepth = 0;
    composer.classList.remove('drop');
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });
  // Don't let a stray drop elsewhere navigate the webview away.
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (hasFiles(e) && !composer.contains(e.target)) e.preventDefault(); });

  // ----- Context meter -----

  function fmtTokens(n) {
    return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
  }

  function renderMeter() {
    const u = S.contextUsage;
    if (!u || !u.limit || u.limit <= 0) {
      meterBtn.hidden = true;
      closeMeter(false);
      return;
    }
    meterBtn.hidden = false;
    const frac = Math.max(0, Math.min(1, u.used / u.limit));
    const pct = Math.round(frac * 100);
    ring.querySelector('.ring-fg').setAttribute('stroke-dasharray', `${(frac * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`);
    setText(meterPct, `${pct}%`);
    meterBtn.classList.toggle('hot', frac > 0.75);
    const label = `Context ${pct}% full: about ${fmtTokens(u.used)} of ${fmtTokens(u.limit)} tokens`;
    meterBtn.setAttribute('aria-label', `${label}. Show options`);
    meterBtn.title = label;
    setText(meterText, `About ${fmtTokens(u.used)} of ${fmtTokens(u.limit)} tokens used (${pct}%).` +
      (frac > 0.75 ? ' Ingle will summarise older messages soon.' : ''));
    compactBtn.disabled = S.streaming;
  }

  let meterOpen = false;
  function openMeter() {
    meterOpen = true;
    meterPop.hidden = false;
    meterBtn.setAttribute('aria-expanded', 'true');
    compactBtn.focus();
  }
  function closeMeter(refocus) {
    if (!meterOpen) return;
    meterOpen = false;
    meterPop.hidden = true;
    meterBtn.setAttribute('aria-expanded', 'false');
    if (refocus) meterBtn.focus();
  }
  meterBtn.addEventListener('click', () => (meterOpen ? closeMeter(true) : openMeter()));
  compactBtn.addEventListener('click', () => {
    if (S.streaming) return;
    post({ type: 'compact' });
    closeMeter(false);
    input.focus();
  });
  document.addEventListener('mousedown', (e) => {
    if (meterOpen && !meterPop.contains(e.target) && !meterBtn.contains(e.target)) closeMeter(false);
  });

  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('input', () => {
    S.draft = input.value;
    saveState();
    autosize();
    renderSend();
    renderSlash();
  });
  input.addEventListener('keydown', (e) => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (slash.open) {
      const n = slash.items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); slash.index = (slash.index + 1) % n; paintSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slash.index = (slash.index - 1 + n) % n; paintSlash(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); slash.dismissed = true; renderSlash(); return; }
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); pickSlash(slash.items[slash.index]); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const q = S.draft.slice(1).toLowerCase();
        pickSlash(slash.items.find((it) => it.name.toLowerCase() === q) || slash.items[slash.index]);
        return;
      }
    }
    // ⇧Tab cycles the mode (Ask → Edit → Auto → Plan → Debug).
    if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setMode(MODE_IDS[(MODE_IDS.indexOf(S.workMode) + 1) % MODE_IDS.length], true);
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.altKey) return;
    e.preventDefault();
    send();
  });
  input.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== input) closeSlash(); }, 0); });
  input.addEventListener('focus', () => renderSlash());

  // ----- "/" menu -----

  const slash = { open: false, items: [], index: 0, dismissed: false };

  function slashMatches(q) {
    const items = Array.isArray(S.slashItems) ? S.slashItems : [];
    const groups = [];
    for (const kind of ['command', 'skill']) {
      const pre = [], mid = [];
      for (const it of items) {
        if (!it || it.kind !== kind || !it.name) continue;
        const name = it.name.toLowerCase();
        if (name.startsWith(q)) pre.push(it);
        else if (q && (name.includes(q) || String(it.detail || '').toLowerCase().includes(q))) mid.push(it);
      }
      groups.push(...pre, ...mid);
    }
    return groups;
  }

  function closeSlash() {
    if (!slash.open) return;
    slash.open = false;
    slashMenu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function renderSlash() {
    const d = S.draft;
    if (!d.startsWith('/')) slash.dismissed = false;
    const active = d.startsWith('/') && !/\s/.test(d) && !slash.dismissed && document.activeElement === input;
    const items = active ? slashMatches(d.slice(1).toLowerCase()) : [];
    if (!items.length) { closeSlash(); return; }
    const sameList = slash.open && items.length === slash.items.length && items.every((it, i) => it === slash.items[i]);
    slash.items = items;
    if (!sameList) slash.index = 0;
    slash.open = true;
    slashMenu.replaceChildren();
    let lastKind = '';
    items.forEach((it, i) => {
      if (it.kind !== lastKind) {
        lastKind = it.kind;
        slashMenu.append(h('div', { class: 'slash-group', role: 'presentation', text: it.kind === 'command' ? 'Commands' : 'Skills' }));
      }
      slashMenu.append(h('div', {
        class: 'slash-item', role: 'option', id: 'slash-opt-' + i, 'aria-selected': 'false', 'data-i': String(i),
        onmousedown: (e) => e.preventDefault(),
        onclick: () => pickSlash(it),
        onmousemove: () => { if (slash.index !== i) { slash.index = i; paintSlash(); } },
      }, h('span', { class: 'slash-name', text: '/' + it.name }), h('span', { class: 'slash-detail', text: it.detail || '' })));
    });
    slashMenu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    paintSlash();
  }

  function paintSlash() {
    for (const el of slashMenu.querySelectorAll('.slash-item')) {
      const on = Number(el.dataset.i) === slash.index;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        input.setAttribute('aria-activedescendant', el.id);
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function pickSlash(it) {
    if (!it) return;
    closeSlash();
    if (it.kind === 'command') {
      S.draft = '';
      input.value = '';
      saveState();
      autosize();
      renderSend();
      if (it.name === 'new') closeHistory(false);
      post({ type: 'slash', name: it.name });
    } else {
      prefill('/' + it.name + ' ');
    }
    input.focus();
  }

  // ----- /mcp dialog -----

  const MCP_STATE_LABEL = { connected: 'Connected', 'not-connected': 'Not connected', failed: 'Failed', off: 'Off' };
  let mcpReturnFocus = null;
  let mcpReloading = false;

  function renderMcp() {
    const servers = S.mcpServers;
    if (!servers) { mcpModal.hidden = true; return; }
    mcpList.replaceChildren();
    if (!servers.length) {
      mcpList.append(h('p', { class: 'mcp-empty' }, 'No MCP servers yet — add them to ', h('code', { text: '~/.ingle/mcp.json' })));
    }
    for (const sv of servers) {
      const st = MCP_STATE_LABEL[sv.state] ? sv.state : 'not-connected';
      const tools = Array.isArray(sv.tools) ? sv.tools : [];
      const shown = tools.slice(0, 12);
      mcpList.append(h('div', { class: 'mcp-row' + (sv.enabled === false || st === 'off' ? ' off' : '') },
        h('div', { class: 'mcp-top' },
          h('span', { class: 'dot dot-' + st, role: 'img', 'aria-label': MCP_STATE_LABEL[st], title: MCP_STATE_LABEL[st] }),
          h('span', { class: 'mcp-name', text: sv.name }),
          sv.source ? h('span', { class: 'mcp-src', text: 'from ' + sv.source }) : null),
        sv.detail ? h('p', { class: 'mcp-detail' + (st === 'failed' ? ' err' : ''), text: sv.detail }) : null,
        sv.command ? h('code', { class: 'mcp-cmd', title: sv.command, text: sv.command }) : null,
        tools.length ? h('div', { class: 'mcp-tools', 'aria-label': 'Tools' },
          shown.map((t) => h('span', { class: 'mcp-tool', text: t })),
          tools.length > shown.length ? h('span', { class: 'mcp-tool more', text: `+${tools.length - shown.length} more` }) : null) : null));
    }
    mcpReload.disabled = mcpReloading;
    mcpReload.replaceChildren(mcpReloading ? spinner() : icon('refresh'), h('span', { text: mcpReloading ? 'Reloading…' : 'Reload' }));
    const wasHidden = mcpModal.hidden;
    mcpModal.hidden = false;
    if (wasHidden) {
      mcpReturnFocus = document.activeElement;
      closeMenu(false);
      closeMeter(false);
      closeSlash();
      mcpCard.focus();
    }
  }

  function closeMcp() {
    if (!S.mcpServers) return;
    S.mcpServers = null;
    mcpReloading = false;
    mcpModal.hidden = true;
    const back = mcpReturnFocus && document.contains(mcpReturnFocus) ? mcpReturnFocus : input;
    back.focus();
  }

  mcpDone.addEventListener('click', closeMcp);
  mcpClose.addEventListener('click', closeMcp);
  mcpEdit.addEventListener('click', () => post({ type: 'openMcpConfig' }));
  mcpReload.addEventListener('click', () => {
    mcpReloading = true;
    post({ type: 'mcpRefresh' });
    renderMcp();
  });
  mcpModal.addEventListener('mousedown', (e) => { if (e.target === mcpModal) closeMcp(); });
  mcpModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMcp(); return; }
    if (e.key !== 'Tab') return;
    const f = [...mcpCard.querySelectorAll('button:not(:disabled), [tabindex="0"]')];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === mcpCard)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ----- Notice under the composer -----

  let hintTimer = 0;
  function showNotice(text) {
    if (!text) return;
    hint.textContent = String(text);
    hint.classList.add('notice');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hint.classList.remove('notice');
      hint.textContent = S.streaming ? STEER_HINT : HINT;
    }, 4000);
  }

  sendBtn.addEventListener('click', () => {
    if (S.streaming) post({ type: 'stop' });
    else send();
  });
  function modeInfo(id) {
    return (S.modes || []).find((x) => x.id === id) || { id, label: id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Ask', role: '', help: '' };
  }
  function setMode(id, announceIt) {
    if (!MODE_IDS.includes(id)) return;
    S.workMode = id;
    post({ type: 'setWorkMode', mode: id });
    renderComposer();
    stick(refreshMeta);
    if (announceIt) showNotice(`Mode: ${modeInfo(id).label} — ${(modeInfo(id).help || '').replace(/^[A-Za-z]+: /, '')}`);
  }
  let modeOpen = false;
  function openMode() {
    modeOpen = true;
    modePop.hidden = false;
    modePill.setAttribute('aria-expanded', 'true');
    (modeItems.find((i) => i.getAttribute('data-mode') === S.workMode) || modeItems[0]).focus();
  }
  function closeMode(refocus) {
    if (!modeOpen) return;
    modeOpen = false;
    modePop.hidden = true;
    modePill.setAttribute('aria-expanded', 'false');
    if (refocus) modePill.focus();
  }
  modePill.addEventListener('click', () => (modeOpen ? closeMode(true) : openMode()));
  for (const item of modeItems) {
    item.addEventListener('click', () => { setMode(item.getAttribute('data-mode'), false); closeMode(false); input.focus(); });
  }
  modePop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMode(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = modeItems.indexOf(document.activeElement);
    const n = modeItems.length;
    modeItems[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n].focus();
  });
  document.addEventListener('mousedown', (e) => {
    if (modeOpen && !modePop.contains(e.target) && !modePill.contains(e.target)) closeMode(false);
  });
  let effortOpen = false;
  function openEffort() {
    effortOpen = true;
    effortPop.hidden = false;
    effortPill.setAttribute('aria-expanded', 'true');
    const cur = effortItems.find((i) => i.getAttribute('data-effort') === S.effort) || effortItems[0];
    cur.focus();
  }
  function closeEffort(refocus) {
    if (!effortOpen) return;
    effortOpen = false;
    effortPop.hidden = true;
    effortPill.setAttribute('aria-expanded', 'false');
    if (refocus) effortPill.focus();
  }
  effortPill.addEventListener('click', () => (effortOpen ? closeEffort(true) : openEffort()));
  for (const item of effortItems) {
    item.addEventListener('click', () => {
      S.effort = item.getAttribute('data-effort');
      post({ type: 'setEffort', effort: S.effort });
      renderComposer();
      closeEffort(false);
      input.focus();
    });
  }
  effortPop.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = effortItems.indexOf(document.activeElement);
    const n = effortItems.length;
    effortItems[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n].focus();
  });
  document.addEventListener('mousedown', (e) => {
    if (effortOpen && !effortPop.contains(e.target) && !effortPill.contains(e.target)) closeEffort(false);
  });
  webPill.addEventListener('click', () => {
    S.web = !S.web;
    post({ type: 'toggle', key: 'web', value: S.web });
    renderComposer();
  });

  // Escape: close menu → close history → deny a pending approval.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (S.mcpServers) { e.preventDefault(); closeMcp(); return; }
    if (S.menuOpen) { e.preventDefault(); closeMenu(true); return; }
    if (meterOpen) { e.preventDefault(); closeMeter(true); return; }
    if (effortOpen) { e.preventDefault(); closeEffort(true); return; }
    if (S.historyOpen) { e.preventDefault(); closeHistory(true); return; }
    if (S.approval) {
      e.preventDefault();
      const id = S.approval.id;
      post({ type: 'approve', id, decision: 'deny' });
      S.approval = null;
      renderApproval();
      announce('Denied');
      input.focus();
    }
  });

  // When the view gets focus from VS Code, land in the message box.
  window.addEventListener('focus', () => {
    if (document.activeElement === document.body && !S.historyOpen && !S.menuOpen && !S.approval && !S.mcpServers) input.focus();
  });

  // ---------------------------------------------------------------------------------------------
  // Messages from the extension
  // ---------------------------------------------------------------------------------------------

  function applyInit(state) {
    if (!state) return;
    S.assistants = Array.isArray(state.assistants) ? state.assistants : [];
    S.currentAssistant = state.currentAssistant || (S.assistants[0] && S.assistants[0].id) || '';
    S.effort = ['low', 'medium', 'high', 'max'].includes(state.effort) ? state.effort : 'medium';
    S.effortHelp = state.effortHelp || {};
    S.web = !!state.web;
    S.useContext = state.useContext !== false;
    S.chats = Array.isArray(state.chats) ? state.chats : [];
    S.chatId = state.chatId || '';
    S.messages = Array.isArray(state.messages) ? state.messages.map((m) => ({ ...m })) : [];
    S.context = state.context;
    S.engine = state.engine || { state: 'ready', text: '' };
    S.vision = state.vision !== false;
    S.contextUsage = state.contextUsage || null;
    if (Array.isArray(state.slashItems)) S.slashItems = state.slashItems;
    S.tasks = Array.isArray(state.tasks) ? state.tasks : [];
    S.workMode = MODE_IDS.includes(state.workMode) ? state.workMode : 'ask';
    S.modes = Array.isArray(state.modes) ? state.modes : [];
    S.queued = Array.isArray(state.queued) ? state.queued : [];
    changesData.clear();
    openDiffs.clear();
    commits.clear();
    if (state.version) setText(versionLine, `Ingle for VS Code ${state.version} · Powered by Ollama · Free for personal use`);
    saveState();
    // A fresh init means a fresh chat view: nothing is streaming until the engine says so.
    S.streaming = false;
    S.activity = null;
    S.approval = null;
    openTools.clear();
    openThinking.clear();
    openSummaries.clear();
    renderHeader();
    renderBanner();
    renderAllMessages();
    renderTasks();
    renderQueued();
    renderActivity();
    renderApproval();
    renderChip();
    renderComposer();
    renderAttachments();
    renderMeter();
    if (S.historyOpen) renderHistory();
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'init': applyInit(msg.state); break;
      case 'messageAdd': addMessage(msg.message); break;
      case 'messageDelta': deltaMessage(msg.id, msg.content, msg.thinking); break;
      case 'messageUpdate': updateMessage(msg.message); break;
      case 'status': {
        const wasStreaming = S.streaming;
        S.streaming = !!msg.streaming;
        S.activity = msg.activity || null;
        if (!S.streaming && flushTimer) { clearTimeout(flushTimer); flushDirty(); }
        renderActivity();
        renderSend();
        renderMeter();
        if (wasStreaming !== S.streaming) stick(() => { refreshMeta(); renderTasks(); });
        break;
      }
      case 'tasks': S.tasks = Array.isArray(msg.tasks) ? msg.tasks : []; stick(renderTasks); break;
      case 'workMode': S.workMode = MODE_IDS.includes(msg.mode) ? msg.mode : 'ask'; renderComposer(); stick(refreshMeta); break;
      case 'queued': S.queued = Array.isArray(msg.items) ? msg.items : []; renderQueued(); break;
      case 'runChanges': {
        changesData.set(msg.id, { files: Array.isArray(msg.files) ? msg.files : [], repo: msg.repo || '', noCommit: msg.noCommit || '' });
        const m = findMessage(msg.id), e = entries.get(msg.id);
        if (m && e) stick(() => fill(e, m, liveInfo()));
        break;
      }
      case 'commitDraft': case 'commitFailed': {
        const c = commits.get(msg.id) || { phase: 'editing', message: '' };
        if (msg.type === 'commitDraft') { c.phase = 'editing'; c.message = String(msg.message || ''); c.error = ''; }
        else { c.phase = 'editing'; c.error = String(msg.message || ''); }
        commits.set(msg.id, c);
        const m = findMessage(msg.id), e = entries.get(msg.id);
        if (m && e) stick(() => fill(e, m, liveInfo()));
        break;
      }
      case 'approval': S.approval = msg.approval || null; stick(renderApproval); break;
      case 'approvalClear': S.approval = null; renderApproval(); break;
      case 'context': S.context = msg.context; renderChip(); break;
      case 'engine': S.engine = { state: msg.state, text: msg.text || '' }; renderBanner(); break;
      case 'chats':
        S.chats = Array.isArray(msg.chats) ? msg.chats : [];
        S.chatId = msg.chatId || S.chatId;
        saveState();
        if (S.historyOpen) renderHistory();
        break;
      case 'prefill': prefill(msg.text); break;
      case 'attachments': addAttachments(msg.attachments); break;
      case 'slashItems': S.slashItems = Array.isArray(msg.items) ? msg.items : []; renderSlash(); break;
      case 'mcp': S.mcpServers = Array.isArray(msg.servers) ? msg.servers : []; mcpReloading = false; renderMcp(); break;
      case 'notice': showNotice(msg.text); break;
      case 'undoRefused': {
        undoNotes.set(msg.id, { message: String(msg.message || ''), canForce: !!msg.canForce });
        openUndo.add(msg.id);
        const m = findMessage(msg.id), e = entries.get(msg.id);
        if (m && e) stick(() => fill(e, m, liveInfo()));
        break;
      }
      case 'secretPrompt': S.secretPrompt = msg; stick(renderSecretPrompt); break;
      case 'secretPromptClear': S.secretPrompt = null; renderSecretPrompt(); break;
      case 'contextUsage': S.contextUsage = { used: Number(msg.used) || 0, limit: Number(msg.limit) || 0 }; renderMeter(); break;
      default: break;
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------------------------

  input.value = S.draft;
  renderHeader();
  renderBanner();
  renderEmpty();
  renderActivity();
  renderChip();
  renderComposer();
  renderAttachments();
  renderMeter();
  autosize();
  post({ type: 'ready' });
})();
