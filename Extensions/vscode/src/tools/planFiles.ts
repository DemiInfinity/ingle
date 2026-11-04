// Plans as Markdown files: <project>/.ingle/plans/YYYY-MM-DD-<slug>.md (or ~/.ingle/plans/ without a project).
// Frontmatter (title, status: draft | approved | done, chat, created), then the goal, the steps as a checklist and notes.
// Approve reads the file (so your edits are what runs); steps are ticked in the file as the task list moves on.
// Pure Node (no vscode), tested in test/workflow.test.ts. Keep in step with Sources/Ingle/PlanFiles.swift.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TaskItem } from './tasks';

export type PlanStatus = 'draft' | 'approved' | 'done';
export interface PlanStep { content: string; done: boolean }
export interface PlanDoc { title: string; status: PlanStatus; chat: string; created: string; goal: string; steps: PlanStep[]; notes: string }

/** Where plans go: the project's .ingle/plans, or ~/.ingle/plans for a chat without a project. */
export function plansDir(projectRoot: string | undefined, home = os.homedir()): string {
  return projectRoot ? path.join(projectRoot, '.ingle', 'plans') : path.join(home, '.ingle', 'plans');
}

/** "Add a subtract function!" → "add-a-subtract-function" (at most 6 words, 48 characters). */
export function slug(title: string): string {
  const words = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 6);
  return (words.join('-').slice(0, 48).replace(/-+$/, '')) || 'plan';
}

/** A short title from the request: its first line, without trailing punctuation, ≤ 60 characters. */
export function planTitle(request: string): string {
  const first = (request.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Plan').replace(/[.!?:;,\s]+$/, '');
  return first.length > 60 ? first.slice(0, 59).trimEnd() + '…' : first;
}

/** The plan reply split into its steps (the last numbered list, as tasksFromPlan) and everything else (notes). */
export function planFromReply(reply: string, steps: string[], request: string, chat: string, now = new Date()): PlanDoc {
  const clean = reply.replace(/<think>[\s\S]*?<\/think>/g, '');
  const stepSet = new Set(steps);
  const notes = clean.split('\n').filter((line) => {
    const m = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(.+)$/.exec(line);
    if (!m) return true;
    const content = m[1].replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
    return !stepSet.has(content);
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    title: planTitle(request), status: 'draft', chat, created: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    goal: request.trim().slice(0, 1500), steps: steps.map((content) => ({ content, done: false })), notes,
  };
}

/** The file's text. */
export function renderPlan(p: PlanDoc): string {
  const q = (s: string) => (/^[\w .,()'/-]*$/.test(s) && !/^\s|\s$/.test(s) ? s : JSON.stringify(s));
  return [
    '---',
    `title: ${q(p.title)}`,
    `status: ${p.status}`,
    `chat: ${p.chat}`,
    `created: ${p.created}`,
    '---',
    '',
    `# ${p.title}`,
    '',
    '## Goal',
    '',
    p.goal || '(none given)',
    '',
    '## Steps',
    '',
    ...p.steps.map((s) => `- [${s.done ? 'x' : ' '}] ${s.content}`),
    '',
    '## Notes',
    '',
    p.notes || '(none)',
    '',
  ].join('\n');
}

/** Reads a plan file. Steps are the checklist under "## Steps" (or every checklist line if there's no such heading). */
export function parsePlan(text: string): PlanDoc {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text.replace(/\r\n/g, '\n'));
  const meta: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (v.startsWith('"')) { try { v = JSON.parse(v) as string; } catch { /* keep */ } }
      meta[m[1].toLowerCase()] = v;
    }
  }
  const body = (fm ? text.replace(/\r\n/g, '\n').slice(fm[0].length) : text.replace(/\r\n/g, '\n'));
  const section = (name: string): string | undefined => {
    const re = new RegExp(`^##\\s+${name}\\s*$`, 'im');
    const m = re.exec(body);
    if (!m) return undefined;
    const rest = body.slice(m.index + m[0].length);
    const next = /^##\s+/m.exec(rest);
    return (next ? rest.slice(0, next.index) : rest).trim();
  };
  const stepText = section('Steps') ?? body;
  const steps: PlanStep[] = [];
  for (const line of stepText.split('\n')) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (m) steps.push({ content: m[2].trim(), done: m[1] !== ' ' });
  }
  const status = (['draft', 'approved', 'done'] as PlanStatus[]).find((s) => s === meta.status) ?? 'draft';
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  return {
    title: meta.title || heading || 'Plan', status, chat: meta.chat ?? '', created: meta.created ?? '',
    goal: section('Goal') ?? '', steps, notes: section('Notes') ?? '',
  };
}

/** Saves a new plan; the name gets -2, -3… if one with that name exists. Returns the path. */
export function savePlan(dir: string, p: PlanDoc, now = new Date()): string {
  fs.mkdirSync(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  const base = `${day}-${slug(p.title)}`;
  let file = path.join(dir, base + '.md');
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}.md`);
  fs.writeFileSync(file, renderPlan(p));
  return file;
}

/** The plan's steps as a task list: done ones ticked, the first open one in progress. */
export function tasksFromPlanFile(p: PlanDoc): TaskItem[] {
  let started = false;
  return p.steps.map((s) => {
    if (s.done) return { content: s.content, status: 'done' as const };
    const status = started ? 'pending' as const : 'in_progress' as const;
    started = true;
    return { content: s.content, status };
  });
}

/** Ticks the file's checklist from the task list (by position when the counts match, else by matching text) and sets
 *  its status (done when every step is ticked). Only the "- [ ]" marks and the status line change; everything else you
 *  wrote stays. Returns the new text, or undefined when nothing changed. */
export function tickPlanText(text: string, tasks: TaskItem[], status?: PlanStatus): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // The checklist lines of the Steps section (or of the whole file without one).
  let start = lines.findIndex((l) => /^##\s+Steps\s*$/i.test(l));
  let end = lines.length;
  if (start >= 0) {
    const n = lines.slice(start + 1).findIndex((l) => /^##\s+/.test(l));
    if (n >= 0) end = start + 1 + n;
  } else {
    start = -1;
  }
  const idx: number[] = [];
  for (let i = start + 1; i < end; i++) if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[i])) idx.push(i);
  const norm = (s: string) => s.toLowerCase().replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
  const byPosition = idx.length === tasks.length;
  for (let k = 0; k < idx.length; k++) {
    const line = lines[idx[k]];
    const content = line.replace(/^\s*[-*]\s+\[[ xX]\]\s+/, '');
    const task = byPosition ? tasks[k] : tasks.find((t) => norm(t.content) === norm(content));
    if (!task) continue;
    const mark = task.status === 'done' ? 'x' : ' ';
    lines[idx[k]] = line.replace(/\[[ xX]\]/, `[${mark}]`);
  }
  const allTicked = idx.length > 0 && idx.every((i) => /\[[xX]\]/.test(lines[i]));
  const want: PlanStatus | undefined = allTicked ? 'done' : status;
  if (want && lines[0] === '---') {
    for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
      if (/^status:/.test(lines[i])) { lines[i] = `status: ${want}`; break; }
    }
  }
  const out = lines.join('\n');
  return out === text.replace(/\r\n/g, '\n') ? undefined : out;
}

/** Reads, ticks and writes a plan file (see tickPlanText). Errors are ignored: the plan is a convenience. */
export function tickPlanFile(file: string, tasks: TaskItem[], status?: PlanStatus): void {
  try {
    const next = tickPlanText(fs.readFileSync(file, 'utf8'), tasks, status);
    if (next !== undefined) fs.writeFileSync(file, next);
  } catch { /* moved or deleted */ }
}

export function readPlanFile(file: string): PlanDoc | undefined {
  try { return parsePlan(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}
