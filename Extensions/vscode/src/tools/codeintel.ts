// Built-in code intelligence (task 33b): ingle-code's tools as normal tools — outline, definition, references,
// callers, callees, impact, diagnostics and read_exhaustively. Read-only and limited to the workspace, so they
// never ask. Names, arguments and output follow Extensions/ingle-code/TOOLS.md; the engine is imported directly
// (codeintelCore.ts). The Mac app offers the same tools in Code mode (CodeIntel.swift).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CODE_INTEL_TOOLS, engineFor, gitChangedFiles, impactLocations, loadEngineLib, mentionedFiles, runCodeIntel, type ImpactLocation, type WorkingSet } from './codeintelCore';
import { str, type ToolArgs, type ToolDef } from './types';

export { impactLocations, disposeEngines } from './codeintelCore';

// MARK: working set

/** Files named in recent chat messages, per workspace (newest first, at most 20). */
const mentions = new Map<string, string[]>();

/** Remembers the files a chat message names, for the working set. Called with each request. */
export function noteChatText(text: string, root: string | undefined): void {
  if (!root || !text) return;
  const found = mentionedFiles(text, (rel) => exists(root, rel));
  if (!found.length) return;
  const list = mentions.get(root) ?? [];
  mentions.set(root, [...found, ...list.filter((f) => !found.includes(f))].slice(0, 20));
}

function exists(root: string, rel: string): boolean {
  if (path.isAbsolute(rel) || rel.split('/').includes('..')) return false;
  try { return fs.statSync(path.join(root, rel)).isFile(); } catch { return false; }
}

function relIn(root: string, uri: vscode.Uri | undefined): string | undefined {
  if (!uri || uri.scheme !== 'file') return undefined;
  const r = path.relative(root, uri.fsPath);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : undefined;
}

/** What the user is working on right now: the selection, open editors, git changes and files the chat named. */
export async function workingSet(root: string): Promise<WorkingSet> {
  const ed = vscode.window.activeTextEditor;
  const activeFile = relIn(root, ed?.document.uri);
  const selection = ed && !ed.selection.isEmpty && activeFile ? ed.document.getText(ed.selection) : undefined;
  const open: string[] = [];
  try {
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        const input = t.input as { uri?: vscode.Uri } | undefined;
        const rel = relIn(root, input?.uri);
        if (rel && !open.includes(rel)) open.push(rel);
      }
    }
  } catch { /* older VS Code */ }
  for (const e of vscode.window.visibleTextEditors) {
    const rel = relIn(root, e.document.uri);
    if (rel && !open.includes(rel)) open.push(rel);
  }
  const changed = await gitChangedFiles(root);
  return { selection, activeFile, open: open.slice(0, 30), changed: changed.slice(0, 60), mentioned: mentions.get(root) ?? [] };
}

/** Structured impact for coverage checks (task 34): every place a change to `symbol` could affect. */
export async function impactLocationsIn(root: string, symbol: string, file?: string): Promise<ImpactLocation[]> {
  const engine = engineFor(root);
  return engine ? impactLocations(engine, symbol, { file }) : [];
}

// MARK: tools

const ICONS: Record<string, string> = {
  outline: 'list-tree', definition: 'go-to-file', references: 'references', callers: 'call-incoming',
  callees: 'call-outgoing', impact: 'pulse', diagnostics: 'warning', read_exhaustively: 'book',
};
const TITLES: Record<string, string> = {
  outline: 'Outline', definition: 'Find the definition', references: 'Find every use', callers: 'Find callers',
  callees: 'Find what it calls', impact: 'Check the impact', diagnostics: 'Check for errors', read_exhaustively: 'Read it all',
};
const WORKING_SET_HINT: Record<string, [string, string]> = {
  symbol: ['symbol', ' Leave out to use what the user is working on (the selection, or what the uncommitted changes touch).'],
  file: ['file', ' Leave out for the open file.'],
  paths: ['paths', ' Leave out for the files the user is working on (open, changed, mentioned).'],
};

/** The model's view of one tool: TOOLS.md's description and arguments, without `format` (the model gets text), and
 *  with the working-set defaults (symbol, outline's file, diagnostics' paths) optional. Same as CodeIntel.definitions. */
export function codeIntelParameters(name: string): { description: string; parameters: Record<string, unknown> } | undefined {
  const l = loadEngineLib();
  const spec = l?.TOOL_SPECS.find((s) => s.name === name);
  if (!spec) return undefined;
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec.inputSchema.properties)) {
    if (k === 'format') continue;
    const hint = WORKING_SET_HINT[k];
    const optional = hint && (k === 'symbol' || name === 'outline' || name === 'diagnostics');
    props[k] = optional ? { ...(v as Record<string, unknown>), description: String((v as { description?: string }).description ?? '') + hint[1] } : v;
  }
  const required = (spec.inputSchema.required ?? []).filter((k) => !(k === 'symbol' || (name === 'outline' && k === 'file')));
  return { description: spec.description, parameters: { type: 'object', properties: props, required } };
}

function makeTool(name: string): ToolDef {
  const view = codeIntelParameters(name);
  return {
    name,
    description: view?.description ?? name,
    parameters: view?.parameters ?? { type: 'object', properties: {}, required: [] },
    readOnly: true,
    available: (ctx) => !!ctx.workspaceRoot && !!view,
    describe: (a: ToolArgs) => {
      const target = str(a, 'symbol') || str(a, 'file') || str(a, 'path') || (Array.isArray(a.paths) ? (a.paths as unknown[]).map(String).join(', ') : str(a, 'paths'));
      const extra = name === 'read_exhaustively' && str(a, 'question') ? ` — ${str(a, 'question')}` : '';
      return { title: TITLES[name] ?? name, detail: (target || 'what you’re working on') + extra, icon: ICONS[name] ?? 'symbol-method' };
    },
    run: async (a, ctx) => {
      const root = ctx.workspaceRoot;
      if (!root) return 'Open a folder in VS Code first: code intelligence works on the open project.';
      const engine = engineFor(root, { ollamaHost: ctx.settings.serverURL });
      if (!engine) return 'Code intelligence isn’t available in this build. Use search_code and repo_map instead.';
      ctx.setActivity(`${TITLES[name] ?? name}…`);
      try {
        const ws = await workingSet(root);
        const abort = new Promise<string>((resolve) => ctx.signal.addEventListener('abort', () => resolve('Stopped.'), { once: true }));
        return await Promise.race([runCodeIntel(engine, name, a, ws), abort]);
      } catch (e) {
        return `Code intelligence failed: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        ctx.setActivity(null);
      }
    },
  };
}

export const codeIntelTools: ToolDef[] = CODE_INTEL_TOOLS.map(makeTool);
