// Workspace files and fast text search (git grep, with a plain Node fallback when git isn't there).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run } from './util';

export const SKIP_DIRS = new Set(['node_modules', '.git', '.build', '.swiftpm', 'out', 'out-test', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', 'DerivedData', 'Pods', '.next', 'coverage', 'vendor']);
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface GrepHit {
  file: string;
  /** 1-based. */
  line: number;
  text: string;
}

function skipped(rel: string): boolean {
  return rel.split('/').some((part) => SKIP_DIRS.has(part));
}

export class Workspace {
  private files?: string[];
  private filesAt = 0;
  private gitChecked?: boolean;

  constructor(readonly root: string) {}

  async isGit(): Promise<boolean> {
    if (this.gitChecked === undefined) {
      try {
        const r = await run('git', ['rev-parse', '--is-inside-work-tree'], this.root, 10_000);
        this.gitChecked = r.code === 0 && r.stdout.trim() === 'true';
      } catch { this.gitChecked = false; }
    }
    return this.gitChecked;
  }

  /** All files (relative, "/"-separated), cached for 5 seconds. */
  async list(): Promise<string[]> {
    if (this.files && Date.now() - this.filesAt < 5000) return this.files;
    let out: string[] | undefined;
    if (await this.isGit()) {
      try {
        const r = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], this.root);
        if (r.code === 0) out = [...new Set(r.stdout.split('\0').filter(Boolean))].filter((f) => !skipped(f) && fs.existsSync(path.join(this.root, f)));
      } catch { /* fall through */ }
    }
    if (!out) out = this.walk();
    out.sort();
    this.files = out;
    this.filesAt = Date.now();
    return out;
  }

  private walk(): string[] {
    const out: string[] = [];
    const stack = [''];
    while (stack.length && out.length < MAX_FILES) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(path.join(this.root, dir), { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(rel); }
        else if (e.isFile()) out.push(rel);
      }
    }
    return out;
  }

  /** Lines containing any of `words` as whole words. */
  async grepWords(words: string[]): Promise<GrepHit[]> {
    if (!words.length) return [];
    const args = ['grep', '-z', '-n', '-I', '-w', '-F'];
    for (const w of words) args.push('-e', w);
    const excludes = [...SKIP_DIRS].map((d) => `:(exclude,glob)**/${d}/**`);
    let r;
    try {
      if (await this.isGit()) r = await run('git', [...args.slice(0, 1), '--untracked', ...args.slice(1), '--', '.', ...excludes], this.root);
      else r = await run('git', [args[0], '--no-index', '--exclude-standard', ...args.slice(1), '--', '.', ...excludes], this.root);
    } catch {
      r = undefined;
    }
    if (r && (r.code === 0 || r.code === 1)) return parseGrep(r.stdout);
    return this.nodeGrep(words);
  }

  private async nodeGrep(words: string[]): Promise<GrepHit[]> {
    const re = new RegExp(`(?<![\\w$])(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w$])`);
    const out: GrepHit[] = [];
    for (const f of await this.list()) {
      const text = this.read(f);
      if (text === undefined || text.includes('\0')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) out.push({ file: f, line: i + 1, text: lines[i] });
    }
    return out;
  }

  /** Read a workspace file as text (undefined if missing or too big). */
  read(rel: string): string | undefined {
    try {
      const abs = path.join(this.root, rel);
      if (fs.statSync(abs).size > MAX_FILE_BYTES) return undefined;
      return fs.readFileSync(abs, 'utf8');
    } catch { return undefined; }
  }

  /** Files changed since the last commit (modified, added, untracked). Empty when not a git repo. */
  async changed(): Promise<string[]> {
    if (!(await this.isGit())) return [];
    const r = await run('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.'], this.root);
    if (r.code !== 0) return [];
    const prefix = (await run('git', ['rev-parse', '--show-prefix'], this.root)).stdout.trim();
    const out: string[] = [];
    const parts = r.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.length < 4) continue;
      const status = p.slice(0, 2);
      let file = p.slice(3);
      if (status[0] === 'R' || status[0] === 'C') i++; // the next part is the old name
      if (status.includes('D')) continue;
      if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length);
      if (!skipped(file)) out.push(file);
    }
    return out;
  }
}

export function parseGrep(stdout: string): GrepHit[] {
  const out: GrepHit[] = [];
  // -z output: file \0 line \0 text \n
  let i = 0;
  while (i < stdout.length) {
    const a = stdout.indexOf('\0', i);
    if (a < 0) break;
    const b = stdout.indexOf('\0', a + 1);
    if (b < 0) break;
    let c = stdout.indexOf('\n', b + 1);
    if (c < 0) c = stdout.length;
    out.push({ file: stdout.slice(i, a), line: Number(stdout.slice(a + 1, b)), text: stdout.slice(b + 1, c) });
    i = c + 1;
  }
  return out;
}

/** 0-based columns where `word` appears as a whole word in `text`. */
export function wordColumns(text: string, word: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(word, from);
    if (i < 0) break;
    const before = i > 0 ? text[i - 1] : '';
    const after = text[i + word.length] ?? '';
    if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) out.push(i);
    from = i + word.length;
  }
  return out;
}
