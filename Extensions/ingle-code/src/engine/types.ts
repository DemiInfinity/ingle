// Public types for the ingle-code engine. TOOLS.md documents these shapes; keep the two in step.

/** "exact" = from a language server. "approximate" = from the text scan (git grep + patterns). */
export type Exactness = 'exact' | 'approximate';

export interface EngineOptions {
  /** Workspace root. Every path in results is relative to it. */
  root: string;
  /** Local Ollama address for read_exhaustively. Default: $OLLAMA_HOST or http://localhost:11434. Must be loopback. */
  ollamaHost?: string;
  /** Model for read_exhaustively notes. Default: $INGLE_CODE_MODEL, else the smallest installed model. */
  model?: string;
  /** Shut a language server down after this long unused. Default 10 minutes. */
  idleMs?: number;
  /** Items per page. Default 40. */
  pageSize?: number;
  /** Turn language servers off (scan only). Mostly for tests. */
  noServers?: boolean;
  /** Only use servers for these languages (others fall back to the scan). */
  onlyLanguages?: string[];
  /** Longest wait for a server's first index, in ms. Default 120 000. */
  indexWaitMs?: number;
  /** Debug log (stderr in the MCP server). */
  log?: (message: string) => void;
}

export interface PageInfo {
  page: number;
  pageSize: number;
  pages: number;
  total: number;
  /** 1-based index of the first item on this page (0 when empty). */
  from: number;
  /** 1-based index of the last item on this page. */
  to: number;
}

export interface Source {
  language: string;
  exactness: Exactness;
  /** "sourcekit-lsp", "typescript-language-server", or "scan". */
  via: string;
  /** Why it is approximate, when it is (e.g. "no language server installed"). */
  reason?: string;
}

export interface Location {
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based, UTF-16 units. */
  col: number;
}

export interface LanguageStatus {
  language: string;
  extensions: string[];
  /** Server command found on PATH (or in node_modules/.bin), if any. */
  server?: string;
  serverPath?: string;
  /** Running right now for this workspace. */
  running: boolean;
  /** Files of this language in the workspace. */
  files: number;
  exactness: Exactness;
  note?: string;
}

export interface StatusResult {
  root: string;
  git: boolean;
  languages: LanguageStatus[];
  ollama: { host: string; reachable: boolean; model?: string; error?: string };
}

export interface OutlineSymbol {
  name: string;
  kind: string;
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
  depth: number;
  container?: string;
}

export interface OutlineResult extends PageInfo {
  file: string;
  source: Source;
  items: OutlineSymbol[];
}

export interface DefinitionItem extends Location {
  name: string;
  kind: string;
  text: string;
  language: string;
  exactness: Exactness;
  container?: string;
}

export interface DefinitionResult extends PageInfo {
  target: string;
  sources: Source[];
  items: DefinitionItem[];
}

export interface ReferenceItem extends Location {
  text: string;
  language: string;
  exactness: Exactness;
  /** This location is a declaration of the symbol. */
  definition?: boolean;
  /** Found by the text scan in a language whose server did not report it (comment, string, or an index gap). */
  unconfirmed?: boolean;
  /** Text-scan match inside a comment or string. */
  inComment?: boolean;
}

export interface ReferencesResult extends PageInfo {
  target: string;
  definitions: DefinitionItem[];
  sources: Source[];
  files: number;
  exactCount: number;
  approximateCount: number;
  items: ReferenceItem[];
}

export interface CallItem {
  /** The function that calls (callers) or is called (callees). */
  name: string;
  kind: string;
  file: string;
  line: number;
  /** 1 = direct, 2 = one step removed. */
  level: number;
  /** For level 2: the level-1 function this one goes through. */
  via?: string;
  /** Lines of the call sites (callers: in `file`; callees: inside the target). */
  callLines: number[];
  exactness: Exactness;
  language: string;
}

export interface CallsResult extends PageInfo {
  target: string;
  direction: 'callers' | 'callees';
  depth: number;
  definitions: DefinitionItem[];
  sources: Source[];
  items: CallItem[];
}

export interface TestItem {
  file: string;
  /** "name" (file name matches), "import" (imports an affected file/module) or "uses" (mentions the symbol). */
  reasons: Array<'name' | 'import' | 'uses'>;
  /** The affected files that led to this test. */
  covers: string[];
}

export interface ImpactResult {
  /** references.files: files with real uses (comment/string-only matches excluded). mentionedOnly: files where every match is in a comment or string. */
  target: string;
  definitions: DefinitionItem[];
  sources: Source[];
  references: { total: number; exactCount: number; approximateCount: number; files: Array<{ file: string; count: number; exactCount: number }>; mentionedOnly: string[] };
  callers: CallItem[];
  callersTotal: number;
  tests: TestItem[];
  /** Affected source files with no test found by either heuristic. */
  untested: string[];
  page: number;
  pageSize: number;
  pages: number;
}

export interface DiagnosticItem extends Location {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string;
}

export interface DiagnosticsResult extends PageInfo {
  checked: string[];
  /** Files that could not be checked, with the reason. */
  skipped: Array<{ file: string; reason: string }>;
  errors: number;
  warnings: number;
  sources: Source[];
  /** How the file list was chosen when none was given. */
  scope?: string;
  items: DiagnosticItem[];
}

export interface ChunkNote {
  chunk: number;
  startLine: number;
  endLine: number;
  relevant: boolean;
  note: string;
}

export interface ReadExhaustivelyResult {
  file: string;
  question: string;
  model: string;
  totalLines: number;
  chunks: number;
  /** Chunks read in this call (a page of chunks). */
  fromChunk: number;
  toChunk: number;
  page: number;
  pages: number;
  notes: ChunkNote[];
}

export class EngineError extends Error {}
