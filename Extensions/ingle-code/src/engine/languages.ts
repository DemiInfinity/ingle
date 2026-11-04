// Languages ingle-code knows: file extensions, the language servers to look for, and the patterns the
// approximate scan uses when no server is installed.
import * as path from 'node:path';
import { escapeRegExp } from './util';

export interface ServerCandidate {
  cmd: string;
  args: string[];
}

interface DefPattern {
  /** Regex source with NAME where the identifier goes and an optional (?<kw>…) group. */
  src: string;
  /** Kind when there's no kw group. */
  kind?: string;
}

export interface Language {
  id: string;
  name: string;
  extensions: string[];
  /** LSP languageId per extension. */
  lspIds: Record<string, string>;
  servers: ServerCandidate[];
  defs: DefPattern[];
  blocks: 'braces' | 'indent';
  /** Words that can precede "(" but are not calls. */
  notCalls: string[];
  lineComment: string;
}

const IDENT = '[A-Za-z_$][\\w$]*';

const SWIFT_MODS = '(?:@\\w+(?:\\([^)]*\\))?\\s+)*(?:(?:public|private|fileprivate|internal|open|package|static|class|final|override|mutating|nonmutating|convenience|required|lazy|weak|unowned|nonisolated|dynamic|indirect|async|distributed)(?:\\([^)]*\\))?\\s+)*';
const TS_MODS = '(?:(?:public|private|protected|static|async|readonly|override|abstract|declare|get|set|accessor)\\s+)*';

export const LANGUAGES: Language[] = [
  {
    id: 'swift', name: 'Swift', extensions: ['.swift'], lspIds: { '.swift': 'swift' },
    servers: [{ cmd: 'sourcekit-lsp', args: [] }],
    defs: [
      { src: `^\\s*${SWIFT_MODS}(?<kw>func|class|struct|enum|protocol|actor|typealias|extension|associatedtype|var|let|case)\\s+NAME\\b` },
      { src: `^\\s*${SWIFT_MODS}(?<kw>init|subscript)(?<name>)\\s*[(<?!]` },
    ],
    blocks: 'braces',
    notCalls: ['if', 'for', 'while', 'switch', 'guard', 'return', 'catch', 'func', 'init', 'subscript', 'case', 'let', 'var', 'in', 'repeat', 'defer', 'some', 'any', 'try', 'await', 'throws', 'rethrows', 'where', 'is', 'as', 'didSet', 'willSet', 'get', 'set', '#if', 'Self', 'self', 'super'],
    lineComment: '//',
  },
  {
    id: 'typescript', name: 'TypeScript/JavaScript', extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    lspIds: { '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact' },
    servers: [{ cmd: 'typescript-language-server', args: ['--stdio'] }, { cmd: 'tsc --lsp (TypeScript 7+)', args: ['--lsp', '--stdio'] }],
    defs: [
      { src: `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?<kw>function\\*?|class|interface|type|enum|namespace|module|const|let|var)\\s+NAME\\b` },
      // Methods: name(params) { — the parameter list must be balanced (one level) so calls like foo(() => { don't match.
      { src: `^\\s*${TS_MODS}\\*?NAME\\s*(?:<[^>]*>)?\\s*\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)\\s*(?::\\s*[^=;{]+)?\\s*\\{\\s*$`, kind: 'method' },
      { src: `^\\s*${TS_MODS}NAME\\s*[?!]?\\s*(?::[^=;]+)?=\\s*(?:async\\s+)?(?:\\([^)]*\\)|${IDENT})\\s*(?::[^=]+)?=>`, kind: 'method' },
      { src: `^\\s*${TS_MODS}NAME\\s*[?!]?\\s*:\\s*[^,;]+[;,]?\\s*$`, kind: 'property' },
    ],
    blocks: 'braces',
    notCalls: ['if', 'for', 'while', 'switch', 'return', 'catch', 'function', 'typeof', 'new', 'await', 'async', 'void', 'delete', 'in', 'of', 'instanceof', 'super', 'import', 'require', 'constructor', 'get', 'set', 'yield', 'do', 'else', 'try', 'throw'],
    lineComment: '//',
  },
  {
    id: 'python', name: 'Python', extensions: ['.py', '.pyi'], lspIds: { '.py': 'python', '.pyi': 'python' },
    servers: [{ cmd: 'pyright-langserver', args: ['--stdio'] }, { cmd: 'basedpyright-langserver', args: ['--stdio'] }, { cmd: 'pylsp', args: [] }],
    defs: [
      { src: `^\\s*(?:async\\s+)?(?<kw>def|class)\\s+NAME\\b` },
      { src: `^NAME\\s*(?::[^=]+)?=(?!=)`, kind: 'variable' },
    ],
    blocks: 'indent',
    notCalls: ['if', 'for', 'while', 'return', 'def', 'class', 'and', 'or', 'not', 'in', 'is', 'print', 'lambda', 'elif', 'with', 'assert', 'yield', 'await', 'except', 'del', 'super'],
    lineComment: '#',
  },
  {
    id: 'go', name: 'Go', extensions: ['.go'], lspIds: { '.go': 'go' },
    servers: [{ cmd: 'gopls', args: [] }],
    defs: [
      { src: `^(?<kw>func)\\s+(?:\\([^)]*\\)\\s*)?NAME\\b` },
      { src: `^\\s*(?<kw>type|var|const)\\s+NAME\\b` },
      { src: `^\\s+NAME\\s+(?<kw>struct|interface)\\b` },
    ],
    blocks: 'braces',
    notCalls: ['if', 'for', 'switch', 'return', 'func', 'go', 'defer', 'select', 'range', 'make', 'new', 'len', 'cap', 'append', 'panic', 'type'],
    lineComment: '//',
  },
  {
    id: 'rust', name: 'Rust', extensions: ['.rs'], lspIds: { '.rs': 'rust' },
    servers: [{ cmd: 'rust-analyzer', args: [] }],
    defs: [
      { src: `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:(?:async|const|unsafe|default|extern\\s+"[^"]*")\\s+)*(?<kw>fn|struct|enum|trait|type|mod|const|static|union)\\s+NAME\\b` },
      { src: `(?<kw>macro_rules!)\\s*NAME\\b` },
    ],
    blocks: 'braces',
    notCalls: ['if', 'for', 'while', 'match', 'return', 'fn', 'loop', 'let', 'in', 'as', 'Some', 'Ok', 'Err', 'Box', 'impl', 'where'],
    lineComment: '//',
  },
];

const BY_EXT = new Map<string, Language>();
for (const l of LANGUAGES) for (const e of l.extensions) BY_EXT.set(e, l);

export function languageOf(file: string): Language | undefined {
  return BY_EXT.get(path.extname(file).toLowerCase());
}

export function languageById(id: string): Language | undefined {
  return LANGUAGES.find((l) => l.id === id);
}

const KIND_OF_KEYWORD: Record<string, string> = {
  func: 'function', function: 'function', 'function*': 'function', def: 'function', fn: 'function', init: 'constructor', subscript: 'method',
  class: 'class', struct: 'struct', enum: 'enum', protocol: 'protocol', interface: 'interface', trait: 'trait', actor: 'class',
  type: 'type', typealias: 'type', associatedtype: 'type', union: 'type', namespace: 'namespace', module: 'namespace', mod: 'module',
  extension: 'extension', var: 'variable', let: 'variable', const: 'constant', static: 'variable', case: 'case', 'macro_rules!': 'macro',
};

export interface DefMatch {
  kind: string;
  /** 0-based column of the name. */
  col: number;
  name: string;
}

function compile(lang: Language, name: string | undefined): Array<{ re: RegExp; kind?: string }> {
  const nameSrc = name === undefined ? `(?<name>${IDENT})` : `(?<name>${escapeRegExp(name)})`;
  return lang.defs.map((d) => ({ re: new RegExp(d.src.includes('(?<name>)') ? d.src : d.src.replace('NAME', nameSrc), 'd'), kind: d.kind }));
}

const cache = new Map<string, Array<{ re: RegExp; kind?: string }>>();
function patterns(lang: Language, name: string | undefined): Array<{ re: RegExp; kind?: string }> {
  const key = `${lang.id}\u0000${name ?? ''}\u0000${name === undefined ? 'any' : 'one'}`;
  let p = cache.get(key);
  if (!p) {
    p = compile(lang, name);
    if (name !== undefined) p = p.filter((x) => !x.re.source.includes('(?<name>)'));
    if (cache.size > 500) cache.clear();
    cache.set(key, p);
  }
  return p;
}

/** Does this line define `name` (or, with no name, any symbol)? */
export function matchDefinition(lang: Language, line: string, name?: string): DefMatch | undefined {
  const trimmed = line.trimStart();
  if (trimmed.startsWith(lang.lineComment) || trimmed.startsWith('*') || trimmed.startsWith('/*')) return undefined;
  for (const p of patterns(lang, name)) {
    const m = p.re.exec(line) as (RegExpExecArray & { indices?: { groups?: Record<string, [number, number] | undefined> } }) | null;
    if (!m) continue;
    const kw = m.groups?.kw;
    const kind = kw ? (KIND_OF_KEYWORD[kw] ?? kw) : (p.kind ?? 'symbol');
    let found = m.groups?.name ?? '';
    let col = m.indices?.groups?.name?.[0] ?? 0;
    if (!found && kw) { found = kw; col = m.indices?.groups?.kw?.[0] ?? 0; }
    if (!found) continue;
    if (lang.notCalls.includes(found) && kind === 'method') continue;
    return { kind, col, name: found };
  }
  return undefined;
}

const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs|Tests|[A-Za-z0-9_]+Tests)\//;
const TEST_NAME = /(\.(test|spec)\.[cm]?[jt]sx?$)|(_test\.(go|py)$)|((^|\/)test_[^/]*\.py$)|(Tests?\.swift$)|(_spec\.rb$)/;

export function isTestFile(rel: string): boolean {
  return TEST_NAME.test(rel) || TEST_DIR.test(rel);
}

/** "toolSelection" for "src/engine/toolSelection.ts", "Tools" for "ToolsTests.swift", "matcher" for "matcher.test.ts". */
export function testStem(rel: string): string {
  let b = path.basename(rel).replace(/\.[^.]+$/, '');
  b = b.replace(/\.(test|spec)$/, '').replace(/_test$/, '').replace(/^test_/, '').replace(/Tests?$/, '');
  return b;
}

export function stem(rel: string): string {
  return path.basename(rel).replace(/\.[^.]+$/, '');
}
