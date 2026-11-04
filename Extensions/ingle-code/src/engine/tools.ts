// Tool definitions (names, descriptions, JSON Schemas) and one dispatcher, shared by the MCP server and the apps.
// TOOLS.md is the human-readable copy of this file: change both together.
import { CodeEngine } from './engine';
import { formatCalls, formatDefinition, formatDiagnostics, formatExhaustive, formatImpact, formatOutline, formatReferences, formatStatus } from './format';
import { EngineError } from './types';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
}

const SYMBOL = { type: 'string', description: 'A name (approvalScope, MacTools.approvalScope) or a position file:line:col (1-based; col optional).' };
const FILE_HINT = { type: 'string', description: 'Optional: prefer the definition in this file when the name is defined more than once.' };
const PAGE = { type: 'integer', minimum: 1, description: 'Page of results (default 1).' };
const DEPTH = { type: 'integer', minimum: 1, maximum: 2, description: '1 = direct only (default), 2 = one more level.' };
const FORMAT = { type: 'string', enum: ['text', 'json'], description: 'text (default, short) or json (the full typed result).' };

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'code_status',
    description: 'Which languages get exact answers (a language server is installed) and which are approximate; whether read_exhaustively can run. Call this first if unsure.',
    inputSchema: { type: 'object', properties: { format: FORMAT }, additionalProperties: false },
  },
  {
    name: 'outline',
    description: 'Symbols in one file (types, functions, properties) with line ranges.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Path relative to the workspace.' }, page: PAGE, format: FORMAT }, required: ['file'], additionalProperties: false },
  },
  {
    name: 'definition',
    description: 'Where a symbol is defined.',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL, file: FILE_HINT, page: PAGE, format: FORMAT }, required: ['symbol'], additionalProperties: false },
  },
  {
    name: 'references',
    description: 'Every use of a symbol, grouped by file, with a total count. Each result says exact or approximate.',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL, file: FILE_HINT, page: PAGE, format: FORMAT }, required: ['symbol'], additionalProperties: false },
  },
  {
    name: 'callers',
    description: 'Functions that call this symbol.',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL, file: FILE_HINT, depth: DEPTH, page: PAGE, format: FORMAT }, required: ['symbol'], additionalProperties: false },
  },
  {
    name: 'callees',
    description: 'Functions in this workspace that this symbol calls.',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL, file: FILE_HINT, depth: DEPTH, page: PAGE, format: FORMAT }, required: ['symbol'], additionalProperties: false },
  },
  {
    name: 'impact',
    description: 'Everything a change to this symbol could affect: files that use it, its callers, and the tests that cover those files. Use before changing shared code.',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL, file: FILE_HINT, page: PAGE, format: FORMAT }, required: ['symbol'], additionalProperties: false },
  },
  {
    name: 'diagnostics',
    description: 'Compiler and type errors without a full build. With no paths, checks files changed since the last commit.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders relative to the workspace.' }, page: PAGE, format: FORMAT }, additionalProperties: false },
  },
  {
    name: 'read_exhaustively',
    description: 'Read a huge file or log in chunks with the local model and get a short note for every chunk, so nothing is skipped. Slow: use for files too big to read.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File relative to the workspace.' }, question: { type: 'string', description: 'What to look for.' }, page: { type: 'integer', minimum: 1, description: 'Which group of chunks to read (default 1).' }, format: FORMAT },
      required: ['path', 'question'],
      additionalProperties: false,
    },
  },
];

export const TOOL_NAMES = TOOL_SPECS.map((t) => t.name);

export interface ToolOutput {
  text: string;
  isError: boolean;
  data?: unknown;
}

function str(args: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new EngineError(`Missing argument: ${key}`);
    return undefined;
  }
  if (typeof v !== 'string') throw new EngineError(`${key} must be a string`);
  return v;
}

function int(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new EngineError(`${key} must be a number`);
  return Math.floor(n);
}

/** Run one tool. Never throws: errors come back as { isError: true, text }. */
export async function callTool(engine: CodeEngine, name: string, rawArgs: unknown): Promise<ToolOutput> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const json = args.format === 'json';
  const done = (data: unknown, text: string): ToolOutput => ({ text: json ? JSON.stringify(data, null, 1) : text, isError: false, data });
  try {
    const page = int(args, 'page');
    switch (name) {
      case 'code_status': { const r = await engine.status(); return done(r, formatStatus(r)); }
      case 'outline': { const r = await engine.outline(str(args, 'file', true)!, { page }); return done(r, formatOutline(r)); }
      case 'definition': { const r = await engine.definition(str(args, 'symbol', true)!, { page, file: str(args, 'file', false) }); return done(r, formatDefinition(r)); }
      case 'references': { const r = await engine.references(str(args, 'symbol', true)!, { page, file: str(args, 'file', false) }); return done(r, formatReferences(r)); }
      case 'callers': { const r = await engine.callers(str(args, 'symbol', true)!, { page, file: str(args, 'file', false), depth: int(args, 'depth') }); return done(r, formatCalls(r)); }
      case 'callees': { const r = await engine.callees(str(args, 'symbol', true)!, { page, file: str(args, 'file', false), depth: int(args, 'depth') }); return done(r, formatCalls(r)); }
      case 'impact': { const r = await engine.impact(str(args, 'symbol', true)!, { page, file: str(args, 'file', false) }); return done(r, formatImpact(r)); }
      case 'diagnostics': {
        const p = args.paths;
        let paths: string[] | undefined;
        if (typeof p === 'string') paths = [p];
        else if (Array.isArray(p)) paths = p.map(String);
        else if (p !== undefined && p !== null) throw new EngineError('paths must be a list of strings');
        const r = await engine.diagnostics(paths, { page });
        return done(r, formatDiagnostics(r));
      }
      case 'read_exhaustively': {
        const r = await engine.readExhaustively(str(args, 'path', true)!, str(args, 'question', true)!, { page });
        return done(r, formatExhaustive(r));
      }
      default:
        return { text: `Unknown tool: ${name}. Tools: ${TOOL_NAMES.join(', ')}`, isError: true };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { text: e instanceof EngineError ? msg : `ingle-code error: ${msg}`, isError: true };
  }
}
