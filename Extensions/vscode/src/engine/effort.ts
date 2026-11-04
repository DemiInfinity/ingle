// Effort levels: how hard the assistant tries. One table, kept in step with Sources/Ingle/Effort.swift —
// change both together (and the prompt facts, HelpTopics and docs/agent-loop.md).
// Pure: no vscode API, so test/effort.test.ts can check it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandEntry } from '../tools/commands';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'max'];

export interface EffortSpec {
  label: string;
  /** Ollama `think`: false = off, otherwise the level for models that take one (others get `true`). */
  think: false | 'low' | 'medium' | 'high';
  /** Line added to the system prompt ('' = none). */
  promptLine: string;
  /** strict: fewer optional tools; normal: as before; relaxed: the helper is always offered too. */
  tools: 'strict' | 'normal' | 'relaxed';
  /** Run the project's check command once after changing files, before finishing. */
  verify: boolean;
  /** A short plan first, which becomes the chat's task list. */
  plan: boolean;
  /** A read-only helper reviews the changes at the end. */
  review: boolean;
  /** Coverage checks (coverage.ts): places `impact` listed must be looked at before finishing. */
  coverage: boolean;
  /** The nth identical call is skipped. */
  repeatLimit: number;
  /** Stop after this many skipped calls. */
  stuckLimit: number;
  /** Tooltip / help text. */
  help: string;
}

export const EFFORT: Record<EffortLevel, EffortSpec> = {
  low: {
    label: 'Low', think: false,
    promptLine: 'Answer directly in as few steps as possible.',
    tools: 'strict', verify: false, plan: false, review: false, coverage: false, repeatLimit: 3, stuckLimit: 4,
    help: 'Low: quick answers, no thinking, fewest tools.',
  },
  medium: {
    label: 'Medium', think: 'low',
    promptLine: '',
    tools: 'normal', verify: false, plan: false, review: false, coverage: false, repeatLimit: 3, stuckLimit: 4,
    help: 'Medium: thinks a little. Good for everyday work.',
  },
  high: {
    label: 'High', think: 'medium',
    promptLine: 'Investigate before changing anything: read the related code, then check your work. For a job of 3 or more steps, keep a task list with update_tasks.',
    tools: 'relaxed', verify: true, plan: false, review: false, coverage: true, repeatLimit: 4, stuckLimit: 6,
    help: 'High: thinks more, reads the related code first, checks every place a change affects, and runs the project’s checks after editing.',
  },
  max: {
    label: 'Max', think: 'high',
    promptLine: 'Plan first, investigate fully, verify with the project\'s checks, then review your own changes before finishing. Work through your task list and keep it current with update_tasks.',
    tools: 'relaxed', verify: true, plan: true, review: true, coverage: true, repeatLimit: 4, stuckLimit: 6,
    help: 'Max: plans first as a task list, thinks hardest, runs the checks, and a helper reviews the changes at the end.',
  },
};

export function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as string[]).includes(v);
}

/** The next level for the pill's cycle (Low → Medium → High → Max → Low). */
export function nextEffort(e: EffortLevel): EffortLevel {
  return EFFORT_LEVELS[(EFFORT_LEVELS.indexOf(e) + 1) % EFFORT_LEVELS.length];
}

/** Default per assistant: Ember (daily) Medium, Flint (hard) High. */
export function defaultEffort(assistantId: string, configured?: unknown): EffortLevel {
  if (isEffort(configured)) return configured;
  return assistantId === 'hard' ? 'high' : 'medium';
}

/** A chat's level. Chats saved before effort levels had only Think: on → High, off → Medium. */
export function chatEffort(chat: { effort?: unknown; think?: unknown }, fallback: EffortLevel): EffortLevel {
  if (isEffort(chat.effort)) return chat.effort;
  if (typeof chat.think === 'boolean') return chat.think ? 'high' : 'medium';
  return fallback;
}

/** Models whose `think` takes "low" | "medium" | "high" (Ollama: gpt-oss). Others take true/false. */
export function takesThinkLevels(model: string): boolean {
  return /gpt-oss/i.test(model);
}

/** What to send as Ollama's `think` for this level and model. */
export function thinkParam(e: EffortLevel, model: string): boolean | 'low' | 'medium' | 'high' {
  const t = EFFORT[e].think;
  if (t === false) return false;
  return takesThinkLevels(model) ? t : true;
}

// MARK: the project's check command

export interface CheckCommand { command: string; dir: string; why: string }

const exists = (p: string) => { try { return fs.existsSync(p); } catch { return false; } };
const read = (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** npm's placeholder test script doesn't count. */
const PLACEHOLDER_TEST = /no test specified/;

/** The check command for one folder, or undefined. Order: package.json test → lint, Package.swift, Cargo.toml,
 *  go.mod, a Makefile with a test target, Python with pytest. Same as Effort.checkCommand(in:) in Swift. */
export function checkCommandIn(dir: string): CheckCommand | undefined {
  const pkg = path.join(dir, 'package.json');
  if (exists(pkg)) {
    let scripts: Record<string, unknown> = {};
    try { scripts = (JSON.parse(read(pkg)) as { scripts?: Record<string, unknown> }).scripts ?? {}; } catch { /* bad JSON */ }
    const runner = exists(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : exists(path.join(dir, 'yarn.lock')) ? 'yarn' : 'npm';
    if (typeof scripts.test === 'string' && scripts.test.trim() && !PLACEHOLDER_TEST.test(scripts.test)) {
      return { command: `${runner} test`, dir, why: 'package.json test script' };
    }
    if (typeof scripts.lint === 'string' && scripts.lint.trim()) {
      return { command: `${runner} run lint`, dir, why: 'package.json lint script' };
    }
  }
  if (exists(path.join(dir, 'Package.swift'))) return { command: 'swift build', dir, why: 'Package.swift' };
  if (exists(path.join(dir, 'Cargo.toml'))) return { command: 'cargo check', dir, why: 'Cargo.toml' };
  if (exists(path.join(dir, 'go.mod'))) return { command: 'go test ./...', dir, why: 'go.mod' };
  const makefile = ['Makefile', 'makefile', 'GNUmakefile'].map((f) => path.join(dir, f)).find(exists);
  if (makefile && /^test\s*:/m.test(read(makefile))) return { command: 'make test', dir, why: 'Makefile test target' };
  if (exists(path.join(dir, 'pytest.ini')) || exists(path.join(dir, 'conftest.py'))
      || /\[tool\.pytest/.test(read(path.join(dir, 'pyproject.toml')))
      || /\[(tool:)?pytest\]/.test(read(path.join(dir, 'setup.cfg')))
      || /\[pytest\]/.test(read(path.join(dir, 'tox.ini')))) {
    return { command: 'pytest', dir, why: 'pytest config' };
  }
  return undefined;
}

/** Walks up from `start` (a file or folder) to find the nearest folder with a check command. Stops at `stopAt`
 *  (e.g. the workspace root) if given, and never goes above the home folder or to /. */
export function detectCheckCommand(start: string, stopAt?: string, home = os.homedir()): CheckCommand | undefined {
  let dir = path.resolve(start);
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { dir = path.dirname(dir); }
  const stop = stopAt ? path.resolve(stopAt) : undefined;
  for (let i = 0; i < 40; i++) {
    if (dir === home || dir === path.parse(dir).root) return undefined;
    const found = checkCommandIn(dir);
    if (found) return found;
    if (stop && dir === stop) return undefined;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/** Name of the built-in verify command (shown in nudges and the ⚠ chip). */
export const VERIFY_NAME = 'verify';

/** The built-in "verify after editing" command for High/Max, in the same shape as a user command so the
 *  command checks (then_run, nudges, ⚠ chips) enforce it. */
export function verifyCommand(check: CheckCommand): CommandEntry {
  return {
    name: VERIFY_NAME,
    description: `Effort: run the project's checks after editing (${check.why})`,
    when: [], always: true,
    mustUse: [], neverUse: [],
    thenRun: check.command,
    enabled: true,
    body: `Run it once in ${check.dir} (run_command with cwd "${check.dir}") after your last change, and fix what it reports.`,
    file: check.dir,
  };
}

/** The chip when High/Max changed files but no check command could be found. */
export const VERIFY_SKIPPED_CHIP = 'verify skipped: no check command found';

/** The question asked of the model for Max's plan step (not saved in the chat). The numbered steps become the chat's
 *  task list (tasks.ts tasksFromPlan); one line means no list. */
export const PLAN_REQUEST = 'Ingle: before doing anything, write a short plan for this request: 2–6 numbered steps, one line each. Don\'t do the work yet and don\'t call tools. If the request is simple, one line is enough.';

export const REVIEW_HEADING = '**Review**';

/** The task given to the read-only helper that reviews Max's changes. */
export function reviewTask(request: string, files: string[], diff: string): string {
  const d = diff.trim() ? `\n\nThe diff:\n\`\`\`diff\n${diff.slice(0, 12000)}\n\`\`\`` : '\n\n(No git diff available — read the files.)';
  return `Review the changes just made for this request: "${request.slice(0, 1500)}".\nChanged files:\n${files.map((f) => `- ${f}`).join('\n')}${d}\n\nLook for bugs, missed cases, and anything that doesn't match the request. Reply with a few short notes (most important first), or "Looks good" if you find nothing. Don't rewrite the code.`;
}
