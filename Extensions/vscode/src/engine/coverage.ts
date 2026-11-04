// Coverage checks (task 34): the harness notices what was missed. When a run calls `impact` or `references` and
// then changes code, the affected places are remembered. Before the model finishes, any affected file it neither
// read (near an affected line) nor edited gets one nudge, sent with the command nudges (commands.ts). Still
// unvisited after that, with no reason given, the reply gets the ⚠ chip. On at High/Max effort, in Debug mode, or
// when a command says `must_use: coverage`. Pure (no vscode), tested in test/coverage.test.ts. Same rules as
// Coverage.swift in the Mac app.
import * as path from 'path';
import { str, type ToolArgs } from '../tools/types';
import type { EffortLevel } from './effort';
import { EFFORT } from './effort';
import type { WorkMode } from './modes';

/** One affected place: a workspace-relative path (forward slashes) and a 1-based line. */
export interface Place { path: string; line: number }

/** Tools whose results name affected places. */
export const COVERAGE_SOURCES = ['impact', 'references'];
/** Tools that change files (same list as FILE_CHANGING_TOOLS). */
const EDITS = ['edit_file', 'write_file'];
/** A read this many lines either side of an affected line still counts as looking at it. */
const MARGIN = 3;
/** Places listed in the nudge (the chip lists them all). */
const LIST_IN_NUDGE = 8;

export interface CoverageState {
  root: string;
  /** Symbols looked up with impact/references, in order. */
  symbols: string[];
  /** Affected places from those lookups (no duplicates). */
  places: Place[];
  /** Code changed after the first lookup: only then is coverage checked. */
  changed: boolean;
  /** Reads: whole file when start/end are undefined. */
  reads: Array<{ path: string; start?: number; end?: number }>;
  edited: string[];
  nudged: boolean;
  /** What the model said after the nudge (a stated reason resolves it). */
  said: string;
}

export function newCoverage(root: string): CoverageState {
  return { root, symbols: [], places: [], changed: false, reads: [], edited: [], nudged: false, said: '' };
}

/** Is coverage checking on for this run? High/Max effort, Debug mode, or a command requiring it. */
export function coverageOn(effort: EffortLevel, mode: WorkMode, forced: boolean): boolean {
  return forced || mode === 'debug' || EFFORT[effort].coverage;
}

/** Workspace-relative path with forward slashes, or undefined outside the workspace. */
export function relPath(root: string, p: string): string | undefined {
  const s = p.trim().replace(/^\.\//, '');
  if (!s) return undefined;
  const full = path.isAbsolute(s) ? s : path.join(root, s);
  const r = path.relative(root, full);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return undefined;
  return r.split(path.sep).join('/');
}

/** The symbols an impact/references call was about: its `symbol` argument, or the ones the tool picked from the
 *  working set (named in brackets on the output's first line). Positions (`file:line:col`) are kept as given. */
export function symbolsOf(args: ToolArgs, output: string): string[] {
  const s = str(args, 'symbol').trim();
  if (s) return [s];
  const first = output.split('\n', 1)[0] ?? '';
  const changed = /^\(no symbol named: using what the uncommitted changes touch — (.+)\)$/.exec(first);
  if (changed) return changed[1].split(',').map((x) => x.trim()).filter(Boolean);
  const sel = /^\(no symbol named: using the selection, (.+)\)$/.exec(first);
  return sel ? [sel[1].trim()] : [];
}

/** Remembers the places a lookup found (paths relative to the root, or absolute inside it). */
export function addPlaces(state: CoverageState, symbol: string, found: Place[]): void {
  if (symbol && !state.symbols.includes(symbol)) state.symbols.push(symbol);
  for (const p of found) {
    const rel = relPath(state.root, p.path);
    if (!rel || !(p.line > 0)) continue;
    if (!state.places.some((q) => q.path === rel && q.line === p.line)) state.places.push({ path: rel, line: p.line });
  }
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

/** Records one call that ran (denied calls don't count): reads, edits, and whether code changed after a lookup. */
export function recordCall(state: CoverageState, name: string, args: ToolArgs, denied = false): void {
  if (denied) return;
  if (EDITS.includes(name)) {
    const rel = relPath(state.root, str(args, 'path'));
    if (rel && !state.edited.includes(rel)) state.edited.push(rel);
    if (state.symbols.length) state.changed = true;
    return;
  }
  if (name === 'read_file' || name === 'read_exhaustively') {
    const rel = relPath(state.root, str(args, 'path'));
    if (rel) state.reads.push({ path: rel, start: num(args.start_line), end: num(args.end_line) });
  } else if (name === 'outline') {
    const rel = relPath(state.root, str(args, 'file'));
    if (rel) state.reads.push({ path: rel });
  } else if (name === 'definition') {
    // Only a position (`file:line[:col]`) shows a particular place; a name shows the definition, not the uses.
    const m = /^(.+?):(\d+)(?::\d+)?$/.exec(str(args, 'symbol').trim());
    const rel = m ? relPath(state.root, m[1]) : undefined;
    if (m && rel) state.reads.push({ path: rel, start: Number(m[2]), end: Number(m[2]) });
  }
}

/** Affected places in files the run neither edited nor read near an affected line. */
export function unvisited(state: CoverageState): Place[] {
  const seen = (p: Place) => state.edited.includes(p.path);
  const files = new Map<string, Place[]>();
  for (const p of state.places) files.set(p.path, [...(files.get(p.path) ?? []), p]);
  const out: Place[] = [];
  for (const [file, list] of files) {
    if (seen(list[0])) continue;
    const looked = state.reads.some((r) => r.path === file && list.some((p) =>
      (r.start === undefined || p.line >= r.start - MARGIN) && (r.end === undefined || p.line <= r.end + MARGIN)));
    if (!looked) out.push(...list);
  }
  return out;
}

const tick = (s: string) => '`' + s + '`';

export function placeText(p: Place): string { return `${p.path}:${p.line}`; }

/** The nudge item (joined to the command nudges' list), or undefined when nothing's left or it was already sent.
 *  Sent once per run. */
export function coverageNudge(state: CoverageState): string | undefined {
  if (state.nudged || !state.changed) return undefined;
  const left = unvisited(state);
  if (!left.length) return undefined;
  state.nudged = true;
  const shown = left.slice(0, LIST_IN_NUDGE).map(placeText).join(', ');
  const more = left.length > LIST_IN_NUDGE ? ` and ${left.length - LIST_IN_NUDGE} more` : '';
  const what = state.symbols.map(tick).join(', ');
  const n = left.length;
  return `You changed ${what} but didn't look at ${n} ${n === 1 ? 'place that uses' : 'places that use'} it: ${shown}${more}. ` +
    `Check ${n === 1 ? 'it' : 'them'} (read_file or edit_file), or say why ${n === 1 ? 'it doesn’t' : 'they don’t'} need changing.`;
}

/** Notes what the model said (after the nudge, it may give a reason instead of looking). */
export function noteReply(state: CoverageState, text: string): void {
  if (state.nudged && text.trim()) state.said += '\n' + text;
}

/** Does this text say why places don't need changing ("they only log the value", "these don't use the return
 *  value")? Plain wording only, so "I've updated everything" is not a reason. */
export function statesReason(text: string): boolean {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  return /\b(because|since (they|it|those|these|that)|only (log|logs|read|reads|print|prints|display|displays|pass|passes|mention|mentions|use|uses|refer|refers|import|imports|test|tests|wrap|wraps|forward|forwards|call|calls)|(don't|doesn't|do not|does not|won't|will not|no) (need|needs) (to )?(be )?chang|not affected|unaffected|unrelated|no change(s)? (is |are )?needed|(still|already) (correct|works|work|valid|compatible)|(don't|doesn't|do not|does not) (use|call|depend|touch))/.test(t);
}

/** Places still unchecked at the end of the run, for the ⚠ chip ([] when covered or a reason was given). */
export function coverageLeft(state: CoverageState): Place[] {
  if (!state.nudged) return [];
  const left = unvisited(state);
  if (!left.length || statesReason(state.said)) return [];
  return left;
}

/** The chip's words. */
export function coverageChip(n: number): string {
  return `⚠ ${n} affected ${n === 1 ? 'place' : 'places'} not checked`;
}
