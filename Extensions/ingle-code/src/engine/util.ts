import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PageInfo, EngineError } from './types';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a program without a shell. Never throws for a non-zero exit; throws if it can't start. */
export function run(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') { reject(new EngineError(`${cmd} not found`)); return; }
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** Find an executable on PATH (plus extra directories). */
export function which(name: string, extraDirs: string[] = []): string | undefined {
  const dirs = [...extraDirs, ...(process.env.PATH ?? '').split(path.delimiter)].filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) { fs.accessSync(full, fs.constants.X_OK); return full; }
    } catch { /* keep looking */ }
  }
  return undefined;
}

export function paginate<T>(all: T[], page: number | undefined, pageSize: number): { items: T[] } & PageInfo {
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, Math.floor(page ?? 1)), pages);
  const start = (p - 1) * pageSize;
  const items = all.slice(start, start + pageSize);
  return { items, page: p, pageSize, pages, total, from: items.length ? start + 1 : 0, to: start + items.length };
}

/** Resolve a user path against the root and refuse anything outside it. Returns [absolute, relative]. */
export function inRoot(root: string, p: string): [string, string] {
  const abs = path.resolve(root, p);
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* may not exist yet; checked by caller */ }
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new EngineError(`${p} is outside the workspace (${root}).`);
  return [real, rel.split(path.sep).join('/')];
}

export function relTo(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function shorten(text: string, max = 110): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new EngineError(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
