// Ingle's previewer page (shared by the Mac app and the VS Code extension). Plain JS, no build step.
//
// Host → page: inglePreview.render(payload), or a window message { type: 'render', ...payload }.
//   payload: { kind, name, text, base, lang, editable, chrome, js }
//     kind     markdown | csv | tsv | json | yaml | code | image | svg | html
//     base     URL of the file's folder (ends in /), for relative images and the file itself
//     editable task-list ticks can be clicked (the host saves the file)
//     chrome   'vscode' shows the small bar (name, Source, JavaScript switch); the Mac app has its own
//     js       html only: run the page's scripts (VS Code renders HTML in a sandboxed frame)
// Page → host: { type: 'ready' } · { type: 'open', href } · { type: 'toggle', index, checked } · { type: 'source' }
//              · { type: 'js', on }
(function () {
  'use strict';
  const ROOT = (document.currentScript && document.currentScript.dataset.root) || './';
  let vscode = null;
  try { if (typeof acquireVsCodeApi === 'function') vscode = acquireVsCodeApi(); } catch { /* not in VS Code */ }

  function post(msg) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ingle) {
        window.webkit.messageHandlers.ingle.postMessage(msg);
      } else if (vscode) {
        vscode.postMessage(msg);
      }
    } catch { /* no host */ }
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------------ highlighting (same rules as CodeHighlight.swift)
  const KEYWORDS = new Set(('abstract as async await break case catch class const continue default defer delete do else enum export ' +
    'extends extension false final finally for func function go guard if impl implements import in init interface internal is let ' +
    'match mod mut namespace new nil null nullptr of override package private protected protocol pub public readonly return self ' +
    'Self sealed static struct super switch this throw throws trait true try type typeof undefined use using var void where while ' +
    'yield fn loop some any inout lazy weak unowned mutating fileprivate open repeat virtual volatile get set value record required ' +
    'with from select and def del elif except global lambda nonlocal not or pass raise None True False print then fi done esac ' +
    'local echo source').split(' '));
  const SQL = new Set(('select from where join left right inner outer full on group by order having limit offset insert into values ' +
    'update set delete create table index view drop alter add column primary key foreign references not null and or as distinct ' +
    'count sum avg min max case when then else end in is like between exists union all with desc asc default unique constraint ' +
    'returning begin commit rollback transaction').split(' '));
  const HASH = new Set(['python', 'py', 'bash', 'sh', 'zsh', 'shell', 'yaml', 'yml', 'ruby', 'rb', 'toml', 'dockerfile', 'makefile', 'r', 'perl', 'conf', 'ini']);
  const DASH = new Set(['sql', 'lua', 'haskell', 'hs', 'postgres', 'postgresql', 'mysql', 'sqlite']);
  const MARKUP = new Set(['html', 'xml', 'svg', 'jsx', 'tsx', 'vue', 'svelte', 'xaml', 'plist']);

  function highlight(code, language) {
    const lang = String(language || '').toLowerCase().trim();
    if (!code || code.length > 60000) return esc(code || '');
    const cls = new Array(code.length).fill('');
    const free = (a, b) => { for (let i = a; i < b; i++) if (cls[i]) return false; return true; };
    const paint = (a, b, c) => { if (b > a && free(a, b)) for (let i = a; i < b; i++) cls[i] = c; };
    const each = (re, c, group) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        if (group) {
          const off = m[0].indexOf(m[group]);
          if (off >= 0) paint(m.index + off, m.index + off + m[group].length, c);
        } else paint(m.index, m.index + m[0].length, c);
      }
    };
    each(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, 'c');
    if (HASH.has(lang)) each(/(^|\s)(#[^\n]*)/gm, 'c', 2);
    else if (DASH.has(lang)) each(/--[^\n]*/g, 'c');
    else if (lang !== 'css' && lang !== 'html') each(/\/\/[^\n]*/g, 'c');
    each(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, 's');
    if (MARKUP.has(lang)) {
      each(/<\/?[A-Za-z][\w:.-]*|\/?>/g, 'k');
      each(/\b[A-Za-z_:][\w:.-]*(?==)/g, 't');
    }
    if (lang === 'css' || lang === 'scss') each(/^\s*([a-z-]+)(?=\s*:)/gm, 't', 1);
    each(/\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g, 'n');
    const sql = DASH.has(lang);
    const words = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    let m;
    while ((m = words.exec(code))) {
      const a = m.index, b = a + m[0].length, w = m[0];
      if (sql) { if (SQL.has(w.toLowerCase())) paint(a, b, 'k'); continue; }
      if (KEYWORDS.has(w)) { paint(a, b, 'k'); continue; }
      let j = b;
      while (code.charCodeAt(j) === 32) j++;
      if (code[j] === '(') { paint(a, b, 'f'); continue; }
      if (w.length > 1 && /[A-Z]/.test(w[0])) paint(a, b, 't');
    }
    let out = '', cur = '', run = '';
    const flush = () => { if (run) out += cur ? `<span class="h${cur}">${esc(run)}</span>` : esc(run); run = ''; };
    for (let i = 0; i < code.length; i++) {
      if (cls[i] !== cur) { flush(); cur = cls[i]; }
      run += code[i];
    }
    flush();
    return out;
  }

  // ------------------------------------------------------------------ lazy libraries (served next to this page)
  const loaded = {};
  function load(file) {
    if (!loaded[file]) {
      loaded[file] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = ROOT + 'vendor/' + file;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Couldn’t load ' + file));
        document.head.appendChild(s);
      });
    }
    return loaded[file];
  }

  function mathHTML(tex, display) {
    try {
      // eslint-disable-next-line no-undef
      return temml.renderToString(tex, { displayMode: display, throwOnError: false });
    } catch (e) {
      return `<code class="math-error">${esc(tex)}</code>`;
    }
  }

  // ------------------------------------------------------------------ Markdown
  let configured = false;
  function setupMarked() {
    if (configured) return;
    configured = true;
    const mathBlock = {
      name: 'mathBlock', level: 'block',
      start(src) { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
      },
      renderer(t) { return `<div class="math">${mathHTML(t.text, true)}</div>`; },
    };
    const mathInline = {
      name: 'mathInline', level: 'inline',
      start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const d = /^\$\$([^$]+?)\$\$/.exec(src);
        if (d) return { type: 'mathInline', raw: d[0], text: d[1], display: true };
        const m = /^\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1], display: false };
      },
      renderer(t) { return mathHTML(t.text, t.display); },
    };
    // eslint-disable-next-line no-undef
    marked.use({
      gfm: true,
      extensions: [mathBlock, mathInline],
      renderer: {
        code(token) {
          const lang = String(token.lang || '').split(/\s/)[0].toLowerCase();
          const text = token.text || '';
          if (lang === 'mermaid') return `<div class="mermaid">${esc(text)}</div>`;
          if (lang === 'math' || lang === 'latex' || lang === 'tex') return `<div class="math">${mathHTML(text, true)}</div>`;
          return `<pre class="code"><code data-lang="${esc(lang)}">${highlight(text, lang)}</code></pre>`;
        },
      },
    });
  }

  /** Raw HTML in Markdown is shown, but never runs: no scripts, frames, handlers or javascript: links. */
  const DROP = new Set(['SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'PORTAL']);
  function sanitise(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const doomed = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (DROP.has(n.tagName.toUpperCase())) { doomed.push(n); continue; }
      for (const a of Array.from(n.attributes)) {
        const name = a.name.toLowerCase();
        const v = a.value.replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' ||
            ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action') && (v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html')))) {
          n.removeAttribute(a.name);
        }
      }
    }
    doomed.forEach((n) => n.remove());
  }

  function frontMatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) return { meta: null, body: text };
    const meta = [];
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) {
        let v = line.slice(i + 1).trim();
        if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { /* keep as written */ } }
        meta.push([line.slice(0, i).trim(), v]);
      }
    }
    return { meta, body: text.slice(m[0].length) };
  }

  const isRelative = (u) => u && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('#') && !u.startsWith('//');

  async function renderMarkdown(p, out) {
    const { meta, body } = frontMatter(p.text);
    if (/\$[^\s$]|```\s*(math|latex|tex)\b/.test(body)) { try { await load('temml.min.js'); } catch { /* shown as code */ } }
    setupMarked();
    // eslint-disable-next-line no-undef
    const html = marked.parse(body);
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    sanitise(tpl.content);
    const doc = document.createElement('article');
    doc.className = 'markdown';
    if (meta && meta.length) {
      const box = document.createElement('dl');
      box.className = 'front';
      for (const [k, v] of meta) box.insertAdjacentHTML('beforeend', `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`);
      doc.appendChild(box);
    }
    doc.appendChild(tpl.content);
    // Relative images come from the file's folder.
    doc.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (isRelative(src)) img.setAttribute('src', p.base + src.replace(/^\.\//, ''));
    });
    // Task lists: ticks follow the file; clicking one changes the file (when the host allows it).
    doc.querySelectorAll('input[type=checkbox]').forEach((box, index) => {
      box.disabled = !p.editable;
      box.dataset.index = String(index);
      const li = box.closest('li');
      if (li) { li.classList.add('task'); if (box.checked) li.classList.add('done'); }
    });
    out.replaceChildren(doc);
    const diagrams = doc.querySelectorAll('.mermaid');
    if (diagrams.length) {
      try {
        await load('mermaid.min.js');
        /* global mermaid */
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: '-apple-system, system-ui, sans-serif',
          themeVariables: {
            darkMode: true, background: '#1C1618', primaryColor: '#3A2C31', primaryTextColor: '#F3E6DE', primaryBorderColor: '#FF9F6B',
            lineColor: '#A8999D', secondaryColor: '#2D2327', tertiaryColor: '#251C20', textColor: '#F3E6DE', mainBkg: '#3A2C31',
            nodeBorder: '#FF9F6B', clusterBkg: '#251C20', clusterBorder: '#7A6C70', noteBkgColor: '#2D2327', noteTextColor: '#F3E6DE',
            edgeLabelBackground: '#2D2327', actorBkg: '#3A2C31', actorBorder: '#FF9F6B', actorTextColor: '#F3E6DE', signalColor: '#A8999D',
          },
        });
        for (const d of diagrams) {
          const source = d.textContent || '';
          try {
            const { svg } = await mermaid.render('m' + Math.random().toString(36).slice(2), source);
            d.innerHTML = svg;
          } catch (e) {
            d.innerHTML = `<p class="error">Couldn’t draw this diagram: ${esc(e && e.message ? e.message : e)}</p><pre class="code"><code>${esc(source)}</code></pre>`;
          }
        }
      } catch (e) {
        diagrams.forEach((d) => d.insertAdjacentHTML('afterbegin', `<p class="error">${esc(e.message)}</p>`));
      }
    }
  }

  // ------------------------------------------------------------------ CSV / TSV
  function parseDelimited(text, sep) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
      } else if (c === '"' && field === '') quoted = true;
      else if (c === sep) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const MAX_ROWS = 5000;
  function renderTable(p, out) {
    const rows = parseDelimited(p.text, p.kind === 'tsv' ? '\t' : ',').filter((r) => !(r.length === 1 && r[0] === ''));
    if (!rows.length) { out.innerHTML = '<p class="empty">This file is empty.</p>'; return; }
    const head = rows[0];
    const data = rows.slice(1).map((r, i) => ({ r, i }));
    let sortCol = -1, asc = true;
    const wrap = document.createElement('div');
    wrap.className = 'table';
    const note = document.createElement('p');
    note.className = 'note';
    const draw = () => {
      const shown = data.slice(0, MAX_ROWS);
      const width = Math.max(head.length, ...shown.map((d) => d.r.length));
      let h = '<table><thead><tr>';
      for (let c = 0; c < width; c++) {
        const arrow = c === sortCol ? (asc ? ' ▲' : ' ▼') : '';
        h += `<th data-col="${c}" title="Sort">${esc(head[c] ?? '')}${arrow}</th>`;
      }
      h += '</tr></thead><tbody>';
      for (const d of shown) {
        h += '<tr>';
        for (let c = 0; c < width; c++) {
          const v = d.r[c] ?? '';
          h += `<td${/^-?[\d,.]+%?$/.test(v.trim()) ? ' class="num"' : ''}>${esc(v)}</td>`;
        }
        h += '</tr>';
      }
      wrap.innerHTML = h + '</tbody></table>';
      note.textContent = `${data.length} row${data.length === 1 ? '' : 's'} · ${head.length} column${head.length === 1 ? '' : 's'}` +
        (data.length > MAX_ROWS ? ` · showing the first ${MAX_ROWS}` : '') + ' · click a heading to sort';
    };
    wrap.addEventListener('click', (e) => {
      const th = e.target.closest('th');
      if (!th) return;
      const c = Number(th.dataset.col);
      asc = sortCol === c ? !asc : true;
      sortCol = c;
      const num = (s) => { const n = Number(String(s).replace(/[,%\s]/g, '')); return s !== '' && !Number.isNaN(n) ? n : null; };
      data.sort((a, b) => {
        const x = a.r[c] ?? '', y = b.r[c] ?? '';
        const nx = num(x), ny = num(y);
        const r = nx !== null && ny !== null ? nx - ny : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
        return (asc ? r : -r) || a.i - b.i;
      });
      draw();
    });
    draw();
    out.replaceChildren(note, wrap);
  }

  // ------------------------------------------------------------------ JSON / YAML trees
  function tree(value, key, depth) {
    const label = key === undefined ? '' : `<span class="key">${esc(key)}</span>: `;
    if (value === null || typeof value !== 'object') {
      const t = value === null ? 'null' : typeof value;
      const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
      return `<div class="leaf">${label}<span class="v-${t}">${esc(shown)}</span></div>`;
    }
    const isArr = Array.isArray(value);
    const entries = isArr ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    const summary = isArr ? `[${entries.length}]` : `{${entries.length}}`;
    if (!entries.length) return `<div class="leaf">${label}<span class="v-null">${isArr ? '[]' : '{}'}</span></div>`;
    const shown = entries.slice(0, 2000);
    const more = entries.length > shown.length ? `<div class="leaf note">… ${entries.length - shown.length} more</div>` : '';
    return `<details${depth < 2 ? ' open' : ''}><summary>${label}<span class="count">${summary}</span></summary>` +
      shown.map(([k, v]) => tree(v, k, depth + 1)).join('') + more + '</details>';
  }

  /** A small YAML reader: block maps and lists, scalars, quoted strings, flow [a, b] / {a: b}, | and > blocks, comments. */
  function parseYAML(text) {
    const lines = text.replace(/\t/g, '  ').split(/\r?\n/);
    const docs = [];
    let i = 0;
    const strip = (s) => {
      let q = '';
      for (let j = 0; j < s.length; j++) {
        const c = s[j];
        if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c;
        else if (c === '#' && (j === 0 || /\s/.test(s[j - 1]))) return s.slice(0, j).trimEnd();
      }
      return s.trimEnd();
    };
    const indentOf = (s) => s.length - s.trimStart().length;
    const skip = () => { while (i < lines.length && (strip(lines[i]).trim() === '' )) i++; };
    function scalar(s) {
      s = s.trim();
      if (s === '' || s === '~' || s === 'null') return null;
      if (s === 'true' || s === 'True') return true;
      if (s === 'false' || s === 'False') return false;
      if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
      if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
      if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
      if (s.startsWith('[') || s.startsWith('{')) return flow(s);
      return s;
    }
    function flow(s) {
      let k = 0;
      const ws = () => { while (/\s/.test(s[k])) k++; };
      function val() {
        ws();
        if (s[k] === '[') {
          k++; const a = [];
          for (;;) { ws(); if (s[k] === ']') { k++; return a; } a.push(val()); ws(); if (s[k] === ',') k++; else if (s[k] === ']') { k++; return a; } else throw new Error('Bad list'); }
        }
        if (s[k] === '{') {
          k++; const o = {};
          for (;;) {
            ws(); if (s[k] === '}') { k++; return o; }
            const key = atom(':'); k++; o[String(key)] = val(); ws();
            if (s[k] === ',') k++; else if (s[k] === '}') { k++; return o; } else throw new Error('Bad map');
          }
        }
        return atom(',]}');
      }
      function atom(stops) {
        ws();
        if (s[k] === '"' || s[k] === "'") {
          const q = s[k]; let j = k + 1;
          while (j < s.length && !(s[j] === q && s[j - 1] !== '\\')) j++;
          const raw = s.slice(k, j + 1); k = j + 1; return scalar(raw);
        }
        let j = k;
        while (j < s.length && !stops.includes(s[j])) j++;
        const raw = s.slice(k, j); k = j; return scalar(raw);
      }
      return val();
    }
    function block(style, indent) {
      const out = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() !== '' && indentOf(l) < indent) break;
        out.push(l.slice(indent));
        i++;
      }
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      return style.startsWith('|') ? out.join('\n') + '\n' : out.join(' ').replace(/\s+/g, ' ') + '\n';
    }
    function node(indent) {
      skip();
      if (i >= lines.length) return null;
      const first = strip(lines[i]);
      const ind = indentOf(first);
      if (ind < indent) return null;
      const t = first.trim();
      if (t === '---' || t === '...') return null;
      if (t === '-' || t.startsWith('- ')) return list(ind);
      if (/^("[^"]*"|'[^']*'|[^\s#][^:]*?):(\s|$)/.test(t)) return map(ind);
      i++;
      return scalar(t);
    }
    function list(ind) {
      const a = [];
      for (;;) {
        skip();
        if (i >= lines.length) break;
        const l = strip(lines[i]);
        if (indentOf(l) !== ind || !(l.trim() === '-' || l.trim().startsWith('- '))) break;
        const rest = l.trim().slice(1).trimStart();
        if (rest === '') { i++; a.push(node(ind + 1)); continue; }
        // "- key: value" starts a map inside the item: treat the dash as indentation.
        const inner = ind + (l.trim().length - rest.length) ;
        lines[i] = ' '.repeat(inner) + rest;
        if (/^("[^"]*"|'[^']*'|[^\s#\[{"'][^:]*?):(\s|$)/.test(rest)) a.push(map(inner));
        else if (rest.startsWith('- ')) a.push(list(inner));
        else { i++; a.push(rest.startsWith('|') || rest.startsWith('>') ? block(rest, inner + 1) : scalar(rest)); }
      }
      return a;
    }
    function map(ind) {
      const o = {};
      for (;;) {
        skip();
        if (i >= lines.length) break;
        const l = strip(lines[i]);
        if (indentOf(l) !== ind) break;
        const t = l.trim();
        const m = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(t);
        if (!m || t.startsWith('- ')) break;
        const key = String(scalar(m[1]));
        const rest = (m[2] || '').trim();
        i++;
        if (rest === '') {
          skip();
          const next = i < lines.length ? strip(lines[i]) : '';
          const ni = indentOf(next);
          if (i < lines.length && (ni > ind || (ni === ind && next.trim().startsWith('- ')))) o[key] = node(ni);
          else o[key] = null;
        } else if (rest.startsWith('|') || rest.startsWith('>')) {
          const next = lines.slice(i).find((x) => x.trim() !== '');
          o[key] = block(rest, next ? indentOf(next) : ind + 2);
        } else o[key] = scalar(rest);
      }
      return o;
    }
    for (;;) {
      skip();
      if (i >= lines.length) break;
      if (strip(lines[i]).trim() === '---') { i++; continue; }
      const start = i;
      docs.push(node(0));
      if (i === start) throw new Error(`Couldn’t read line ${i + 1}`);
    }
    return docs.length === 1 ? docs[0] : docs;
  }

  function renderTree(p, out) {
    let value;
    try {
      value = p.kind === 'json' ? JSON.parse(p.text) : parseYAML(p.text);
    } catch (e) {
      out.innerHTML = `<p class="error">Couldn’t read this as ${p.kind.toUpperCase()}: ${esc(e.message)}. Showing the text.</p>` +
        `<pre class="code"><code>${highlight(p.text, p.kind)}</code></pre>`;
      return;
    }
    out.innerHTML = `<div class="tree">${tree(value, undefined, 0)}</div>`;
  }

  // ------------------------------------------------------------------ HTML (VS Code: sandboxed frame; the Mac app loads it itself)
  function renderHTML(p, out) {
    const frame = document.createElement('iframe');
    frame.className = 'page';
    // Scripts only when switched on; never same-origin, so the page can't reach this one or the host.
    frame.setAttribute('sandbox', p.js ? 'allow-scripts' : '');
    const baseTag = `<base href="${esc(p.base)}">`;
    const text = /<head[^>]*>/i.test(p.text) ? p.text.replace(/<head[^>]*>/i, (h) => h + baseTag) : baseTag + p.text;
    frame.srcdoc = text;
    out.replaceChildren(frame);
  }

  // ------------------------------------------------------------------ entry point
  let last = null;
  let busy = Promise.resolve();
  const out = () => document.getElementById('out');

  function chrome(p) {
    const bar = document.getElementById('bar');
    bar.hidden = p.chrome !== 'vscode';
    if (bar.hidden) return;
    document.getElementById('name').textContent = p.name || '';
    const banner = document.getElementById('banner');
    banner.hidden = p.kind !== 'html';
    document.getElementById('js').textContent = p.js ? 'JavaScript on' : 'JavaScript off';
    document.getElementById('source').hidden = !p.editable && p.kind === 'image';
  }

  async function draw(p) {
    const el = out();
    const y = last && last.name === p.name ? window.scrollY : 0;
    document.body.dataset.kind = p.kind;
    chrome(p);
    switch (p.kind) {
      case 'markdown': await renderMarkdown(p, el); break;
      case 'csv': case 'tsv': renderTable(p, el); break;
      case 'json': case 'yaml': renderTree(p, el); break;
      case 'image': case 'svg':
        // As an image, an SVG's scripts never run.
        el.innerHTML = `<div class="image"><img alt="${esc(p.name)}" src="${esc(p.base + encodeURIComponent(p.name))}${p.stamp ? '?v=' + esc(p.stamp) : ''}"></div>`;
        break;
      case 'html': renderHTML(p, el); break;
      default:
        el.innerHTML = `<pre class="code lines"><code>${highlight(p.text, p.lang || '')}</code></pre>`;
    }
    last = p;
    window.scrollTo(0, y);
  }

  function render(p) {
    busy = busy.then(() => draw(p)).catch((e) => { out().innerHTML = `<p class="error">${esc(e && e.message ? e.message : e)}</p>`; });
    return busy;
  }

  window.inglePreview = { render };
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.type === 'render' && e.source !== document.querySelector('iframe')?.contentWindow) render(d);
  });

  document.addEventListener('click', (e) => {
    const box = e.target.closest && e.target.closest('input[type=checkbox][data-index]');
    if (box) {
      if (!last || !last.editable) { e.preventDefault(); return; }
      const li = box.closest('li');
      if (li) li.classList.toggle('done', box.checked);
      post({ type: 'toggle', index: Number(box.dataset.index), checked: box.checked });
      return;
    }
    if (e.target.id === 'source') { post({ type: 'source' }); return; }
    if (e.target.id === 'js' && last) { post({ type: 'js', on: !last.js }); return; }
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) return;   // in-page anchors scroll as usual
    e.preventDefault();
    post({ type: 'open', href });
  });

  document.addEventListener('DOMContentLoaded', () => post({ type: 'ready' }));
})();
