// Repo map: a compact outline of the project — files and their key symbols — ranked by relevance to the
// current request, so a small local model knows where things are without reading every file.
// Like Aider's repo map, but with per-language patterns instead of tree-sitter (no dependencies).
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EXCLUDE_GLOB } from './files';
import { str, ToolDef } from './types';

const CODE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|swift|cs|py|go|rs|kt|kts|java|rb|php|dart|c|cc|cpp|h|hpp|m|mm|sql|prisma|graphql|gql|sh)$/i;
const MAX_FILES = 4000;
const MAX_BYTES = 300_000;
const MAX_SYMBOLS = 14;

interface FileInfo {
  abs: string;
  rel: string;
  mtime: number;
  symbols: string[];
  imports: string[]; // absolute paths of local files this one imports (best effort)
}

const cache = new Map<string, FileInfo>();
let listCache: { root: string; at: number; files: string[] } | undefined;
let gitCache: { root: string; at: number; changed: Set<string> } | undefined;

// MARK: symbol extraction

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'new', 'typeof', 'await', 'super', 'constructor', 'guard', 'init', 'self', 'this', 'when', 'match', 'with', 'using', 'lock', 'foreach', 'sizeof']);

function grab(text: string, re: RegExp, fmt: (m: RegExpExecArray) => string | undefined, out: string[]) {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < 60) {
    const s = fmt(m);
    if (s && !out.includes(s)) out.push(s);
  }
}

export function extractSymbols(ext: string, text: string): string[] {
  const out: string[] = [];
  const e = ext.toLowerCase();
  if (/^\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/.test(e)) {
    grab(text, /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
      (m) => (m[1].startsWith('function') ? `${m[2]}()` : m[1] === 'const' || m[1] === 'let' || m[1] === 'var' ? m[2] : `${m[1]} ${m[2]}`), out);
    grab(text, /^class\s+([A-Za-z_$][\w$]*)/gm, (m) => `class ${m[1]}`, out);
    // Public methods inside classes (2–4 spaces in); private ones are implementation detail.
    grab(text, /^ {2,4}(?!private |protected |#)(?:public |static |async |readonly |override |get |set )*([A-Za-z_$][\w$]*)\s*\([^)\n]*\)\s*(?::[^{\n]+)?\{/gm,
      (m) => (KEYWORDS.has(m[1]) ? undefined : `.${m[1]}()`), out);
    grab(text, /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, (m) => `${m[1]}()`, out);
    grab(text, /^\s*(?:export\s+)?(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)/gm, (m) => `${m[1].toUpperCase()} ${m[2]}`, out);
  } else if (e === '.swift') {
    // Types first, then non-private functions.
    grab(text, /^\s{0,4}(?:@\w+\s+)*(?:(?:public|fileprivate|internal|open|final|private)\s+)*(struct|class|enum|protocol|actor|extension|typealias)\s+([A-Za-z_][\w.]*)/gm,
      (m) => `${m[1]} ${m[2]}`, out);
    grab(text, /^\s{0,4}(?:@\w+\s+)*(?!.*\b(?:private|fileprivate)\b)(?:(?:public|internal|open|final|static|override|nonisolated|mutating)\s+)*func\s+([A-Za-z_]\w*)/gm,
      (m) => `${m[1]}()`, out);
  } else if (e === '.cs') {
    grab(text, /\b(class|interface|record|struct|enum)\s+([A-Za-z_]\w*)/g, (m) => `${m[1]} ${m[2]}`, out);
    grab(text, /^\s*(?:public|private|protected|internal)\s+(?:static\s+|async\s+|virtual\s+|override\s+|abstract\s+)*[\w<>[\],.? ]+\s+([A-Z]\w*)\s*\(/gm,
      (m) => (KEYWORDS.has(m[1].toLowerCase()) ? undefined : `${m[1]}()`), out);
  } else if (e === '.py') {
    grab(text, /^(class|def|async def)\s+([A-Za-z_]\w*)/gm, (m) => (m[1] === 'class' ? `class ${m[2]}` : `${m[2]}()`), out);
    grab(text, /^ {4}(?:async )?def\s+([A-Za-z_]\w*)/gm, (m) => (m[1].startsWith('__') ? undefined : `.${m[1]}()`), out);
  } else if (e === '.go') {
    grab(text, /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, (m) => `${m[1]}()`, out);
    grab(text, /^type\s+([A-Za-z_]\w*)\s+(struct|interface)/gm, (m) => `${m[2]} ${m[1]}`, out);
  } else if (e === '.rs') {
    grab(text, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl|mod)\s+([A-Za-z_][\w<>]*)/gm, (m) => (m[1] === 'fn' ? `${m[2]}()` : `${m[1]} ${m[2]}`), out);
  } else if (e === '.kt' || e === '.kts' || e === '.java') {
    grab(text, /\b(class|interface|object|enum class|record)\s+([A-Za-z_]\w*)/g, (m) => `${m[1]} ${m[2]}`, out);
    grab(text, /\bfun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/g, (m) => `${m[1]}()`, out);
    grab(text, /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>[\], ]+\s+([a-z]\w*)\s*\(/gm, (m) => (KEYWORDS.has(m[1]) ? undefined : `${m[1]}()`), out);
  } else if (e === '.rb') {
    grab(text, /^\s*(class|module|def)\s+([A-Za-z_][\w.:?!]*)/gm, (m) => (m[1] === 'def' ? `${m[2]}()` : `${m[1]} ${m[2]}`), out);
  } else if (e === '.php') {
    grab(text, /\b(class|interface|trait|function)\s+([A-Za-z_]\w*)/g, (m) => (m[1] === 'function' ? `${m[2]}()` : `${m[1]} ${m[2]}`), out);
  } else if (e === '.dart') {
    grab(text, /^\s*(class|mixin|enum|extension)\s+([A-Za-z_]\w*)/gm, (m) => `${m[1]} ${m[2]}`, out);
  } else if (e === '.sql') {
    grab(text, /\bcreate\s+(?:or\s+replace\s+)?(table|view|function|procedure|index)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi, (m) => `${m[1].toLowerCase()} ${m[2]}`, out);
  } else if (e === '.prisma') {
    grab(text, /^(model|enum)\s+(\w+)/gm, (m) => `${m[1]} ${m[2]}`, out);
  } else if (e === '.graphql' || e === '.gql') {
    grab(text, /^(type|input|enum|interface|query|mutation)\s+(\w+)/gm, (m) => `${m[1]} ${m[2]}`, out);
  } else if (/^\.(c|cc|cpp|h|hpp|m|mm)$/.test(e)) {
    grab(text, /^(?:class|struct)\s+(\w+)/gm, (m) => `class ${m[1]}`, out);
    grab(text, /^[A-Za-z_][\w\s*&:<>]*?\s\**([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm, (m) => (KEYWORDS.has(m[1]) ? undefined : `${m[1]}()`), out);
    grab(text, /^[-+]\s*\([^)]*\)\s*(\w+)/gm, (m) => `${m[1]}`, out);
  } else if (e === '.sh') {
    grab(text, /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/gm, (m) => `${m[1]}()`, out);
  }
  return out;
}

function extractImports(abs: string, text: string): string[] {
  const out: string[] = [];
  const dir = path.dirname(abs);
  const re = /(?:from\s+|require\(\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < 80) out.push(path.resolve(dir, m[1]));
  return out;
}

// MARK: indexing

async function listFiles(root: string): Promise<string[]> {
  if (listCache && listCache.root === root && Date.now() - listCache.at < 30_000) return listCache.files;
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === root);
  const pattern = folder ? new vscode.RelativePattern(folder, '**/*') : new vscode.RelativePattern(vscode.Uri.file(root), '**/*');
  const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, MAX_FILES * 3);
  const files = uris.map((u) => u.fsPath).filter((p) => CODE.test(p) && !/\.(min|bundle)\.js$|\.d\.ts$|[\\/](vendor|coverage|\.venv|venv|target|bin|obj)[\\/]/.test(p)).slice(0, MAX_FILES);
  listCache = { root, at: Date.now(), files };
  return files;
}

async function info(root: string, abs: string): Promise<FileInfo | undefined> {
  try {
    const st = await fs.promises.stat(abs);
    const hit = cache.get(abs);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (st.size > MAX_BYTES) {
      const fi = { abs, rel, mtime: st.mtimeMs, symbols: [], imports: [] };
      cache.set(abs, fi);
      return fi;
    }
    const text = await fs.promises.readFile(abs, 'utf8');
    const fi: FileInfo = { abs, rel, mtime: st.mtimeMs, symbols: extractSymbols(path.extname(abs), text), imports: extractImports(abs, text) };
    cache.set(abs, fi);
    return fi;
  } catch {
    return undefined;
  }
}

function gitChanged(root: string): Promise<Set<string>> {
  if (gitCache && gitCache.root === root && Date.now() - gitCache.at < 10_000) return Promise.resolve(gitCache.changed);
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain'], { cwd: root, timeout: 2000 }, (err, stdout) => {
      const changed = new Set<string>();
      if (!err) {
        for (const line of stdout.split('\n')) {
          const p = line.slice(3).trim().split(' -> ').pop();
          if (p) changed.add(path.resolve(root, p.replace(/^"|"$/g, '')));
        }
      }
      gitCache = { root, at: Date.now(), changed };
      resolve(changed);
    });
  });
}

function openTabs(): Set<string> {
  const out = new Set<string>();
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) if (t.input instanceof vscode.TabInputText) out.add(t.input.uri.fsPath);
  }
  return out;
}

function words(text: string): string[] {
  const split = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  const stop = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'can', 'you', 'please', 'what', 'how', 'why', 'fix', 'add', 'make', 'file', 'code', 'into', 'from', 'are', 'is', 'it', 'its', 'not', 'all', 'any', 'use', 'out', 'get', 'set', 'new', 'one', 'when', 'then', 'have', 'does', 'look', 'see', 'find', 'run', 'need', 'want', 'like', 'should', 'would', 'could', 'there', 'their', 'also', 'just', 'some']);
  return [...new Set(split.filter((w) => w.length >= 3 && !stop.has(w)))].slice(0, 40);
}

// MARK: the map

export interface RepoMapOptions {
  root: string;
  query?: string;          // the user's message or a focus phrase
  activeFile?: string;     // absolute path of the file in the editor
  under?: string;          // only files under this folder (absolute)
  budgetChars: number;
}

/** A ranked outline of the project that fits the budget, or '' if there's nothing to show. */
export async function buildRepoMap(o: RepoMapOptions): Promise<string> {
  let files = await listFiles(o.root);
  if (o.under) files = files.filter((f) => f === o.under || f.startsWith(o.under + path.sep));
  if (!files.length) return '';
  const infos = (await Promise.all(files.map((f) => info(o.root, f)))).filter((x): x is FileInfo => !!x);
  const changed = await gitChanged(o.root);
  const tabs = openTabs();
  const q = words(o.query ?? '');
  const active = o.activeFile ? cache.get(o.activeFile) : undefined;
  const activeImports = new Set((active?.imports ?? []).map(stripExt));
  const activeKey = o.activeFile ? stripExt(o.activeFile) : '';

  const scored = infos.map((f) => {
    let s = 0;
    if (f.abs === o.activeFile) s += 100;
    if (tabs.has(f.abs)) s += 40;
    if (changed.has(f.abs)) s += 30;
    const key = stripExt(f.abs);
    if (activeImports.has(key) || activeImports.has(path.dirname(key) + (path.basename(key) === 'index' ? '' : ''))) s += 25;
    if (activeKey && f.imports.some((i) => stripExt(i) === activeKey)) s += 20;
    const relLower = f.rel.toLowerCase();
    const symLower = f.symbols.join(' ').toLowerCase();
    for (const w of q) {
      if (relLower.includes(w)) s += 15;
      if (symLower.includes(w)) s += 8;
    }
    if (/(^|\/)(index|main|app|program|server|routes?|api)\.[a-z]+$/i.test(f.rel) || /App\.swift$/.test(f.rel)) s += 5;
    s -= f.rel.split('/').length;
    if (!f.symbols.length) s -= 5;
    return { f, s };
  }).sort((a, b) => b.s - a.s || a.f.rel.localeCompare(b.f.rel));

  // Folder overview so the model knows the shape even of what's left out.
  const folders = new Map<string, number>();
  for (const f of infos) {
    const top = f.rel.includes('/') ? f.rel.split('/').slice(0, f.rel.split('/').length > 2 ? 2 : 1).join('/') : '.';
    folders.set(top, (folders.get(top) ?? 0) + 1);
  }
  const overview = [...folders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d, n]) => `${d} (${n})`).join(', ');

  const lines: string[] = [];
  let used = overview.length + 200;
  let shown = 0;
  for (const { f } of scored) {
    const syms = f.symbols.slice(0, MAX_SYMBOLS).join(' · ') + (f.symbols.length > MAX_SYMBOLS ? ` · +${f.symbols.length - MAX_SYMBOLS}` : '');
    const entry = syms ? `${f.rel}\n  ${syms}` : f.rel;
    if (used + entry.length + 1 > o.budgetChars) {
      if (shown >= 3) break;
      continue;
    }
    lines.push(entry);
    used += entry.length + 1;
    shown++;
  }
  const rest = infos.length - shown;
  return [
    `${infos.length} code files. Folders: ${overview}.`,
    ...lines,
    rest > 0 ? `…and ${rest} more files (repo_map with a focus or folder shows others; find_files / search_code to locate things).` : '',
  ].filter(Boolean).join('\n');
}

function stripExt(p: string): string {
  return p.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, '');
}

// MARK: the tool

export const repoMapTool: ToolDef = {
  name: 'repo_map',
  description: 'Outline of the project: files and their key functions, classes and exports, most relevant first. Use it to find where things live before reading files. Optional focus (words about what you need) and folder.',
  parameters: {
    type: 'object',
    properties: {
      focus: { type: 'string', description: 'What you are looking for, e.g. "invoice totals" or "auth middleware"' },
      folder: { type: 'string', description: 'Only show this folder (relative to the project)' },
    },
    required: [],
  },
  readOnly: true,
  available: (ctx) => !!ctx.workspaceRoot,
  describe: (a) => ({ title: 'Map the project', detail: [str(a, 'focus'), str(a, 'folder')].filter(Boolean).join(' · ') || 'whole project', icon: 'folder' }),
  async run(a, ctx) {
    const root = ctx.workspaceRoot;
    if (!root) return 'No project folder is open.';
    ctx.setActivity('Mapping the project…');
    try {
      const folder = str(a, 'folder').trim();
      const under = folder ? path.resolve(root, folder) : undefined;
      if (under && !under.startsWith(root)) return 'That folder is outside the project.';
      const map = await buildRepoMap({ root, query: str(a, 'focus'), under, budgetChars: 16_000, activeFile: vscode.window.activeTextEditor?.document.uri.fsPath });
      return map || 'No code files found there.';
    } catch (e) {
      return 'Couldn’t map the project: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      ctx.setActivity(null);
    }
  },
};
