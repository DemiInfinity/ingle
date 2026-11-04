// run_command and open_url.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DENIED, baseFolder, isDir, isInProject, resolvePath, tidy } from './paths';
import { capOutput, MAX_OUT } from './output';
import { str, type ToolDef } from './types';

export { capOutput };

const TIMEOUT_MS = 120_000;

function shell(): string {
  if (fs.existsSync('/bin/zsh')) return '/bin/zsh';
  return process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]/g, '');

export function runShell(command: string, cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let size = 0;
    const chunks: string[] = [];
    let finished = false;
    let why: 'timeout' | 'stopped' | null = null;
    const sh = shell();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(sh, [sh.endsWith('zsh') || sh.endsWith('bash') ? '-lc' : '-c', command], {
        cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', CI: process.env.CI ?? '1' },
      });
    } catch (e) {
      resolve(`Couldn't start the command: ${(e as Error).message}`);
      return;
    }
    const kill = () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
      setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
    };
    const onData = (d: Buffer) => {
      // Keep memory bounded: hold at most ~4× the cap, trimming the middle as we go.
      chunks.push(d.toString('utf8'));
      size += d.length;
      if (size > MAX_OUT * 4) { out = capOutput(chunks.join(''), MAX_OUT * 2); chunks.length = 0; chunks.push(out); size = out.length; }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => { why = 'timeout'; kill(); }, TIMEOUT_MS);
    const onAbort = () => { why = 'stopped'; kill(); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    const done = (code: number | null, sig: NodeJS.Signals | null, err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (err) { resolve(`Couldn't start the command: ${err.message}`); return; }
      const text = capOutput(stripAnsi(chunks.join('')).replace(/\r\n/g, '\n').trimEnd());
      const status = why === 'timeout' ? 'stopped after 2 minutes'
        : why === 'stopped' ? 'stopped by the user'
          : code !== null ? `exit code ${code}` : `killed (${sig ?? 'signal'})`;
      resolve(`${status}\n${text || '(no output)'}`);
    };
    child.on('error', (e) => done(null, null, e));
    child.on('close', (code, sig) => done(code, sig));
  });
}

const runCommand: ToolDef = {
  name: 'run_command',
  description: 'Run a zsh command in the project folder and return its output and exit code (2-minute limit). Use for builds, tests, git and scripts. The user approves.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The command to run' }, cwd: { type: 'string', description: 'Optional folder inside the project to run it in' } },
    required: ['command'],
  },
  readOnly: false,
  available: () => true,
  describe: (a) => {
    const cwd = str(a, 'cwd').trim();
    return { title: 'Run a command', detail: cwd ? `cd ${cwd} && ${str(a, 'command')}` : str(a, 'command'), icon: 'terminal' };
  },
  async run(a, ctx) {
    const command = str(a, 'command');
    if (!command.trim()) return 'Give me a command to run.';
    let cwd = path.resolve(baseFolder(ctx.workspaceRoot));
    const given = str(a, 'cwd').trim();
    if (given) {
      const abs = resolvePath(given, ctx.workspaceRoot);
      if (!isDir(abs)) return `There's no folder at ${tidy(abs)}.`;
      if (!isInProject(abs, ctx)) return `cwd must be inside the project (${tidy(cwd)}). Leave it out, or use a folder inside the project.`;
      cwd = abs;
    }
    if (!isDir(cwd)) return 'There is no project folder to run the command in.';
    const answer = await ctx.requestApproval({
      kind: 'command', title: 'Wants to run a command',
      detail: given ? `cd ${tidy(cwd)} && ${command}` : command,
    });
    if (answer !== 'allow') return DENIED;
    ctx.setActivity('Running a command…');
    try { return await runShell(command, cwd, ctx.signal); } finally { ctx.setActivity(null); }
  },
};

const openUrl: ToolDef = {
  name: 'open_url',
  description: 'Open a web address in the user\'s browser (e.g. a local dev server or docs page). The user approves.',
  parameters: { type: 'object', properties: { url: { type: 'string', description: 'The full http(s):// address' } }, required: ['url'] },
  readOnly: false,
  available: () => true,
  describe: (a) => ({ title: 'Open a link', detail: str(a, 'url'), icon: 'globe' }),
  async run(a, ctx) {
    const raw = str(a, 'url').trim();
    let url: URL;
    try { url = new URL(raw); } catch { return "That isn't a web address. Use a full https:// link."; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'I can only open http:// and https:// links.';
    const answer = await ctx.requestApproval({ kind: 'open', title: 'Wants to open a link', detail: url.toString() });
    if (answer !== 'allow') return DENIED;
    try {
      const ok = await vscode.env.openExternal(vscode.Uri.parse(url.toString(), true));
      return ok ? `Opened ${url.toString()}.` : `Couldn't open ${url.toString()}.`;
    } catch (e) {
      return `Couldn't open the link: ${(e as Error).message}`;
    }
  },
};

export const commandTools: ToolDef[] = [runCommand, openUrl];
