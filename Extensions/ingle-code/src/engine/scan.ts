// The approximate path: outlines, symbol ranges and call sites worked out from text alone.
import { Language, matchDefinition } from './languages';
import { OutlineSymbol } from './types';

/** Blank out comments and string contents (keeping newlines and length) so braces and calls can be counted. */
export function codeMask(text: string, lang: Language): string {
  const out = text.split('');
  const n = text.length;
  const quoteChars = lang.id === 'rust' || lang.id === 'swift' ? ['"'] : lang.id === 'go' ? ['"', '`', "'"] : ['"', "'", '`'];
  const hashComment = lang.lineComment === '#';
  let i = 0;
  const blank = (from: number, to: number) => { for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = text[i];
    if (!hashComment && c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (hashComment && c === '#') { const e = text.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (!hashComment && c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
    if ((lang.id === 'swift' || lang.id === 'python') && c === '"' && text.startsWith('"""', i)) {
      const e = text.indexOf('"""', i + 3); const end = e < 0 ? n : e + 3; blank(i + 1, end - 1); i = end; continue;
    }
    if (lang.id === 'python' && c === "'" && text.startsWith("'''", i)) {
      const e = text.indexOf("'''", i + 3); const end = e < 0 ? n : e + 3; blank(i + 1, end - 1); i = end; continue;
    }
    if (quoteChars.includes(c) || (lang.id === 'python' && c === "'")) {
      // Blank the string, but keep interpolated code (Swift "\(x)", JS `${x}`) visible: it holds real calls.
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (lang.id === 'swift' && text[j] === '\\' && text[j + 1] === '(') {
          out[j] = ' ';
          j = skipBalanced(text, j + 1, '(', ')');
          continue;
        }
        if (c === '`' && text[j] === '$' && text[j + 1] === '{') {
          out[j] = ' ';
          j = skipBalanced(text, j + 1, '{', '}');
          continue;
        }
        if (text[j] === '\\') { if (out[j] !== '\n') out[j] = ' '; j++; }
        else if (text[j] === '\n' && c !== '`') break;
        if (j < n && out[j] !== '\n') out[j] = ' ';
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Index just past the bracket that closes the one at `open`. */
function skipBalanced(text: string, open: number, a: string, b: string): number {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === a) depth++;
    else if (text[k] === b) { depth--; if (depth === 0) return k + 1; }
    else if (text[k] === '\n' && a === '(') return k;
  }
  return text.length;
}

const FUNCTION_KINDS = new Set(['function', 'method', 'constructor']);
const VARIABLE_KINDS = new Set(['variable', 'constant', 'property', 'case']);

/** Symbols with line ranges from patterns and brace (or indent) matching. */
export function scanOutline(text: string, lang: Language): OutlineSymbol[] {
  const lines = text.split('\n');
  const masked = codeMask(text, lang).split('\n');
  const found: Array<OutlineSymbol & { col: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!masked[i].trim()) continue;
    const m = matchDefinition(lang, lines[i]);
    if (m) found.push({ name: m.name, kind: m.kind, startLine: i + 1, endLine: i + 1, depth: 0, col: m.col });
  }
  if (lang.blocks === 'braces') {
    for (let k = 0; k < found.length; k++) {
      const s = found[k];
      const next = found[k + 1]?.startLine ?? Number.MAX_SAFE_INTEGER;
      s.endLine = braceEnd(masked, s.startLine - 1, next - 1) ?? s.startLine;
    }
  } else {
    for (const s of found) {
      const indent = indentOf(lines[s.startLine - 1]);
      let end = s.startLine;
      for (let j = s.startLine; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (indentOf(lines[j]) <= indent) break;
        end = j + 1;
      }
      s.endLine = end;
    }
  }
  // Nesting: the innermost earlier symbol whose range contains this one.
  const stack: Array<OutlineSymbol> = [];
  const out: OutlineSymbol[] = [];
  for (const s of found) {
    while (stack.length && stack[stack.length - 1].endLine < s.startLine) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent && FUNCTION_KINDS.has(parent.kind) && (VARIABLE_KINDS.has(s.kind) || s.kind === 'symbol')) continue; // locals
    const sym: OutlineSymbol = { name: s.name, kind: s.kind, startLine: s.startLine, endLine: s.endLine, depth: stack.length };
    if (parent) sym.container = parent.name;
    out.push(sym);
    if (s.endLine > s.startLine) stack.push(sym);
  }
  return out;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The 1-based line of the brace that closes the block opened at or just after `startIdx`. */
function braceEnd(masked: string[], startIdx: number, nextDefIdx: number): number | undefined {
  let depth = 0;
  let opened = false;
  for (let i = startIdx; i < masked.length; i++) {
    if (!opened && (i > startIdx + 4 || (i >= nextDefIdx && i !== startIdx))) return undefined;
    const line = masked[i];
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (c === '{') { depth++; opened = true; }
      else if (c === '}') {
        depth--;
        if (opened && depth === 0) return i + 1;
      } else if (!opened && c === ';' && lineHasNoBraceAfter(line, k)) return undefined;
    }
  }
  return opened ? masked.length : undefined;
}

function lineHasNoBraceAfter(line: string, k: number): boolean {
  return !line.slice(k).includes('{');
}

/** Innermost function-like symbol that contains this 1-based line. */
export function enclosingFunction(outline: OutlineSymbol[], line: number): OutlineSymbol | undefined {
  let best: OutlineSymbol | undefined;
  for (const s of outline) {
    if (!FUNCTION_KINDS.has(s.kind)) continue;
    if (s.startLine <= line && line <= s.endLine) if (!best || s.startLine >= best.startLine) best = s;
  }
  return best;
}

/** Innermost symbol of any kind that contains the line (for containers like "MacTools"). */
export function enclosingSymbols(outline: OutlineSymbol[], line: number): OutlineSymbol[] {
  return outline.filter((s) => s.startLine <= line && line <= s.endLine).sort((a, b) => a.startLine - b.startLine);
}

/** Names called inside lines [startLine, endLine] (1-based), with the lines they're called on. */
export function scanCalls(text: string, lang: Language, startLine: number, endLine: number): Map<string, number[]> {
  const masked = codeMask(text, lang).split('\n');
  const out = new Map<string, number[]>();
  const re = /([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
  for (let i = startLine - 1; i < Math.min(endLine, masked.length); i++) {
    let line = masked[i];
    if (i === startLine - 1) {
      // Skip the declaration itself on its first line.
      const brace = line.indexOf('{');
      const colon = lang.blocks === 'indent' ? line.lastIndexOf(':') : -1;
      const cut = brace >= 0 ? brace + 1 : colon >= 0 ? colon + 1 : line.length;
      line = ' '.repeat(cut) + line.slice(cut);
    }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const name = m[1];
      if (lang.notCalls.includes(name) || /^\d/.test(name)) continue;
      const before = line.slice(0, m.index).trimEnd();
      if (/\b(func|function|def|fn)$/.test(before)) continue;
      const list = out.get(name) ?? [];
      if (!list.includes(i + 1)) list.push(i + 1);
      out.set(name, list);
    }
  }
  return out;
}

/** Does this line look like it calls `name` (as opposed to just mentioning it)? */
export function looksLikeCall(line: string, name: string, col0: number): boolean {
  const after = line.slice(col0 + name.length);
  return /^\s*(?:<[^<>()]*>)?\s*\(/.test(after) || /^\s*`/.test(after);
}
