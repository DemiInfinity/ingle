// Commit a run's files: find their repository, draft a message from the diff, then `git add` exactly those files and
// `git commit`. Never pushes. Pure Node (no vscode), tested in test/workflow.test.ts.
// Keep in step with Sources/Ingle/ChangesPanel.swift (GitCommit).
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function git(cwd: string, args: string[], input?: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout), err: String(stderr || (error ? error.message : '')) });
    });
    if (input !== undefined) { child.stdin?.end(input); }
  });
}

/** The nearest existing folder for a path (a file the run deleted no longer exists). */
function existingDir(p: string): string {
  let d = path.dirname(p);
  for (let i = 0; i < 64 && !fs.existsSync(d); i++) d = path.dirname(d);
  return d;
}

/** The repository holding all these files, or an explanation when there isn't exactly one. */
export async function repoFor(files: string[]): Promise<{ repo: string } | { error: string }> {
  const repos = new Set<string>();
  for (const f of files) {
    const r = await git(existingDir(f), ['rev-parse', '--show-toplevel']);
    if (!r.ok) return { error: `${path.basename(f)} isn’t in a git repository.` };
    repos.add(fs.realpathSync(r.out.trim()));
  }
  if (repos.size !== 1) return { error: repos.size ? 'These files are in more than one repository, so commit them yourself.' : 'No files to commit.' };
  return { repo: [...repos][0] };
}

/** Paths relative to the repo (with symlinks like /tmp → /private/tmp resolved). */
export function relativeTo(repo: string, files: string[]): string[] {
  return files.map((f) => {
    let abs = f;
    try { abs = path.join(fs.realpathSync(existingDir(f)), path.relative(existingDir(f), f)); } catch { /* keep */ }
    return path.relative(repo, abs);
  });
}

/** The diff of just these files against HEAD (new files shown whole), capped for the model. */
export async function diffFor(repo: string, rel: string[], max = 12000): Promise<string> {
  let out = (await git(repo, ['diff', 'HEAD', '--', ...rel])).out;
  for (const f of rel) {
    const tracked = (await git(repo, ['ls-files', '--', f])).out.trim();
    if (!tracked) {
      try { out += `\n--- /dev/null\n+++ b/${f}\n` + fs.readFileSync(path.join(repo, f), 'utf8').split('\n').map((l) => '+' + l).join('\n').slice(0, 4000); } catch { /* gone */ }
    }
  }
  return out.length > max ? out.slice(0, max) + '\n…(diff trimmed)' : out;
}

/** The question asked of the model to draft a commit message. */
export function commitPrompt(diff: string): string {
  return 'Write a git commit message for this change. First line: a summary in the imperative, under 60 characters, no full stop. ' +
    'Then, only if useful, a blank line and up to three short lines saying why. British English. Reply with the message only — no quotes, no code fences.\n\n' +
    '```diff\n' + diff + '\n```';
}

/** Cleans what the model wrote into a commit message ('' if nothing usable). */
export function cleanCommitMessage(text: string, fallbackFiles: string[] = []): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  t = t.replace(/^(commit message|message)\s*:\s*/i, '').replace(/^["'“]|["'”]$/g, '').trim();
  // git takes everything up to the first blank line as the subject: keep the summary line on its own.
  if (t) return formatMessage(t);
  if (!fallbackFiles.length) return '';
  const names = fallbackFiles.map((f) => path.basename(f));
  return `Update ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
}

/** A blank line after the summary (git folds lines without one into the subject), no trailing spaces. */
export function formatMessage(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd());
  if (lines.length > 1 && lines[1].trim()) lines.splice(1, 0, '');
  return lines.join('\n').trim();
}

/** The commands that will run (shown on the approval card). */
export function commitCommandText(rel: string[], signOff: boolean): string {
  const q = (s: string) => (/^[\w./@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return `git add -A -- ${rel.map(q).join(' ')}\ngit commit${signOff ? ' -s' : ''} -F <message> -- ${rel.map(q).join(' ')}`;
}

/** Stages exactly these files (including deletions) and commits only them, with the message. Never pushes.
 *  Returns the new commit's short hash, or an error sentence. */
export async function commitFiles(repo: string, rel: string[], message: string, signOff: boolean): Promise<{ hash: string; summary: string } | { error: string }> {
  if (!rel.length) return { error: 'No files to commit.' };
  if (!message.trim()) return { error: 'The commit message is empty.' };
  // Files the run created and then removed again are neither on disk nor in git: leave them out.
  const keep: string[] = [];
  for (const f of rel) {
    if (fs.existsSync(path.join(repo, f)) || (await git(repo, ['ls-files', '--error-unmatch', '--', f])).ok) keep.push(f);
  }
  if (!keep.length) return { error: 'None of these files have changes to commit.' };
  const add = await git(repo, ['add', '-A', '--', ...keep]);
  if (!add.ok) return { error: 'git add failed: ' + add.err.trim() };
  // `--` with paths commits only these files, even if other changes are staged.
  const args = ['commit', ...(signOff ? ['-s'] : []), '-F', '-', '--', ...keep];
  const c = await git(repo, args, formatMessage(message) + '\n');
  if (!c.ok) {
    const why = (c.err + '\n' + c.out).trim();
    if (/nothing to commit|no changes added/i.test(why)) return { error: 'Nothing to commit: these files already match the last commit.' };
    return { error: 'git commit failed: ' + why.split('\n').slice(0, 6).join('\n') };
  }
  const hash = (await git(repo, ['rev-parse', '--short', 'HEAD'])).out.trim();
  return { hash, summary: message.trim().split('\n')[0] };
}
