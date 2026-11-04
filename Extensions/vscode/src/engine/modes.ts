// Work modes (the Mode pill, ⇧Tab cycles): Ask · Edit · Auto · Plan · Debug, set per chat.
// Pure (no vscode), tested in test/workflow.test.ts. Keep in step with Sources/Ingle/WorkMode.swift.
import * as path from 'path';
import { PLAN_MODE_PROMPT, type TaskItem } from '../tools/tasks';

export type WorkMode = 'ask' | 'edit' | 'auto' | 'plan' | 'debug';
export const WORK_MODES: WorkMode[] = ['ask', 'edit', 'auto', 'plan', 'debug'];

export interface ModeSpec { label: string; role: string; help: string; promptLine: string }

export const MODES: Record<WorkMode, ModeSpec> = {
  ask: {
    label: 'Ask', role: 'Asks first',
    help: 'Ask: every file change and command asks first.',
    promptLine: '',
  },
  edit: {
    label: 'Edit', role: 'Edits freely',
    help: 'Edit: file changes inside the project are approved automatically. Commands, anything outside the project, MCP, SSH and secrets still ask.',
    promptLine: 'Mode: Edit. Your file changes inside the project are approved automatically; commands and anything outside the project still ask.',
  },
  auto: {
    label: 'Auto', role: 'Safe steps auto',
    help: 'Auto: as Edit, plus commands inside the project run without asking, except risky ones (sudo, deleting, git push/reset/clean, network, writes outside the project, secrets).',
    promptLine: 'Mode: Auto. File changes and safe commands inside the project run without asking; risky ones (sudo, deleting, git push, network, anything outside the project) still ask. Stay inside the project.',
  },
  plan: {
    label: 'Plan', role: 'Read only',
    help: 'Plan: the assistant only reads and searches, then ends with a plan to Approve (or change by replying).',
    promptLine: PLAN_MODE_PROMPT,
  },
  debug: {
    label: 'Debug', role: 'Find the cause',
    help: 'Debug: reproduce or locate the failure, state the cause with evidence, then fix and rerun to confirm. Edits are refused until the cause is stated.',
    promptLine: 'Mode: Debug. Work in this order: 1) reproduce or locate the failure (run it, or read and search the code); 2) write the cause with its evidence in a line starting "Cause:"; 3) fix it; 4) rerun the reproduction or the tests to confirm. Ingle refuses edits until you have done 1 and 2.',
  },
};

export function isWorkMode(v: unknown): v is WorkMode {
  return typeof v === 'string' && (WORK_MODES as string[]).includes(v);
}

/** A chat's mode (old chats: Ask). */
export function modeOf(chat: { workMode?: unknown }): WorkMode {
  return isWorkMode(chat.workMode) ? chat.workMode : 'ask';
}

/** ⇧Tab: Ask → Edit → Auto → Plan → Debug → Ask. */
export function nextMode(m: WorkMode): WorkMode {
  return WORK_MODES[(WORK_MODES.indexOf(m) + 1) % WORK_MODES.length];
}

// MARK: auto-approval

/** True if `p` is `root` or inside it (plain path check; paths should already be absolute and resolved). */
export function inside(root: string | undefined, p: string): boolean {
  if (!root || !p) return false;
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Why a command must still ask in Auto mode ('' = safe to run without asking). `cwd` is where it runs. */
export function riskyCommand(command: string, cwd: string, root: string | undefined, home = process.env.HOME ?? ''): string {
  const c = ` ${command.replace(/\s+/g, ' ').trim()} `;
  if (!root || !inside(root, cwd)) return 'it runs outside the project';
  if (/\{\{\s*secret:/.test(c)) return 'it uses a secret';
  if (/[ ;&|(]sudo /.test(c)) return 'it uses sudo';
  if (/[ ;&|(]rm (-[a-zA-Z]*[rRf][a-zA-Z]* |--recursive|--force)/.test(c) || /[ ;&|(]rm -[a-zA-Z]*[rRf]/.test(c)) return 'it deletes recursively or forcibly (rm -r/-f)';
  if (/[ ;&|(]git (push|clean)\b/.test(c) || /[ ;&|(]git reset .*--hard/.test(c)) return 'it can lose or publish work (git push / reset --hard / clean)';
  if (/[ ;&|(](curl|wget|ssh|scp|sftp|rsync|nc|ftp|telnet) /.test(c)) return 'it uses the network';
  if (/[ ;&|(](npm|yarn|pnpm|cargo|gem|twine|poetry|dotnet|swift package) (publish|push|upload)\b/.test(c)) return 'it publishes a package';
  if (/[ ;&|(](npm (install|i|add|ci)|yarn add|pnpm (add|install)|pip3? install|brew install|gem install|cargo install|go install|npx) /.test(c)) return 'it downloads packages';
  if (/\|\s*(ba|z)?sh\b|[ ;&|(](eval|bash -c|sh -c|zsh -c) /.test(c)) return 'it runs code it builds on the fly';
  if (/[ ;&|(](kill|killall|pkill|shutdown|reboot|launchctl|osascript|diskutil|defaults write|chown) /.test(c)) return 'it changes the system';
  // Writes or deletes that reach outside the project: any absolute, ~ or ../ path outside it, with a writing command.
  const writes = /(>>?|[ ;&|(](cp|mv|tee|touch|mkdir|ln|chmod|rm|rmdir|dd|install|truncate|unlink) )/.test(c);
  if (writes) {
    for (const raw of c.match(/(?:^|[\s=>"'])((?:~|\.\.|\/)[^\s"';|&<>()]*)/g) ?? []) {
      const t = raw.replace(/^[\s=>"']/, '');
      if (t === '/dev/null' || t.startsWith('/dev/std')) continue;
      const abs = t.startsWith('~') ? path.join(home, t.slice(1)) : path.resolve(cwd, t);
      if (!inside(root, abs)) return 'it writes or deletes outside the project';
    }
  }
  return '';
}

/** What a mode decides for one approval: auto-approve (with the note shown in the run log) or ask. */
export function autoApproval(mode: WorkMode, req: { kind: string; toolName: string; target?: string; command?: string; secrets?: boolean }, root: string | undefined): string | undefined {
  if (mode !== 'edit' && mode !== 'auto') return undefined;
  if (req.secrets) return undefined;
  const label = MODES[mode].label;
  if ((req.kind === 'edit' || req.kind === 'write') && (req.toolName === 'edit_file' || req.toolName === 'write_file')) {
    return req.target && inside(root, req.target) ? `Auto approved (${label} mode): a file change inside the project` : undefined;
  }
  if (mode === 'auto' && req.kind === 'command' && (req.toolName === 'run_command' || req.toolName === 'get_problems')) {
    const cwd = req.target || root || '';
    if (riskyCommand(req.command ?? '', cwd, root)) return undefined;
    return `Auto approved (Auto mode): a safe command inside the project`;
  }
  return undefined;
}

// MARK: Debug mode

export interface DebugState { located: boolean; cause: boolean; edited: boolean; confirmed: boolean; nudges: number }
export function newDebugState(): DebugState { return { located: false, cause: false, edited: false, confirmed: false, nudges: 0 }; }

const LOOKING = new Set(['read_file', 'list_files', 'find_files', 'search_code', 'repo_map', 'get_problems', 'run_command', 'delegate']);
const RUNS = new Set(['run_command', 'get_problems']);
const EDITS = new Set(['edit_file', 'write_file']);

/** The task list Debug mode starts with. */
export function debugTasks(): TaskItem[] {
  return [
    { content: 'Reproduce or locate the failure', status: 'in_progress' },
    { content: 'Find the cause (write "Cause:" with the evidence)', status: 'pending' },
    { content: 'Fix it', status: 'pending' },
    { content: 'Confirm: rerun the reproduction or the tests', status: 'pending' },
  ];
}

/** Debug's own task list ticked from what has happened (the model may never call update_tasks). Returns the new
 *  list, or undefined when the chat's list isn't Debug's (the model replaced it) or nothing changed. */
export function debugTick(s: DebugState, list: TaskItem[] | undefined): TaskItem[] | undefined {
  const base = debugTasks();
  if (!list || list.length !== base.length || list.some((t, i) => t.content !== base[i].content)) return undefined;
  const done = [s.located, s.cause, s.edited, s.confirmed];
  let first = done.indexOf(false);
  if (first < 0) first = base.length;
  const next: TaskItem[] = base.map((t, i) => ({ content: t.content, status: i < first ? 'done' : i === first ? 'in_progress' : 'pending' }));
  return next.every((t, i) => t.status === list[i].status) ? undefined : next;
}

/** Notes what the assistant wrote (a "Cause:" line counts as stating the cause). */
export function debugSaw(s: DebugState, replyText: string): void {
  if (/(^|\n)\s*(\*\*)?(root )?cause(\*\*)?\s*:/i.test(replyText)) s.cause = true;
}

/** The refusal for an edit that comes too early, or undefined when it may go ahead. */
export function debugRefusal(s: DebugState, toolName: string): string | undefined {
  if (!EDITS.has(toolName) || (s.located && s.cause)) return undefined;
  const need = !s.located
    ? 'first reproduce or locate the failure (run it, or read and search the code), then write the cause with its evidence in a line starting "Cause:"'
    : 'first write the cause with its evidence in a line starting "Cause:"';
  return `Debug mode: don’t edit yet — ${need}. Then fix it.`;
}

/** Records a tool call that ran (not denied or refused). */
export function debugRecord(s: DebugState, toolName: string): void {
  if (LOOKING.has(toolName)) s.located = true;
  if (EDITS.has(toolName)) { s.edited = true; s.confirmed = false; }
  else if (RUNS.has(toolName) && s.edited) s.confirmed = true;
}

/** Before finishing: a hidden nudge to confirm the fix (at most 2), or undefined. */
export function debugFinishNudge(s: DebugState): string | undefined {
  if (!s.edited || s.confirmed || s.nudges >= 2) return undefined;
  s.nudges++;
  return 'Ingle: before you finish (Debug mode), rerun the reproduction or the tests to confirm the fix (run_command), then finish your answer.';
}

/** The chip when the fix was never confirmed. */
export const DEBUG_UNCONFIRMED_CHIP = '⚠ fix not confirmed';
