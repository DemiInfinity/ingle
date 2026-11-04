// Built-in code intelligence (task 33b), the part that doesn't need VS Code: loading the ingle-code engine
// (compiled into vendor/ingle-code by scripts/build-engine.js — imported directly, no MCP hop), one engine per
// workspace, the working set (what the user is working on) and the structured impact call for coverage (task 34).
// Tool names, arguments and output follow Extensions/ingle-code/TOOLS.md. The Mac app's CodeIntel.swift mirrors this.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type * as IC from '../../vendor/ingle-code/index';

/** The engine's tools offered as built-in tools (code_status stays MCP-only). Same list as CodeIntel.toolNames. */
export const CODE_INTEL_TOOLS = ['outline', 'definition', 'references', 'callers', 'callees', 'impact', 'diagnostics', 'read_exhaustively'] as const;
export type CodeIntelTool = (typeof CODE_INTEL_TOOLS)[number];
const SYMBOL_TOOLS = new Set<string>(['definition', 'references', 'callers', 'callees', 'impact']);

// MARK: engine

let lib: typeof IC | null | undefined;

/** The bundled engine, or undefined when it isn't there (a build without vendor/). Loaded on first use. */
export function loadEngineLib(): typeof IC | undefined {
  if (lib !== undefined) return lib ?? undefined;
  lib = null;
  // Walk up from this file to the extension folder (works from out/ and out-test/src/).
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const entry = path.join(dir, 'vendor', 'ingle-code', 'index.js');
    if (fs.existsSync(entry)) {
      try { lib = require(entry) as typeof IC; } catch { lib = null; }
      break;
    }
    dir = path.dirname(dir);
  }
  return lib ?? undefined;
}

const engines = new Map<string, IC.CodeEngine>();

/** One engine per workspace root, kept while the extension runs (its language servers stop when idle). */
export function engineFor(root: string, opts: { ollamaHost?: string } = {}): IC.CodeEngine | undefined {
  const l = loadEngineLib();
  if (!l) return undefined;
  let e = engines.get(root);
  if (!e) {
    try {
      e = new l.CodeEngine({ root, ollamaHost: opts.ollamaHost });
    } catch {
      return undefined;
    }
    engines.set(root, e);
  }
  return e;
}

/** Stops every engine and its language servers (extension deactivation). */
export async function disposeEngines(): Promise<void> {
  const all = [...engines.values()];
  engines.clear();
  await Promise.all(all.map((e) => e.dispose().catch(() => undefined)));
}

// MARK: working set

/** What the user is working on: open/selected files, files changed in git, files the chat mentions, and a
 *  selected symbol. Paths are relative to the workspace root. */
export interface WorkingSet {
  /** A symbol the user selected in the editor, if any. */
  selection?: string;
  /** The active editor's file. */
  activeFile?: string;
  open: string[];
  changed: string[];
  mentioned: string[];
}

export function workingSetFiles(ws: WorkingSet): string[] {
  const out: string[] = [];
  for (const f of [ws.activeFile, ...ws.changed, ...ws.open, ...ws.mentioned]) if (f && !out.includes(f)) out.push(f);
  return out;
}

const IDENT = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/** A selection that names one symbol (`runSubAgent`, `MacTools.approvalScope`, `foo()`), else undefined. */
export function symbolFromSelection(sel: string | undefined): string | undefined {
  const s = (sel ?? '').trim().replace(/\(\s*\)$/, '');
  return s.length > 0 && s.length <= 120 && IDENT.test(s) ? s : undefined;
}

const PATHISH = /(?:^|[\s`'"(\[])((?:[\w.@-]+\/)*[\w.@-]+\.(?:swift|tsx?|mts|cts|jsx?|mjs|cjs|py|pyi|go|rs))(?=$|[\s`'"),:\]])/g;

/** Source files a message names that exist in the workspace (relative paths, or a bare name found by `exists`). */
export function mentionedFiles(text: string, exists: (rel: string) => boolean): string[] {
  const out: string[] = [];
  PATHISH.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATHISH.exec(text))) {
    const p = m[1].replace(/^\.\//, '');
    if (!out.includes(p) && exists(p)) out.push(p);
  }
  return out;
}

/** Changed line ranges per file from `git diff -U0` output (new-side lines, 1-based, inclusive). */
export function parseDiffHunks(diff: string): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  let file: string | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? undefined : p.replace(/^b\//, '');
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      // A pure deletion (count 0) touches the line it happened after.
      const range: [number, number] = count === 0 ? [Math.max(1, start), Math.max(1, start)] : [start, start + count - 1];
      const list = out.get(file) ?? [];
      list.push(range);
      out.set(file, list);
    }
  }
  return out;
}

interface Sym { name: string; kind: string; startLine: number; endLine: number; container?: string }
const CODE_KINDS = new Set(['function', 'method', 'constructor', 'class', 'struct', 'interface', 'enum', 'protocol', 'property', 'field', 'variable', 'constant', 'type']);

/** The innermost symbols whose bodies contain the changed lines (a function, else its type), in file order. */
export function symbolsInRanges(items: Sym[], ranges: Array<[number, number]>): string[] {
  const out: string[] = [];
  for (const [a, b] of ranges) {
    const hits = items.filter((s) => CODE_KINDS.has(s.kind) && s.startLine <= b && s.endLine >= a);
    if (!hits.length) continue;
    // Innermost = the shortest range.
    hits.sort((x, y) => (x.endLine - x.startLine) - (y.endLine - y.startLine));
    const s = hits[0];
    const name = s.container && ['method', 'property', 'field', 'constructor'].includes(s.kind) ? `${s.container}.${baseName(s.name)}` : baseName(s.name);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function baseName(n: string): string {
  return n.replace(/\(.*$/, '');
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, maxBuffer: 8_000_000, timeout: 15_000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** Files changed since the last commit (modified, added, untracked), relative to the root. */
export async function gitChangedFiles(root: string): Promise<string[]> {
  const out = await git(root, ['status', '--porcelain', '-uall']);
  return out.split('\n').filter((l) => l.length > 3).map((l) => {
    const p = l.slice(3);
    const arrow = p.indexOf(' -> ');
    return (arrow >= 0 ? p.slice(arrow + 4) : p).replace(/^"|"$/g, '');
  });
}

/** Symbols touched by the uncommitted changes (from git diff and each file's outline), at most `limit`. */
export async function changedSymbols(engine: IC.CodeEngine, root: string, limit = 3): Promise<string[]> {
  const hunks = parseDiffHunks(await git(root, ['diff', '-U0', '--no-color', 'HEAD']));
  const out: string[] = [];
  for (const [file, ranges] of hunks) {
    if (out.length >= limit) break;
    if (!/\.(swift|tsx?|mts|cts|jsx?|mjs|cjs|py|pyi|go|rs)$/.test(file)) continue;
    try {
      const o = await engine.outline(file, { pageSize: 2000 });
      for (const s of symbolsInRanges(o.items, ranges)) if (!out.includes(s) && out.length < limit) out.push(s);
    } catch { /* deleted or unreadable */ }
  }
  return out;
}

// MARK: running a tool

/** Arguments the tool really runs with: missing symbol/file/paths filled in from the working set. Undefined
 *  `fill` = nothing to fill. Pure, so both apps' rules can be tested. */
export function defaultsFor(name: string, args: Record<string, unknown>, ws: WorkingSet): { args: Record<string, unknown>; note?: string } | { error: string } {
  const has = (k: string) => typeof args[k] === 'string' ? (args[k] as string).trim() !== '' : args[k] !== undefined && args[k] !== null;
  if (SYMBOL_TOOLS.has(name) && !has('symbol')) {
    const sel = symbolFromSelection(ws.selection);
    if (sel) return { args: { ...args, symbol: sel }, note: `(no symbol named: using the selection, ${sel})` };
    return { args };   // the caller tries the changed symbols next
  }
  if (name === 'outline' && !has('file')) {
    const f = ws.activeFile ?? workingSetFiles(ws)[0];
    if (!f) return { error: 'Missing argument: file (and there is no open or changed file to default to).' };
    return { args: { ...args, file: f }, note: `(no file named: outlining ${f}, from what you're working on)` };
  }
  if (name === 'diagnostics' && !has('paths')) {
    const files = workingSetFiles(ws).slice(0, 60);
    if (files.length) return { args: { ...args, paths: files }, note: `(no paths named: checking the working set — open, changed and mentioned files)` };
  }
  return { args };
}

/** Runs one code intelligence tool for the model. Never throws. Symbols, files and paths left out default to
 *  the working set; `impact` with no symbol covers every symbol the uncommitted changes touch (up to 3). */
export async function runCodeIntel(engine: IC.CodeEngine, name: string, rawArgs: Record<string, unknown>, ws: WorkingSet): Promise<string> {
  const l = loadEngineLib();
  if (!l) return 'Code intelligence isn’t bundled in this build. Use search_code and repo_map instead.';
  const args: Record<string, unknown> = { ...rawArgs };
  delete args.format;   // the model gets text; library callers use the typed result
  const d = defaultsFor(name, args, ws);
  if ('error' in d) return d.error;
  if (SYMBOL_TOOLS.has(name) && d.args.symbol === undefined) {
    const changed = await changedSymbols(engine, engine.root);
    if (!changed.length) {
      const files = workingSetFiles(ws);
      return `Missing argument: symbol. Nothing is selected and the uncommitted changes touch no symbol${files.length ? `; files you're working on: ${files.slice(0, 10).join(', ')}` : ''}. Name a symbol, or outline one of those files first.`;
    }
    const parts: string[] = [];
    for (const s of name === 'impact' ? changed : changed.slice(0, 1)) {
      const r = await l.callTool(engine, name, { ...d.args, symbol: s });
      parts.push(r.text);
    }
    return `(no symbol named: using what the uncommitted changes touch — ${changed.join(', ')})\n` + parts.join('\n\n');
  }
  const r = await l.callTool(engine, name, d.args);
  return d.note && !r.isError ? `${d.note}\n${r.text}` : r.text;
}

// MARK: structured impact (task 34)

export interface ImpactLocation { path: string; line: number }

/** Every place a change to `symbol` could affect, as workspace-relative paths and 1-based lines: each real use
 *  (comment/string-only text matches left out) and each caller's call lines. Sorted, no duplicates. For coverage
 *  checks (task 34). Same as CodeIntel.impact(_:) in Swift. */
export async function impactLocations(engine: IC.CodeEngine, symbol: string, opts: { file?: string } = {}): Promise<ImpactLocation[]> {
  const seen = new Set<string>();
  const out: ImpactLocation[] = [];
  const add = (p: string, line: number) => {
    const k = `${p}:${line}`;
    if (!seen.has(k)) { seen.add(k); out.push({ path: p, line }); }
  };
  const refs = await engine.references(symbol, { file: opts.file, pageSize: 100_000 });
  for (const r of refs.items) {
    if (r.inComment && r.exactness === 'approximate') continue;
    if (r.definition) continue;
    add(r.file, r.line);
  }
  try {
    const calls = await engine.callers(symbol, { file: opts.file, pageSize: 100_000 });
    for (const c of calls.items) for (const line of c.callLines) add(c.file, line);
  } catch { /* references alone */ }
  out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return out;
}
