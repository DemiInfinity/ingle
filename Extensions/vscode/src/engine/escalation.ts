// Second opinion (task 35): when a run is truly stuck, the harness (never the model) offers a stronger model or a
// copy-only brief for a cloud AI. Pure apart from reading project files for the brief: test/escalation.test.ts
// checks it. Same rules and wording as Escalation.swift.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectSecrets, scrub } from '../tools/secretsCore';

// MARK: triggers

/** Why the card is offered. Decided from what happened in the run, never from the model saying it's unsure. */
export type TriggerKind = 'stuck' | 'check-failed' | 'command-ignored' | 'review-problems' | 'coverage';
export interface Trigger { kind: TriggerKind; reason: string }

/** The same check failing this many times in one run offers the card. */
export const CHECK_FAIL_LIMIT = 3;

export interface Attempt {
  tool: string;
  /** The command, path or query, shortened. */
  what: string;
  outcome: 'ok' | 'failed' | 'denied' | 'skipped';
}

/** What one run did, for the triggers and the brief. One per run (one reply to a message). */
export interface RunLog {
  root?: string;
  /** Tool calls made (any outcome). Runs with none (ordinary chat) are never offered the card. */
  tools: number;
  attempts: Attempt[];
  /** Check key → failures this run. */
  checkFailures: Record<string, number>;
  /** Failed checks and commands, newest last: what failed and the end of its output. */
  errors: { what: string; text: string }[];
  /** Absolute paths the run read, and changed. */
  read: string[];
  changed: string[];
  triggers: Trigger[];
  /** Set once the card has been offered (at most once per run). */
  offered: boolean;
}

export function newRunLog(root?: string): RunLog {
  return { root, tools: 0, attempts: [], checkFailures: {}, errors: [], read: [], changed: [], triggers: [], offered: false };
}

export function addTrigger(log: RunLog, kind: TriggerKind, reason: string): void {
  if (log.triggers.some((t) => t.kind === kind && t.reason === reason)) return;
  log.triggers.push({ kind, reason });
}

export const STUCK_REASON = 'It went round in circles and stopped.';
export const REVIEW_REASON = 'The review found problems that weren’t fixed.';
export function commandReason(name: string): string { return `The command “${name}” still wasn’t followed after reminders.`; }
export function checkReason(label: string, n: number): string { return `\`${label}\` failed ${n} times.`; }
/** Task 34 (coverage) calls addTrigger(log, 'coverage', coverageReason(n)) when affected places stay unresolved. */
export function coverageReason(n: number): string { return `${n} affected place${n === 1 ? '' : 's'} not checked.`; }

/** Commands that are a project's checks: tests, builds, type-checks and linters. */
const CHECK_RE = new RegExp([
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|lint|build|check|typecheck|type-check|verify)\b`,
  String.raw`\bnpx\s+(tsc|jest|vitest|mocha|eslint|playwright)\b`, String.raw`(^|[\s;&|])tsc(\s|$)`,
  String.raw`\bswift\s+(build|test)\b`, String.raw`\bxcodebuild\b`, String.raw`\bcargo\s+(test|build|check|clippy)\b`,
  String.raw`\bgo\s+(test|build|vet)\b`, String.raw`\bpytest\b`, String.raw`\bpython3?\s+-m\s+(pytest|unittest|mypy)\b`,
  String.raw`(^|[\s;&|])make(\s+(test|check|build|all))?(\s|$)`, String.raw`\bgradlew?\s+\w*(test|build|check)`,
  String.raw`\bmvn\b`, String.raw`\bdotnet\s+(test|build)\b`, String.raw`\bnode\s+--test\b`, String.raw`\bjest\b`,
  String.raw`\bvitest\b`, String.raw`\bmypy\b`, String.raw`\bruff\b`, String.raw`\brspec\b`, String.raw`\bphpunit\b`,
  String.raw`\bctest\b`, String.raw`\bdeno\s+(test|check)\b`, String.raw`\bflutter\s+test\b`,
].join('|'), 'i');

/** "cd x && npm test 2>&1 | tail -50" → "npm test": the same check written slightly differently is still the same. */
export function normaliseCommand(command: string): string {
  let c = command.trim().replace(/\s+/g, ' ');
  // Every leading `cd dir &&` (models often add one even when the cwd is already the project).
  while (/^cd [^;&|]+(&&|;)\s*/.test(c)) c = c.replace(/^cd [^;&|]+(&&|;)\s*/, '');
  c = c.replace(/\s*\|\s*(tail|head|grep|cat|less|tee)\b.*$/, '');
  c = c.replace(/\s*2>&1\s*/g, ' ').trim();
  return c;
}

/** The check a call runs ("npm test", "get_problems"), or undefined if it isn't one. `known` = the project's
 *  check commands (the verify command, then_run) that count whatever they look like. */
export function checkKey(name: string, args: Record<string, unknown>, known: string[] = []): string | undefined {
  if (name === 'get_problems') {
    const cmd = typeof args.command === 'string' ? normaliseCommand(args.command) : '';
    return cmd ? `get_problems (${cmd})` : 'get_problems';
  }
  if (name !== 'run_command') return undefined;
  const raw = typeof args.command === 'string' ? args.command : '';
  const c = normaliseCommand(raw);
  if (!c) return undefined;
  const isKnown = known.some((k) => k.trim() && c.toLowerCase().includes(normaliseCommand(k).toLowerCase()));
  return isKnown || CHECK_RE.test(c) ? c : undefined;
}

/** Whether a tool's output says it failed: a non-zero exit, a timeout, or get_problems reporting errors.
 *  Same output formats in both apps ("exit code N" first line; "N errors, M warnings"). */
export function callFailed(name: string, output: string): boolean {
  const first = output.trimStart().split('\n', 1)[0] ?? '';
  if (name === 'run_command' || name === 'ssh_command') {
    const m = /^exit code (-?\d+)/.exec(first);
    if (m) return m[1] !== '0';
    return /^(stopped after|killed \(|Couldn['’]t start)/.test(first);
  }
  if (name === 'get_problems') {
    const m = /^(\d+) errors?,/.exec(first);
    if (m) return Number(m[1]) > 0;
    return /failed \(exit code/.test(first);
  }
  return /^(The tool failed|Couldn['’]t |Error:)/.test(first);
}

const READ_TOOLS = ['read_file'];
const DEFAULT_CHANGING = ['edit_file', 'write_file'];

function short(s: string, max = 140): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function argText(args: Record<string, unknown>): string {
  for (const k of ['command', 'path', 'query', 'pattern', 'url', 'name', 'task', 'host']) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** Absolute path for a tool's path argument (~ and relative paths resolved). */
export function absPath(p: string, root?: string): string {
  const t = p.trim();
  if (!t) return '';
  if (t === '~' || t.startsWith('~/')) return path.join(os.homedir(), t.slice(1));
  return path.isAbsolute(t) ? path.normalize(t) : path.resolve(root ?? os.homedir(), t);
}

/** The end of an output: errors are usually at the bottom. */
export function tail(text: string, lines = 40, chars = 3000): string {
  let t = text.trimEnd().split('\n').slice(-lines).join('\n');
  if (t.length > chars) t = '…' + t.slice(-chars);
  return t;
}

export interface CallResult {
  name: string;
  args: Record<string, unknown>;
  output: string;
  denied?: boolean;
  skipped?: boolean;
}

/** Records one tool call. Returns true when this call made a check reach CHECK_FAIL_LIMIT failures (trigger added). */
export function recordCall(log: RunLog, r: CallResult, opts: { known?: string[]; changing?: string[] } = {}): boolean {
  log.tools++;
  const what = short(argText(r.args) || r.name);
  if (r.skipped) { log.attempts.push({ tool: r.name, what, outcome: 'skipped' }); return false; }
  if (r.denied) { log.attempts.push({ tool: r.name, what, outcome: 'denied' }); return false; }
  const failed = callFailed(r.name, r.output);
  log.attempts.push({ tool: r.name, what, outcome: failed ? 'failed' : 'ok' });
  const p = typeof r.args.path === 'string' ? absPath(r.args.path, log.root) : '';
  if (p) {
    const changing = opts.changing ?? DEFAULT_CHANGING;
    if (changing.includes(r.name) && !failed) { if (!log.changed.includes(p)) log.changed.push(p); }
    else if ((READ_TOOLS.includes(r.name) || changing.includes(r.name)) && !log.read.includes(p)) log.read.push(p);
  }
  if (!failed) return false;
  const key = checkKey(r.name, r.args, opts.known);
  const text = tail(r.output);
  if (r.name === 'run_command' || r.name === 'get_problems' || r.name === 'ssh_command') {
    log.errors = log.errors.filter((e) => e.text !== text);
    log.errors.push({ what: key ?? what, text });
    if (log.errors.length > 4) log.errors.shift();
  }
  if (!key) return false;
  const n = (log.checkFailures[key] ?? 0) + 1;
  log.checkFailures[key] = n;
  if (n !== CHECK_FAIL_LIMIT) return false;
  addTrigger(log, 'check-failed', checkReason(key, n));
  return true;
}

/** Max effort's review found problems (anything but "Looks good"). The run ends after the review, so they're unfixed. */
export function reviewFoundProblems(notes: string): boolean {
  const t = notes.trim();
  if (!t || /^(Stopped\.|The helper (stopped|finished without|needs a task))/i.test(t)) return false;
  return !/^[\W_]*(looks good|lgtm|no (issues|problems|bugs)|nothing (to fix|found|wrong))\b/i.test(t);
}

/** The card's reasons, once per run: only after real tool use and at least one trigger. Marks the run as offered. */
export function offerFor(log: RunLog): string[] | undefined {
  if (log.offered || log.tools === 0 || !log.triggers.length) return undefined;
  log.offered = true;
  return log.triggers.map((t) => t.reason);
}

export const CARD_TITLE = 'This might need a stronger model';

// MARK: errors → code locations

export interface Location { file: string; line: number }

/** file:line places mentioned in error output ("src/a.ts:12:5", "(/x/b.js:3:1)", Python's `File "c.py", line 9`). */
export function errorLocations(text: string): Location[] {
  const out: Location[] = [];
  const add = (file: string, line: number) => {
    if (!file || !(line > 0) || /^(https?|file):/.test(file)) return;
    if (!out.some((l) => l.file === file && l.line === line)) out.push({ file, line });
  };
  const re = /(?:^|[\s('"`[])((?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9})[:(](\d+)(?:[:,]\d+)?/gm;
  for (const m of text.matchAll(re)) add(m[1], Number(m[2]));
  for (const m of text.matchAll(/File "([^"]+)", line (\d+)/g)) add(m[1], Number(m[2]));
  return out.slice(0, 20);
}

// MARK: relevant code

export interface Excerpt { file: string; start: number; end: number; text: string; lang: string }

const SENSITIVE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|\.git-credentials)$/i;
const LANGS: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', swift: 'swift', py: 'python', rs: 'rust', go: 'go',
  rb: 'ruby', java: 'java', kt: 'kotlin', c: 'c', h: 'c', m: 'objc', mm: 'objc', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sh: 'sh', zsh: 'sh', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'markdown',
  html: 'html', css: 'css', scss: 'scss', sql: 'sql', vue: 'vue', svelte: 'svelte', dart: 'dart',
};

/** A file the brief may quote: a small text file, not a key or .env, not in node_modules, inside the project. */
function quotable(abs: string, root?: string): string | undefined {
  if (SENSITIVE.test(abs) || /\/(node_modules|\.git|\.build|build|dist|DerivedData)\//.test(abs)) return undefined;
  if (root && !(abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) return undefined;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 1_000_000) return undefined;
    const text = fs.readFileSync(abs, 'utf8');
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Display path: relative to the project when inside it. */
export function shown(abs: string, root?: string): string {
  if (root && abs.startsWith(root + path.sep)) return abs.slice(root.length + 1);
  return abs;
}

/** Only the relevant code: around each error location first, then the files the run changed, then those it read,
 *  each trimmed, within `budget` characters. Returns the excerpts and the files left out. */
export function codeExcerpts(log: RunLog, budget = 12_000): { excerpts: Excerpt[]; omitted: string[] } {
  const root = log.root;
  const locs = new Map<string, number[]>();
  for (const e of log.errors) {
    for (const l of errorLocations(e.text)) {
      const abs = absPath(l.file, root);
      locs.set(abs, [...(locs.get(abs) ?? []), l.line]);
    }
  }
  const order: string[] = [];
  for (const f of [...locs.keys(), ...log.changed, ...log.read]) if (!order.includes(f)) order.push(f);
  const excerpts: Excerpt[] = [];
  const omitted: string[] = [];
  let left = budget;
  for (const abs of order) {
    const text = quotable(abs, root);
    if (text === undefined) continue;
    const lines = text.split('\n');
    const lang = LANGS[path.extname(abs).slice(1).toLowerCase()] ?? '';
    const windows: [number, number][] = [];
    const at = locs.get(abs);
    if (at?.length) {
      for (const n of at.sort((a, b) => a - b)) {
        const s = Math.max(1, n - 10), e = Math.min(lines.length, n + 10);
        const last = windows[windows.length - 1];
        if (last && s <= last[1] + 2) last[1] = Math.max(last[1], e); else windows.push([s, e]);
      }
    } else {
      // A changed file shows more of itself than one only read.
      windows.push([1, Math.min(lines.length, log.changed.includes(abs) ? 80 : 40)]);
    }
    let added = false;
    for (const [s, e] of windows.slice(0, 4)) {
      let body = lines.slice(s - 1, e).join('\n');
      if (body.length > 4000) body = body.slice(0, 4000) + '\n…(trimmed)';
      if (body.length + 80 > left) break;
      left -= body.length + 80;
      excerpts.push({ file: shown(abs, root), start: s, end: e, text: body, lang });
      added = true;
    }
    if (!added) omitted.push(shown(abs, root));
  }
  return { excerpts, omitted };
}

// MARK: the project in a line

/** "Ingle · Node.js/TypeScript (git branch main)" from the files at the project root. */
export function projectLine(root?: string, branch?: string): string {
  if (!root) return 'No project folder (a chat outside a project).';
  const has = (f: string) => { try { return fs.existsSync(path.join(root, f)); } catch { return false; } };
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { /* none */ }
  const stack: string[] = [];
  if (has('package.json')) stack.push(has('tsconfig.json') ? 'Node.js/TypeScript' : 'Node.js/JavaScript');
  if (has('Package.swift')) stack.push('Swift (SwiftPM)');
  if (names.some((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'))) stack.push('Xcode project');
  if (has('Cargo.toml')) stack.push('Rust');
  if (has('go.mod')) stack.push('Go');
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) stack.push('Python');
  if (has('Gemfile')) stack.push('Ruby');
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) stack.push('JVM (Gradle/Maven)');
  const b = branch ? ` (git branch ${branch})` : '';
  return `${path.basename(root)} · ${stack.length ? stack.join(', ') : 'stack not detected'}${b}`;
}

// MARK: the brief

export interface BriefInput {
  goal: string;
  project: string;
  model: string;
  reasons: string[];
  attempts: Attempt[];
  errors: { what: string; text: string }[];
  excerpts: Excerpt[];
  omitted: string[];
  lastReply?: string;
  date?: Date;
}

const OUTCOME: Record<Attempt['outcome'], string> = { ok: 'ok', failed: 'failed', denied: 'denied by the user', skipped: 'skipped (a repeat)' };

function fence(text: string, lang = ''): string {
  const ticks = /```/.test(text) ? '````' : '```';
  return `${ticks}${lang}\n${text.replace(/\n+$/, '')}\n${ticks}`;
}

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A short, self-contained Markdown brief for a cloud AI. Nothing is sent: the user reads it and copies it. */
export function buildBrief(b: BriefInput): string {
  const goal = b.goal.trim() || '(no request text)';
  const title = short(goal.split('\n')[0], 80);
  const out: string[] = [`# Help wanted: ${title}`, '',
    `_A brief prepared by Ingle on ${isoDate(b.date ?? new Date())}. A local model (${b.model}) worked on this and couldn’t finish it. Please find the cause and suggest a fix._`,
    '', '## Goal', '', goal.length > 2000 ? goal.slice(0, 2000) + '…' : goal, '', '## Project', '', b.project];
  if (b.reasons.length) out.push('', '## Why it stopped', '', ...b.reasons.map((r) => `- ${r}`));
  if (b.attempts.length) {
    out.push('', '## What was tried', '');
    const list = b.attempts.map((a) => `${a.tool} \`${a.what.replace(/`/g, "'")}\` → ${OUTCOME[a.outcome]}`);
    const keep = list.length > 30 ? [...list.slice(0, 5), `… ${list.length - 25} more steps …`, ...list.slice(-20)] : list;
    keep.forEach((l, i) => out.push(l.startsWith('…') ? l : `${i + 1}. ${l}`));
  }
  if (b.errors.length) {
    out.push('', '## Errors');
    for (const e of b.errors) out.push('', `From \`${e.what.replace(/`/g, "'")}\`:`, '', fence(e.text, 'text'));
  }
  if (b.excerpts.length) {
    out.push('', '## Relevant code');
    for (const x of b.excerpts) out.push('', `### ${x.file} (lines ${x.start}–${x.end})`, '', fence(x.text, x.lang));
    if (b.omitted.length) out.push('', `_Left out to keep this short: ${b.omitted.join(', ')}._`);
  }
  const last = (b.lastReply ?? '').trim();
  if (last) out.push('', '## The local model’s last words', '', ...short(last, 800).split('\n').map((l) => `> ${l}`));
  return out.join('\n') + '\n';
}

/** A short "what was tried", added as context when the chat continues on Flint. */
export function flintSummary(model: string, reasons: string[], attempts: Attempt[], errors: { what: string; text: string }[]): string {
  const steps = attempts.slice(-12).map((a) => `- ${a.tool} \`${a.what}\` → ${OUTCOME[a.outcome]}`).join('\n');
  const err = errors.length ? `\nThe last error (${errors[errors.length - 1].what}):\n${tail(errors[errors.length - 1].text, 15, 1200)}` : '';
  return `Ingle: ${model} tried this and couldn’t finish. ${reasons.join(' ')}\nWhat was tried:\n${steps}${err}\n` +
    'Take a fresh look: re-read the relevant code, find the real cause, then fix it and check it. Don’t repeat what already failed.';
}

// MARK: scrubbing

/** Every saved secret's value (and its encodings) → {{secret:name}}, then anything else that looks like a key,
 *  token, password or card number → [redacted …]. */
export function scrubSecrets(text: string, secrets: { name: string; value: string }[]): string {
  let out = scrub(text, secrets);
  const found = detectSecrets(out).sort((a, b) => b.value.length - a.value.length);
  for (const f of found) out = out.split(f.value).join(`[redacted ${f.kind}]`);
  return out;
}

/** Home folder → ~, and the username on its own → <user>. Optional (on by default) when the brief is shown. */
export function redactPaths(text: string, home = os.homedir(), user = os.userInfo().username): string {
  let out = text;
  if (home && home.length > 1) out = out.split(home).join('~');
  if (user && user.length >= 3) {
    const esc = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'g'), '<user>');
  }
  return out;
}

// MARK: saving

export function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return s || 'brief';
}

/** Where briefs go: <project>/.ingle/briefs, or ~/.ingle/briefs outside a project. */
export function briefsDir(root?: string, home = os.homedir()): string {
  return root ? path.join(root, '.ingle', 'briefs') : path.join(home, '.ingle', 'briefs');
}

/** Saves the brief as YYYY-MM-DD-<slug>.md (‑2, ‑3… if taken), or overwrites `existing`. Returns the path. */
export function saveBrief(dir: string, goal: string, text: string, existing?: string, date = new Date()): string {
  fs.mkdirSync(dir, { recursive: true });
  let file = existing && path.dirname(existing) === dir ? existing : '';
  if (!file) {
    const base = `${isoDate(date)}-${slug(goal.split('\n')[0])}`;
    file = path.join(dir, base + '.md');
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}.md`);
  }
  fs.writeFileSync(file, text);
  return file;
}
