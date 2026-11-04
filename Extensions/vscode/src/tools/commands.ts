// Commands — the "obedience layer" (private/COMMANDS-SPEC.md). Rules and skills are advice; commands are
// checked by the engine: required tools are offered and must be used, banned tools are hidden and blocked,
// and a then_run command must run after any file change. This file holds the store, the matching and
// the wording; the engine (chatEngine.ts) does the enforcing. Doesn't use the vscode API itself.
import * as fs from 'fs';
import * as path from 'path';
import { paths } from '../shared/settings';
import { cmp, frontmatter, listDir, readText, slug, stripFrontmatter, writeAtomic } from './frontmatter';
import { DENIED, str, type ToolArgs, type ToolDef } from './types';

export const COMMANDS_DIR = path.join(paths.home, 'commands');

/** One `must_use` item. */
export type Requirement =
  | { kind: 'tool'; tool: string; raw: string }
  | { kind: 'mcp'; server: string; tool?: string; raw: string }
  | { kind: 'skill'; name: string; raw: string };

export interface CommandEntry {
  name: string;
  description: string;
  /** Trigger phrases, lowercased. Empty = always. */
  when: string[];
  always: boolean;
  mustUse: Requirement[];
  /** Tool names (or mcp:server[/tool]) that must not be used. */
  neverUse: string[];
  thenRun: string;
  enabled: boolean;
  body: string;
  file: string;
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function parseRequirement(raw: string): Requirement | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (lower.startsWith('mcp:')) {
    const rest = s.slice(4).trim();
    const slash = rest.indexOf('/');
    const server = (slash >= 0 ? rest.slice(0, slash) : rest).trim();
    const tool = slash >= 0 ? rest.slice(slash + 1).trim() : '';
    if (!server) return undefined;
    return { kind: 'mcp', server, tool: tool || undefined, raw: s };
  }
  if (lower.startsWith('skill:')) {
    const name = s.slice(6).trim();
    return name ? { kind: 'skill', name, raw: s } : undefined;
  }
  return { kind: 'tool', tool: s, raw: s };
}

function loadCommands(folder: string, prefix: string): CommandEntry[] {
  return listDir(folder).filter((f) => path.extname(f).toLowerCase() === '.md').sort(cmp).flatMap((f) => {
    const file = path.join(folder, f);
    const text = readText(file);
    if (text === null) return [];
    const meta = frontmatter(text);
    const whenRaw = (meta.when ?? '').trim();
    const when = list(whenRaw).map((w) => w.toLowerCase());
    const always = !whenRaw || when.includes('always');
    return [{
      name: prefix + (meta.name ?? path.basename(f, path.extname(f))),
      description: meta.description ?? '',
      when: always ? [] : when,
      always,
      mustUse: list(meta.must_use).map(parseRequirement).filter((r): r is Requirement => !!r),
      neverUse: list(meta.never_use),
      thenRun: (meta.then_run ?? '').trim(),
      enabled: !['false', 'no', '0', 'off'].includes((meta.enabled ?? 'true').trim().toLowerCase()),
      body: stripFrontmatter(text),
      file,
    }];
  });
}

/** ~/.ingle/commands, plus `<workspace>/.ingle/commands` with names prefixed `project/`. */
export function listCommands(workspaceRoot?: string): CommandEntry[] {
  const out = loadCommands(COMMANDS_DIR, '');
  if (workspaceRoot) {
    const names = new Set(out.map((c) => c.name));
    out.push(...loadCommands(path.join(workspaceRoot, '.ingle', 'commands'), 'project/').filter((c) => !names.has(c.name)));
  }
  return out;
}

/** Enabled commands whose `when` matches the latest user message (case-insensitive substring). */
export function activeCommands(all: CommandEntry[], lastUser: string): CommandEntry[] {
  const t = lastUser.toLowerCase();
  return all.filter((c) => c.enabled && (c.always || c.when.some((w) => t.includes(w))));
}

// MARK: wording

/** "use the figma MCP (mcp_call with server "figma")" — used in the prompt and in nudges. */
export function requirementWords(r: Requirement): string {
  switch (r.kind) {
    case 'tool': return `use ${r.tool}`;
    case 'mcp': return r.tool
      ? `use the ${r.server} MCP's ${r.tool} tool (mcp_call with server "${r.server}" and tool "${r.tool}")`
      : `use the ${r.server} MCP (mcp_call with server "${r.server}")`;
    case 'skill': return `follow the ${r.name} skill`;
  }
}

/** What to use instead of a blocked tool, from the command's must_use (or ''). */
function insteadWords(c: CommandEntry): string {
  const usable = c.mustUse.filter((r) => r.kind !== 'skill');
  if (!usable.length) return '';
  return ' Instead, ' + usable.map(requirementWords).join(', and ') + '.';
}

/** The `## COMMANDS` block placed straight after the persona. '' when none are active. */
export function commandsBlock(active: CommandEntry[]): string {
  if (!active.length) return '';
  const lines = ['## COMMANDS — you must obey these (Ingle checks)'];
  for (const c of active) {
    lines.push('', `### ${c.name}` + (c.description ? ` — ${c.description}` : ''));
    for (const r of c.mustUse) {
      lines.push(r.kind === 'skill'
        ? `- Follow the ${r.name} skill (Ingle has loaded it below).`
        : `- Before you finish you MUST ${requirementWords(r)}.`);
    }
    for (const n of c.neverUse) lines.push(`- Never use ${n}.`);
    if (c.thenRun) lines.push(`- After changing files you MUST run: ${c.thenRun} (with run_command).`);
    if (c.body.trim()) lines.push(c.body.trim());
  }
  return lines.join('\n');
}

/** `## Commands (enforced)` for the index ('' when there are none). */
export function commandsIndexText(workspaceRoot?: string): string {
  let all: CommandEntry[] = [];
  try { all = listCommands(workspaceRoot).filter((c) => c.enabled); } catch { return ''; }
  if (!all.length) return '';
  return ['## Commands (enforced — Ingle checks you follow them when they apply)',
    ...all.map((c) => `- ${c.name}` + (c.description ? ` — ${c.description}` : '') + ` (when: ${c.always ? 'always' : c.when.join(', ')})`),
  ].join('\n');
}

// MARK: checks used by the engine

/** Does a tool call by `name` with `args` match a never_use item? */
export function bannedBy(active: CommandEntry[], name: string, args: ToolArgs): { command: CommandEntry; item: string } | undefined {
  for (const c of active) {
    for (const item of c.neverUse) {
      const r = parseRequirement(item);
      if (!r) continue;
      if (r.kind === 'tool' && r.tool.toLowerCase() === name.toLowerCase()) return { command: c, item };
      if (r.kind === 'mcp' && name === 'mcp_call' && callMatchesMcp(r, args)) return { command: c, item };
    }
  }
  return undefined;
}

export function blockedMessage(c: CommandEntry, item: string): string {
  return `Blocked by the command "${c.name}": you must not use ${item}.${insteadWords(c)}`;
}

function callMatchesMcp(r: Extract<Requirement, { kind: 'mcp' }>, args: ToolArgs): boolean {
  if (str(args, 'server').trim().toLowerCase() !== r.server.toLowerCase()) return false;
  return !r.tool || str(args, 'tool').trim().toLowerCase() === r.tool.toLowerCase();
}

/** A call made during this request (blocked and unknown calls aren't recorded). */
export interface CallRecord { name: string; args: ToolArgs; denied: boolean }

export function requirementMet(r: Requirement, calls: CallRecord[]): boolean {
  switch (r.kind) {
    case 'skill': return true; // attached automatically
    case 'tool': return calls.some((c) => c.name.toLowerCase() === r.tool.toLowerCase());
    case 'mcp': return calls.some((c) => c.name === 'mcp_call' && callMatchesMcp(r, c.args));
  }
}

export const FILE_CHANGING_TOOLS = ['edit_file', 'write_file'];

/** True if a file changed (an allowed edit_file/write_file) after the last run_command containing `thenRun`. */
export function thenRunOwed(thenRun: string, calls: CallRecord[]): boolean {
  const needle = thenRun.trim().toLowerCase();
  if (!needle) return false;
  let owed = false;
  for (const c of calls) {
    if (FILE_CHANGING_TOOLS.includes(c.name) && !c.denied) owed = true;
    else if (c.name === 'run_command' && str(c.args, 'command').toLowerCase().includes(needle)) owed = false;
  }
  return owed;
}

// MARK: command_create

export function commandFile(name: string): { slug: string; file: string } {
  const s = slug(name);
  return { slug: s, file: path.join(COMMANDS_DIR, `${s}.md`) };
}

const oneLine = (s: string) => s.split('\n').join(' ').trim();

export function commandText(f: { description: string; when: string; mustUse: string; neverUse: string; thenRun: string; instructions: string }): string {
  const lines = ['---', `description: ${oneLine(f.description)}`, `when: ${oneLine(f.when) || 'always'}`];
  if (f.mustUse.trim()) lines.push(`must_use: ${oneLine(f.mustUse)}`);
  if (f.neverUse.trim()) lines.push(`never_use: ${oneLine(f.neverUse)}`);
  if (f.thenRun.trim()) lines.push(`then_run: ${oneLine(f.thenRun)}`);
  lines.push('enabled: true', '---', '', f.instructions.trim());
  return lines.join('\n').trimEnd() + '\n';
}

const p = (description: string) => ({ type: 'string', description });
const truthy = (a: ToolArgs, k: string) => a[k] === true || ['true', '1', 'yes'].includes(str(a, k).trim().toLowerCase());
/** Arrays or comma-separated strings → "a, b". */
const csv = (a: ToolArgs, k: string) => {
  const v = a[k];
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).join(', ') : str(a, k);
};

export const commandCreateTool: ToolDef = {
  name: 'command_create',
  description: "Create a command — a rule Ingle enforces, not just advises: e.g. always use a certain MCP server or tool for some kind of task, never use a tool, or always run something after editing. Use when the user says 'always', 'must', 'never' or asks for a command.",
  parameters: {
    type: 'object',
    properties: {
      name: p('Short name, e.g. figma-components'),
      description: p('One line saying what it enforces'),
      when: p('Comma-separated trigger words or phrases from the user\'s message, e.g. "component, ui kit" — or "always"'),
      must_use: p('Optional, comma-separated: tool names (search_code), mcp:server, mcp:server/tool, or skill:name'),
      never_use: p('Optional, comma-separated tool names that must not be used, e.g. write_file'),
      then_run: p('Optional: a command that must be run with run_command after any file change, e.g. npm run lint'),
      instructions: p('Optional extra instructions shown to the model with the command'),
      replace: { type: 'boolean', description: 'Overwrite an existing command with this name' },
    },
    required: ['name', 'description', 'when'],
  },
  readOnly: false,
  available: () => true,
  describe: (a) => ({ title: 'Create a command', detail: `${str(a, 'name')} — ${str(a, 'description')}`, icon: 'book' }),
  async run(a, ctx) {
    const name = str(a, 'name');
    const fields = {
      description: str(a, 'description'), when: csv(a, 'when'), mustUse: csv(a, 'must_use'), neverUse: csv(a, 'never_use'),
      thenRun: str(a, 'then_run'), instructions: str(a, 'instructions'),
    };
    if (!name.trim()) return 'A command needs a name.';
    if (!fields.mustUse.trim() && !fields.neverUse.trim() && !fields.thenRun.trim()) {
      return 'A command needs at least one of must_use, never_use or then_run — otherwise it\'s just advice (use rule_create for that).';
    }
    const { slug: s, file } = commandFile(name);
    const exists = fs.existsSync(file);
    if (exists && !truthy(a, 'replace')) return `A command called ${s} already exists. Call command_create again with replace set to true to overwrite it.`;
    const text = commandText(fields);
    const answer = await ctx.requestApproval({
      kind: 'rule', title: exists ? 'Wants to replace a command' : 'Wants to create a command', detail: file, preview: text.slice(0, 6000),
    });
    if (answer !== 'allow') return DENIED;
    try { writeAtomic(file, text); } catch (e) { return `Couldn't save the command: ${(e as Error).message}`; }
    return `Created the command ${s}. Ingle will enforce it ${fields.when.trim().toLowerCase() === 'always' || !fields.when.trim() ? 'on every request' : `when a message mentions: ${fields.when}`}.`;
  },
};

/** Text for the /commands notice. */
export function commandsNotice(workspaceRoot: string | undefined, lastUser: string): string {
  let all: CommandEntry[] = [];
  try { all = listCommands(workspaceRoot); } catch { /* none */ }
  const enabled = all.filter((c) => c.enabled);
  if (!enabled.length) return 'No commands yet — ask me to "write a command…"';
  const active = new Set(activeCommands(enabled, lastUser).map((c) => c.name));
  const off = all.length - enabled.length;
  return 'Commands: ' + enabled.map((c) => `${active.has(c.name) ? '⚑ ' : ''}${c.name} (${c.always ? 'always' : c.when.join(', ')})`).join(' · ') +
    (off ? ` · ${off} turned off` : '');
}
