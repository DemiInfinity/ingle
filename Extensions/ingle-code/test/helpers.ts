import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export const PKG = path.resolve(__dirname, '..', '..');
export const FIXTURES = path.join(PKG, 'test', 'fixtures');

const made: string[] = [];

/** Copy a fixture project to a fresh temp folder (so servers never write into the repo). Optionally make it a git repo. */
export function copyFixture(name: string, opts: { git?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ingle-code-${name}-`));
  made.push(dir);
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  if (opts.git) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture');
  }
  return fs.realpathSync(dir);
}

export function cleanup(): void {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

export function onPath(cmd: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    try { fs.accessSync(path.join(dir, cmd), fs.constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}
