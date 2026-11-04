// The task list (update_tasks) and plan mode: pure logic, tested in test/workflow.test.ts.
// Keep in step with Sources/Ingle/TaskList.swift (same rules, same wording).
import type { ToolArgs, ToolDef } from './types';

export type TaskStatus = 'pending' | 'in_progress' | 'done';
export interface TaskItem { content: string; status: TaskStatus }

/** Most items a list keeps (small models make long lists that never finish). */
export const MAX_TASKS = 12;

const STATUS: Record<string, TaskStatus> = {
  pending: 'pending', todo: 'pending', 'to do': 'pending', open: 'pending', 'not started': 'pending',
  in_progress: 'in_progress', 'in-progress': 'in_progress', 'in progress': 'in_progress', inprogress: 'in_progress',
  doing: 'in_progress', active: 'in_progress', current: 'in_progress', started: 'in_progress',
  done: 'done', completed: 'done', complete: 'done', finished: 'done', 'done ✓': 'done',
};

/** Reads update_tasks' `items` (an array, or JSON text of one, as small models sometimes send). Returns the list,
 *  or an error sentence for the model. Unknown statuses count as pending; only one item may be in progress. */
export function parseTasks(args: ToolArgs): TaskItem[] | string {
  let raw: unknown = args.items ?? args.tasks ?? args.todos;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return 'items must be a list like [{"content": "Read the parser", "status": "in_progress"}].'; }
  }
  if (!Array.isArray(raw)) return 'items must be a list like [{"content": "Read the parser", "status": "in_progress"}].';
  const out: TaskItem[] = [];
  for (const it of raw) {
    let content = '';
    let status: TaskStatus = 'pending';
    if (typeof it === 'string') {
      content = it;
    } else if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>;
      content = String(o.content ?? o.task ?? o.title ?? o.text ?? '');
      status = STATUS[String(o.status ?? '').trim().toLowerCase()] ?? 'pending';
    }
    content = content.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (content) out.push({ content, status });
  }
  if (!out.length) return 'The list is empty. Give at least one item, or leave the list as it is.';
  const list = out.slice(0, MAX_TASKS);
  // One thing at a time: keep the first in-progress item, later ones go back to pending.
  let seen = false;
  for (const t of list) {
    if (t.status !== 'in_progress') continue;
    if (seen) t.status = 'pending';
    seen = true;
  }
  return list;
}

/** What update_tasks tells the model after an update. */
export function tasksResult(list: TaskItem[]): string {
  const done = list.filter((t) => t.status === 'done').length;
  const now = list.find((t) => t.status === 'in_progress');
  const next = list.find((t) => t.status === 'pending');
  if (done === list.length) return `Task list updated: all ${list.length} done. Finish with a short summary for the user.`;
  const focus = now ? `Now: ${now.content}.` : next ? `Next: ${next.content} (mark it in_progress when you start).` : '';
  return `Task list updated: ${done}/${list.length} done. ${focus} Update the list as each item is done.`.trim();
}

/** True when every item is done (or there is no list). */
export function allDone(list: TaskItem[] | undefined): boolean {
  return !list?.length || list.every((t) => t.status === 'done');
}

/** The list as the model sees it in the system prompt, while it isn't finished. '' otherwise. */
export function tasksPrompt(list: TaskItem[] | undefined): string {
  if (allDone(list)) return '';
  const mark: Record<TaskStatus, string> = { pending: '[ ]', in_progress: '[>]', done: '[x]' };
  return '## Your task list (keep it current with update_tasks)\n' + list!.map((t) => `${mark[t.status]} ${t.content}`).join('\n');
}

/** A plan reply → a task list (the first item in progress). The plan is the last numbered list in the reply (or the
 *  last bulleted list if there's no numbered one); indented lines under an item are left out. Returns [] when there
 *  are fewer than 2 steps. */
export function tasksFromPlan(text: string): TaskItem[] {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  type Block = { items: string[]; numbered: number };
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const line of clean.split('\n')) {
    const m = /^(?:\d{1,2}[.)]|[-*•]|\[[ x>]?\])\s+(.+)$/.exec(line.trimEnd());
    if (m && !/^\s{2,}/.test(line)) {
      if (!cur) { cur = { items: [], numbered: 0 }; blocks.push(cur); }
      if (/^\d/.test(line)) cur.numbered++;
      const content = m[1].replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
      if (content.length >= 3) cur.items.push(content.slice(0, 200));
    } else if (line.trim() && !/^\s{2,}/.test(line)) {
      cur = null; // text between lists (e.g. "Plan:" or "Shall I go ahead?")
    }
  }
  const pick = [...blocks].reverse().find((b) => b.numbered >= 2 && b.items.length >= 2)
    ?? [...blocks].reverse().find((b) => b.items.length >= 2);
  if (!pick) return [];
  return pick.items.slice(0, MAX_TASKS).map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }));
}

/** The update_tasks tool. The engine passes what to do with a new list (store it, show it). */
export function tasksTool(onUpdate: (list: TaskItem[]) => void): ToolDef {
  return {
    name: 'update_tasks',
    description: 'Keep a short to-do list for a job of 3 or more steps (not for quick questions). Send the whole list each time: mark one item in_progress as you start it and done as soon as it is finished.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'The whole list, in order.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'One short step, e.g. "Add a test for empty input".' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['items'],
    },
    readOnly: false,
    available: (ctx) => !ctx.isSubAgent,
    describe: (a) => {
      const list = parseTasks(a);
      if (typeof list === 'string') return { title: 'Update the task list', detail: '', icon: 'checklist' };
      const done = list.filter((t) => t.status === 'done').length;
      return { title: 'Update the task list', detail: `${done}/${list.length} done`, icon: 'checklist' };
    },
    run: async (a) => {
      const list = parseTasks(a);
      if (typeof list === 'string') return list;
      onUpdate(list);
      return tasksResult(list);
    },
  };
}

// MARK: plan mode

/** Tools plan mode offers besides read-only ones: the task list and the read-only helper. */
export const PLAN_MODE_EXTRA = ['update_tasks', 'delegate'];

/** Whether plan mode lets this tool run. */
export function allowedInPlanMode(tool: { name: string; readOnly: boolean } | undefined): boolean {
  return !!tool && (tool.readOnly || PLAN_MODE_EXTRA.includes(tool.name));
}

/** Only what plan mode allows (read and search, the task list, the helper). */
export function planModeFilter<T extends { name: string; readOnly: boolean }>(tools: T[]): T[] {
  return tools.filter(allowedInPlanMode);
}

/** The tool result when the model tries to change something in plan mode. */
export const PLAN_MODE_REFUSAL = 'Plan mode is on: you can only read and search. Don’t change files or run commands. Finish your investigation and end with a numbered plan; the user will approve it or ask for changes.';

/** Added to the system prompt while plan mode is on. */
export const PLAN_MODE_PROMPT = '## Plan mode\nThe user switched on plan mode: you can only read and search. Investigate what you need, then end your reply with a plan as a numbered list (one short step per line). Don’t change files or run commands. The user will approve the plan (then you do the work) or reply with changes.';

/** The user message added when a plan is approved. */
export const PLAN_APPROVED = 'Approved. Go ahead with the plan (it is your task list now): work through it and keep the list current.';
