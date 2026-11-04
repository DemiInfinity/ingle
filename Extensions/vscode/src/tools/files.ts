// File tools: read_file, list_files, find_files, search_code, get_problems, edit_file, write_file.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { snapshot } from './checkpoints';
import { diffStats, unifiedDiff } from './diff';
import { DOCUMENT_EXTS, IMAGE_EXTS, extOf } from './documents';
import { planEdit } from './editmatch';
import { DENIED, baseFolder, checkRead, isDir, resolvePath, tidy } from './paths';
import { str, type ToolArgs, type ToolDef } from './types';

export const EXCLUDE_GLOB = '**/{node_modules,.git,dist,build,out,.next,Pods,DerivedData}/**';
const LIST_SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.next', 'Pods', 'DerivedData', '.build', '__pycache__', '.venv', '.turbo', '.cache']);
const MAX_READ = 100_000;

const prop = (description: string) => ({ type: 'string', description });
const intProp = (description: string) => ({ type: 'integer', description });

/** The text VS Code has for a file: the open (possibly unsaved) document if there is one, else disk. */
async function currentText(abs: string): Promise<string | null> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === abs);
  if (doc) return doc.getText();
  try { return await fs.promises.readFile(abs, 'utf8'); } catch { return null; }
}

/** The unsaved text of an open, edited document (what the tool saw as the original), else undefined. */
function unsavedText(abs: string): string | undefined {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === abs);
  return doc?.isDirty ? doc.getText() : undefined;
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function noFolder(): string { return 'No folder is open in VS Code, so there is no project to search.'; }

// MARK: read_file

const readFile: ToolDef = {
  name: 'read_file',
  description: 'Read a text file, with line numbers. For big files, read a range with start_line/end_line. Don\'t copy the line numbers into edit_file.',
  parameters: { type: 'object', properties: { path: prop('File path: relative to the project, ~/…, or absolute'), start_line: intProp('First line to read (optional)'), end_line: intProp('Last line to read (optional)') }, required: ['path'] },
  readOnly: true,
  available: () => true,
  describe: (a) => {
    const s = num(a.start_line), e = num(a.end_line);
    return { title: 'Read a file', detail: str(a, 'path') + (s || e ? ` (lines ${s ?? 1}–${e ?? 'end'})` : ''), icon: 'file' };
  },
  async run(a, ctx) {
    const raw = str(a, 'path');
    if (!raw.trim()) return 'Give me the path of the file to read.';
    const abs = resolvePath(raw, ctx.workspaceRoot);
    const ext = extOf(abs);
    if (IMAGE_EXTS.has(ext)) return `${tidy(abs)} is an image. Use view_image to look at it.`;
    if (DOCUMENT_EXTS.has(ext)) return `${tidy(abs)} is a document. Use read_document to read it.`;
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { return `There's no file at ${tidy(abs)}.`; }
    if (stat.isDirectory()) return `${tidy(abs)} is a folder. Use list_files for folders.`;
    const denied = await checkRead(abs, ctx);
    if (denied) return denied;
    let text = await currentText(abs);
    if (text === null) return `Couldn't read ${tidy(abs)}.`;
    if (text.includes('\u0000')) return `${tidy(abs)} looks like a binary file, so I can't read it as text.`;
    text = text.replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const start = Math.min(num(a.start_line) ?? 1, Math.max(1, lines.length));
    const end = Math.min(num(a.end_line) ?? lines.length, lines.length);
    if (end < start) return `${tidy(abs)} has ${lines.length} lines; that range is empty.`;
    const out: string[] = [];
    let size = 0, last = start - 1;
    for (let i = start; i <= end; i++) {
      const line = `${i}\t${lines[i - 1]}`;
      if (size + line.length > MAX_READ) break;
      out.push(line); size += line.length + 1; last = i;
    }
    let result = out.join('\n');
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return `${tidy(abs)} is empty.`;
    if (last < end) result += `\n…(trimmed at line ${last} of ${lines.length} — read on with start_line ${last + 1})`;
    else if (start > 1 || end < lines.length) result += `\n(${tidy(abs)} has ${lines.length} lines)`;
    return result;
  },
};

// MARK: list_files

const listFiles: ToolDef = {
  name: 'list_files',
  description: 'List the files and folders in a folder (default: the project root). Folders end with /.',
  parameters: { type: 'object', properties: { path: prop('Folder path (optional; relative to the project, ~/…, or absolute)') }, required: [] },
  readOnly: true,
  available: () => true,
  describe: (a) => ({ title: 'List a folder', detail: str(a, 'path') || '(project root)', icon: 'folder' }),
  async run(a, ctx) {
    const raw = str(a, 'path').trim();
    const abs = raw ? resolvePath(raw, ctx.workspaceRoot) : path.resolve(baseFolder(ctx.workspaceRoot));
    if (!isDir(abs)) return `There's no folder at ${tidy(abs)}.`;
    const denied = await checkRead(abs, ctx, 'a folder');
    if (denied) return denied;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); } catch { return `Couldn't open the folder ${tidy(abs)}.`; }
    const dirs: string[] = [], files: string[] = [];
    let skipped = 0;
    for (const e of entries) {
      if (LIST_SKIP.has(e.name)) { skipped++; continue; }
      let dir = e.isDirectory();
      if (e.isSymbolicLink()) dir = isDir(path.join(abs, e.name));
      (dir ? dirs : files).push(dir ? e.name + '/' : e.name);
    }
    const all = [...dirs.sort(), ...files.sort()];
    if (!all.length) return skipped ? `(only ${[...LIST_SKIP].filter((n) => entries.some((e) => e.name === n)).join(', ')} here)` : '(empty folder)';
    const shown = all.slice(0, 500);
    let out = shown.join('\n');
    if (all.length > 500) out += `\n…and ${all.length - 500} more`;
    return out;
  },
};

// MARK: find_files

function normaliseGlob(g: string): string {
  let glob = g.trim().replace(/^\.\//, '');
  if (!glob) return '**/*';
  if (!glob.includes('/') && !glob.startsWith('**')) glob = '**/' + glob;
  return glob;
}

const findFiles: ToolDef = {
  name: 'find_files',
  description: 'Find files in the project by name pattern, e.g. "*.tsx", "src/**/*.test.ts" or "**/Invoice*".',
  parameters: { type: 'object', properties: { glob: prop('Glob pattern') }, required: ['glob'] },
  readOnly: true,
  available: () => true,
  describe: (a) => ({ title: 'Find files', detail: str(a, 'glob'), icon: 'search' }),
  async run(a) {
    if (!vscode.workspace.workspaceFolders?.length) return noFolder();
    const glob = normaliseGlob(str(a, 'glob'));
    try {
      const uris = await vscode.workspace.findFiles(glob, EXCLUDE_GLOB, 201);
      if (!uris.length) return `No files match ${glob}.`;
      const names = uris.map((u) => vscode.workspace.asRelativePath(u, (vscode.workspace.workspaceFolders?.length ?? 0) > 1)).sort();
      return names.slice(0, 200).join('\n') + (names.length > 200 ? '\n…(more than 200 — narrow the pattern)' : '');
    } catch (e) {
      return `That pattern didn't work: ${(e as Error).message}`;
    }
  },
};

// MARK: search_code

const searchCode: ToolDef = {
  name: 'search_code',
  description: 'Search the project\'s files for text (plain text, not case-sensitive). Returns path:line: text. Optionally limit to a glob like "**/*.ts".',
  parameters: { type: 'object', properties: { query: prop('Text to look for'), glob: prop('Optional file pattern') }, required: ['query'] },
  readOnly: true,
  available: () => true,
  describe: (a) => ({ title: 'Search the code', detail: str(a, 'query') + (str(a, 'glob') ? ` in ${str(a, 'glob')}` : ''), icon: 'search' }),
  async run(a, ctx) {
    const query = str(a, 'query');
    if (!query.trim()) return 'Give me some text to search for.';
    if (!vscode.workspace.workspaceFolders?.length) return noFolder();
    const needle = query.toLowerCase();
    const glob = str(a, 'glob').trim() ? normaliseGlob(str(a, 'glob')) : '**/*';
    ctx.setActivity('Searching the code…');
    try {
      const uris = await vscode.workspace.findFiles(glob, EXCLUDE_GLOB, 20_000);
      uris.sort((x, y) => (x.fsPath < y.fsPath ? -1 : 1));
      const hits: string[] = [];
      let more = false;
      const open = new Map(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => [d.uri.fsPath, d]));
      for (const uri of uris) {
        if (ctx.signal.aborted) return 'Stopped.';
        let text: string;
        const doc = open.get(uri.fsPath);
        if (doc) text = doc.getText();
        else {
          try {
            const st = await fs.promises.stat(uri.fsPath);
            if (st.size > 1_000_000) continue;
            const buf = await fs.promises.readFile(uri.fsPath);
            if (isBinary(buf)) continue;
            text = buf.toString('utf8');
          } catch { continue; }
        }
        if (!text.toLowerCase().includes(needle)) continue;
        const rel = vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(needle)) continue;
          if (hits.length >= 100) { more = true; break; }
          let line = lines[i].replace(/\r$/, '').trim();
          if (line.length > 200) line = line.slice(0, 200) + '…';
          hits.push(`${rel}:${i + 1}: ${line}`);
        }
        if (more) break;
      }
      if (!hits.length) return `No matches for “${query}”${glob !== '**/*' ? ` in ${glob}` : ''}.`;
      return hits.join('\n') + (more ? '\n…(stopped at 100 matches — narrow the search or add a glob)' : '');
    } catch (e) {
      return `Search failed: ${(e as Error).message}`;
    } finally {
      ctx.setActivity(null);
    }
  },
};

// MARK: get_problems

const getProblems: ToolDef = {
  name: 'get_problems',
  description: 'Get the errors and warnings VS Code reports (TypeScript, ESLint…) for one file, or the whole project if no path.',
  parameters: { type: 'object', properties: { path: prop('Optional file path') }, required: [] },
  readOnly: true,
  available: () => true,
  describe: (a) => ({ title: 'Check problems', detail: str(a, 'path') || '(whole project)', icon: 'warning' }),
  async run(a, ctx) {
    const raw = str(a, 'path').trim();
    let list: [vscode.Uri, readonly vscode.Diagnostic[]][];
    if (raw) {
      const uri = vscode.Uri.file(resolvePath(raw, ctx.workspaceRoot));
      list = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
      list = vscode.languages.getDiagnostics();
    }
    const rows: { sev: number; text: string }[] = [];
    for (const [uri, diags] of list) {
      for (const d of diags) {
        if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) continue;
        const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
        const src = d.source ? ` (${d.source}${d.code !== undefined && typeof d.code !== 'object' ? ` ${d.code}` : ''})` : '';
        rows.push({ sev: d.severity, text: `${tidy(uri.fsPath)}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${sev}: ${d.message.split('\n')[0]}${src}` });
      }
    }
    if (!rows.length) return raw ? `No errors or warnings in ${raw}.` : 'No errors or warnings in the project.';
    rows.sort((x, y) => x.sev - y.sev);
    const errors = rows.filter((r) => r.sev === vscode.DiagnosticSeverity.Error).length;
    const head = `${errors} error${errors === 1 ? '' : 's'}, ${rows.length - errors} warning${rows.length - errors === 1 ? '' : 's'}`;
    return head + '\n' + rows.slice(0, 50).map((r) => r.text).join('\n') + (rows.length > 50 ? `\n…and ${rows.length - 50} more` : '');
  },
};

// MARK: edits

type Proposal = { abs: string; original: string; proposed: string; exists: boolean; note?: string } | { error: string };

async function propose(args: ToolArgs, workspaceRoot: string | undefined, kind: 'edit' | 'write'): Promise<Proposal> {
  const raw = str(args, 'path');
  if (!raw.trim()) return { error: 'Give me the path of the file.' };
  const abs = resolvePath(raw, workspaceRoot);
  if (isDir(abs)) return { error: `${tidy(abs)} is a folder.` };
  const original = await currentText(abs);
  if (kind === 'write') {
    if (!('content' in args)) return { error: 'write_file needs the full content.' };
    return { abs, original: original ?? '', proposed: str(args, 'content'), exists: original !== null };
  }
  if (original === null) return { error: `There's no file at ${tidy(abs)}. Use write_file to create it.` };
  const oldText = str(args, 'old_text');
  const newText = str(args, 'new_text');
  if (!oldText) return { error: 'old_text is empty. Give the exact text to replace (read the file first), or use write_file for a new file.' };
  if (oldText === newText) return { error: 'old_text and new_text are the same, so there is nothing to change.' };
  const plan = planEdit(original, oldText, newText);
  if (!plan.ok) {
    if (plan.reason === 'many') return { error: `old_text appears ${plan.count} times in ${tidy(abs)}. Include a few more surrounding lines so it matches exactly once.` };
    return {
      error: `old_text wasn't found in ${tidy(abs)}.` + (plan.nearest
        ? ` The closest lines are:\n${plan.nearest}\nRead the file again and copy the text exactly (without line numbers).`
        : ' Read the file again and copy the text exactly (without line numbers).'),
    };
  }
  return {
    abs, original, exists: true,
    proposed: original.slice(0, plan.start) + plan.replacement + original.slice(plan.end),
    note: plan.tolerant ? ' (matched ignoring line endings / trailing spaces)' : '',
  };
}

/** What an edit_file or write_file call would change, without writing anything (for the View Diff button).
 *  `args` are the tool's arguments; pass `name` to say which tool when args alone are ambiguous. */
export async function pendingEditPreview(args: ToolArgs, workspaceRoot?: string, name?: 'edit_file' | 'write_file'): Promise<{ uri: string; original: string; proposed: string } | null> {
  try {
    const kind = name === 'write_file' || (!name && 'content' in args && !('old_text' in args)) ? 'write' : 'edit';
    const p = await propose(args, workspaceRoot, kind);
    if ('error' in p) return null;
    return { uri: vscode.Uri.file(p.abs).toString(), original: p.original, proposed: p.proposed };
  } catch {
    return null;
  }
}

/** Replace the whole document through a WorkspaceEdit (so Undo works) and save it. */
async function applyText(abs: string, proposed: string, expectOriginal: string): Promise<string | null> {
  const uri = vscode.Uri.file(abs);
  const doc = await vscode.workspace.openTextDocument(uri);
  const now = doc.getText();
  if (now !== expectOriginal) return `${tidy(abs)} changed while waiting for approval. Read it again and redo the edit.`;
  // Replace only the changed middle, so cursors and folding elsewhere stay put.
  let pre = 0;
  while (pre < now.length && pre < proposed.length && now[pre] === proposed[pre]) pre++;
  let suf = 0;
  while (suf < now.length - pre && suf < proposed.length - pre && now[now.length - 1 - suf] === proposed[proposed.length - 1 - suf]) suf++;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(doc.positionAt(pre), doc.positionAt(now.length - suf)), proposed.slice(pre, proposed.length - suf));
  if (!(await vscode.workspace.applyEdit(edit))) return `VS Code refused the edit to ${tidy(abs)}.`;
  if (!(await doc.save())) return `Edited ${tidy(abs)} but couldn't save it.`;
  return null;
}

const editFile: ToolDef = {
  name: 'edit_file',
  description: 'Change a file by replacing one exact piece of text. old_text must match the file exactly once (copy it from read_file, without line numbers); keep it small but unique. The user approves.',
  parameters: { type: 'object', properties: { path: prop('File path'), old_text: prop('The exact text to replace'), new_text: prop('The text to put in its place') }, required: ['path', 'old_text', 'new_text'] },
  readOnly: false,
  available: () => true,
  describe: (a) => ({ title: 'Edit a file', detail: str(a, 'path'), icon: 'edit' }),
  async run(a, ctx) {
    try {
      const p = await propose(a, ctx.workspaceRoot, 'edit');
      if ('error' in p) return p.error;
      const rel = tidy(p.abs);
      const answer = await ctx.requestApproval({
        kind: 'edit', title: 'Wants to edit a file', detail: rel,
        preview: unifiedDiff(p.original, p.proposed, rel), canShowDiff: true,
      }, p.abs);
      if (answer !== 'allow') return DENIED;
      ctx.setActivity('Editing a file…');
      const cpErr = snapshot(p.abs, ctx.run, unsavedText(p.abs));
      const err = await applyText(p.abs, p.proposed, p.original);
      if (err) return err;
      const s = diffStats(p.original, p.proposed);
      return `Edited ${rel}: −${s.removed} +${s.added} lines${p.note ?? ''}.` + (cpErr ? '\n' + cpErr : '');
    } catch (e) {
      return `Couldn't edit the file: ${(e as Error).message}`;
    } finally {
      ctx.setActivity(null);
    }
  },
};

const writeFile: ToolDef = {
  name: 'write_file',
  description: 'Create a new file, or overwrite one with the full new contents (folders are created). For small changes to an existing file, use edit_file instead. The user approves.',
  parameters: { type: 'object', properties: { path: prop('File path'), content: prop('The full file contents') }, required: ['path', 'content'] },
  readOnly: false,
  available: () => true,
  describe: (a) => ({ title: 'Write a file', detail: str(a, 'path'), icon: 'edit' }),
  async run(a, ctx) {
    try {
      const p = await propose(a, ctx.workspaceRoot, 'write');
      if ('error' in p) return p.error;
      const rel = tidy(p.abs);
      if (p.exists && p.original === p.proposed) return `${rel} already has exactly that content.`;
      const preview = p.proposed.length > 3000 ? p.proposed.slice(0, 3000) + '\n…' : p.proposed;
      const answer = await ctx.requestApproval({
        kind: 'write', title: p.exists ? 'Wants to overwrite a file' : 'Wants to create a file', detail: rel,
        preview, canShowDiff: p.exists,
      }, p.abs);
      if (answer !== 'allow') return DENIED;
      ctx.setActivity('Writing a file…');
      const cpErr = snapshot(p.abs, ctx.run, unsavedText(p.abs));
      const cpNote = cpErr ? '\n' + cpErr : '';
      const bytes = Buffer.byteLength(p.proposed, 'utf8');
      if (p.exists) {
        const err = await applyText(p.abs, p.proposed, p.original);
        if (err) return err;
        const s = diffStats(p.original, p.proposed);
        return `Overwrote ${rel} (${bytes} bytes, −${s.removed} +${s.added} lines).` + cpNote;
      }
      await fs.promises.mkdir(path.dirname(p.abs), { recursive: true });
      await fs.promises.writeFile(p.abs, p.proposed, 'utf8');
      return `Created ${rel} (${bytes} bytes).` + cpNote;
    } catch (e) {
      return `Couldn't write the file: ${(e as Error).message}`;
    } finally {
      ctx.setActivity(null);
    }
  },
};

export const fileTools: ToolDef[] = [readFile, listFiles, findFiles, searchCode, getProblems, editFile, writeFile];
