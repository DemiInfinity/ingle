// Path handling shared by the file tools: absolute, ~ and workspace-relative paths, and the
// "inside the project" check that decides whether reading needs approval.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { expandHome, paths as inglePaths } from '../shared/settings';
import type { ToolContext } from './types';

export const DENIED = "The user denied this action. Don't retry it; ask them what they'd like instead.";

/** The folder relative paths are resolved against: the open project, else the home folder. */
export function baseFolder(workspaceRoot?: string): string {
  return workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
}

/** Absolute, normalised path for what the model typed. Strips quotes and a file:// prefix. */
export function resolvePath(input: string, workspaceRoot?: string): string {
  let p = input.trim().replace(/^["'`]|["'`]$/g, '');
  if (p.startsWith('file://')) { try { p = vscode.Uri.parse(p).fsPath; } catch { /* keep */ } }
  if (p === '~' || p.startsWith('~/')) p = expandHome(p);
  if (!path.isAbsolute(p)) p = path.join(baseFolder(workspaceRoot), p);
  return path.resolve(p);
}

function real(p: string): string {
  // Resolve symlinks on the longest existing prefix, so a link can't smuggle a path outside.
  let cur = p;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* go up */ }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.push(path.basename(cur));
    cur = parent;
  }
  return p;
}

export function isUnder(p: string, root: string): boolean {
  const r = path.resolve(root);
  return p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** The project folders: VS Code's open folders plus the Mac app's workspace folders. */
export function projectRoots(ctx: Pick<ToolContext, 'settings' | 'workspaceRoot'>): string[] {
  const roots: string[] = [];
  if (ctx.workspaceRoot) roots.push(ctx.workspaceRoot);
  for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri.fsPath);
  for (const f of ctx.settings.workspaceFolders ?? []) if (f.trim()) roots.push(expandHome(f.trim()));
  return roots.map((r) => path.resolve(r));
}

/** Inside the project (or Ingle's own skill/rule folders, which skills point at) — reading is free there. */
export function isReadableFreely(abs: string, ctx: Pick<ToolContext, 'settings' | 'workspaceRoot'>): boolean {
  const roots = [...projectRoots(ctx), inglePaths.skills, inglePaths.rules];
  if (ctx.settings.useClaudeSkills) roots.push(inglePaths.claudeSkills);
  const rp = real(abs);
  return roots.some((r) => isUnder(abs, r) && isUnder(rp, real(r)));
}

export function isInProject(abs: string, ctx: Pick<ToolContext, 'settings' | 'workspaceRoot'>): boolean {
  const rp = real(abs);
  return projectRoots(ctx).some((r) => isUnder(abs, r) && isUnder(rp, real(r)));
}

/** null when reading is allowed (inside the project, or the user approved), else the denial text. */
export async function checkRead(abs: string, ctx: ToolContext, what = 'a file'): Promise<string | null> {
  if (isReadableFreely(abs, ctx)) return null;
  const answer = await ctx.requestApproval({ kind: 'read', title: `Wants to read ${what} outside the project`, detail: tidy(abs) });
  return answer === 'allow' ? null : DENIED;
}

/** Workspace-relative when inside the project, ~/… when under home, else absolute. */
export function tidy(abs: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(abs));
  if (folder) {
    const rel = vscode.workspace.asRelativePath(vscode.Uri.file(abs), (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
    if (rel && !path.isAbsolute(rel)) return rel;
  }
  const home = os.homedir();
  return isUnder(abs, home) ? '~' + abs.slice(home.length) : abs;
}

export function exists(p: string): boolean {
  try { fs.statSync(p); return true; } catch { return false; }
}

export function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
