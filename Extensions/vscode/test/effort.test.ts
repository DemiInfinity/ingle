import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  EFFORT, EFFORT_LEVELS, chatEffort, checkCommandIn, defaultEffort, detectCheckCommand, isEffort, nextEffort,
  takesThinkLevels, thinkParam, verifyCommand,
} from '../src/engine/effort';
import { completionCheck, ignoredChip, requiredTools, type CallRecord } from '../src/tools/commands';
import { selectTools, type SelectableTool } from '../src/engine/toolSelection';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingle-effort-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
function project(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, name);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// MARK: the table (must match Effort.swift and the table in docs/improvement-plan.md, task 29)

test('the table has four levels in order', () => {
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'max']);
  assert.deepEqual(EFFORT_LEVELS.map((e) => EFFORT[e].label), ['Low', 'Medium', 'High', 'Max']);
});

test('thinking per level', () => {
  assert.deepEqual(EFFORT_LEVELS.map((e) => EFFORT[e].think), [false, 'low', 'medium', 'high']);
});

test('prompt lines per level', () => {
  assert.equal(EFFORT.low.promptLine, 'Answer directly in as few steps as possible.');
  assert.equal(EFFORT.medium.promptLine, '');
  assert.match(EFFORT.high.promptLine, /^Investigate before changing anything/);
  assert.match(EFFORT.max.promptLine, /^Plan first/);
});

test('tool filtering, verify, plan, review and guards per level', () => {
  assert.deepEqual(EFFORT_LEVELS.map((e) => EFFORT[e].tools), ['strict', 'normal', 'relaxed', 'relaxed']);
  assert.deepEqual(EFFORT_LEVELS.map((e) => EFFORT[e].verify), [false, false, true, true]);
  assert.deepEqual(EFFORT_LEVELS.map((e) => EFFORT[e].plan), [false, false, false, true]);
  assert.deepEqual(EFFORT_LEVELS.map((e) => EFFORT[e].review), [false, false, false, true]);
  assert.deepEqual(EFFORT_LEVELS.map((e) => [EFFORT[e].repeatLimit, EFFORT[e].stuckLimit]), [[3, 4], [3, 4], [4, 6], [4, 6]]);
});

test('cycling and validation', () => {
  assert.equal(nextEffort('low'), 'medium');
  assert.equal(nextEffort('max'), 'low');
  assert.ok(isEffort('high'));
  assert.ok(!isEffort('High'));
  assert.ok(!isEffort(undefined));
});

// MARK: defaults and old chats

test('per-assistant defaults: Ember Medium, Flint High, or what Settings says', () => {
  assert.equal(defaultEffort('daily'), 'medium');
  assert.equal(defaultEffort('hard'), 'high');
  assert.equal(defaultEffort('daily', 'max'), 'max');
  assert.equal(defaultEffort('hard', 'nonsense'), 'high');
});

test('old chats: Think on → High, Think off → Medium; a saved level wins', () => {
  assert.equal(chatEffort({ think: true }, 'low'), 'high');
  assert.equal(chatEffort({ think: false }, 'max'), 'medium');
  assert.equal(chatEffort({ think: true, effort: 'low' }, 'medium'), 'low');
  assert.equal(chatEffort({}, 'max'), 'max');
  assert.equal(chatEffort({ effort: 'bogus' }, 'high'), 'high');
});

// MARK: think mapping

test('think: off at Low, a level only for models that take one, true otherwise', () => {
  assert.ok(takesThinkLevels('gpt-oss:20b'));
  assert.ok(!takesThinkLevels('qwen3.8:27b-mlx'));
  assert.equal(thinkParam('low', 'gpt-oss:20b'), false);
  assert.equal(thinkParam('low', 'qwen3.8:27b'), false);
  assert.equal(thinkParam('medium', 'gpt-oss:20b'), 'low');
  assert.equal(thinkParam('high', 'gpt-oss:20b'), 'medium');
  assert.equal(thinkParam('max', 'gpt-oss:120b'), 'high');
  assert.equal(thinkParam('medium', 'qwen3.8:27b'), true);
  assert.equal(thinkParam('max', 'qwen3.8:27b'), true);
});

// MARK: check-command detection

test('package.json: test script, then lint; npm’s placeholder test does not count', () => {
  const a = project('npm-test', { 'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }) });
  assert.equal(checkCommandIn(a)?.command, 'npm test');
  const b = project('npm-lint', { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' } }) });
  assert.equal(checkCommandIn(b)?.command, 'npm run lint');
  const c = project('npm-none', { 'package.json': '{}' });
  assert.equal(checkCommandIn(c), undefined);
  const d = project('pnpm', { 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }), 'pnpm-lock.yaml': '' });
  assert.equal(checkCommandIn(d)?.command, 'pnpm test');
});

test('other project types', () => {
  assert.equal(checkCommandIn(project('swift', { 'Package.swift': '' }))?.command, 'swift build');
  assert.equal(checkCommandIn(project('rust', { 'Cargo.toml': '' }))?.command, 'cargo check');
  assert.equal(checkCommandIn(project('go', { 'go.mod': '' }))?.command, 'go test ./...');
  assert.equal(checkCommandIn(project('make', { Makefile: 'build:\n\tcc x.c\ntest: build\n\t./run\n' }))?.command, 'make test');
  assert.equal(checkCommandIn(project('make-no-test', { Makefile: 'build:\n\tcc x.c\n' })), undefined);
  assert.equal(checkCommandIn(project('py', { 'pyproject.toml': '[tool.pytest.ini_options]\n' }))?.command, 'pytest');
  assert.equal(checkCommandIn(project('py-ini', { 'pytest.ini': '' }))?.command, 'pytest');
  assert.equal(checkCommandIn(project('plain', { 'README.md': '' })), undefined);
});

test('detection walks up from a changed file to the nearest project, and stops at the workspace', () => {
  const root = project('walk', { 'Package.swift': '', 'Sources/App/main.swift': '' });
  const found = detectCheckCommand(path.join(root, 'Sources/App/main.swift'), undefined, tmp);
  assert.equal(found?.command, 'swift build');
  assert.equal(found?.dir, root);
  // Nested package wins over the outer one.
  const inner = project('walk/web', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'src/a.ts': '' });
  assert.equal(detectCheckCommand(path.join(inner, 'src/a.ts'), undefined, tmp)?.command, 'npm test');
  // Stops at the workspace root, and never goes to the home folder.
  const ws = project('walk/ws', { 'lib/x.py': '' });
  assert.equal(detectCheckCommand(path.join(ws, 'lib/x.py'), ws, tmp), undefined);
  assert.equal(detectCheckCommand(path.join(tmp, 'loose.txt'), undefined, tmp), undefined);
});

// MARK: verify reuses the command checks

test('verify is enforced like then_run: a nudge after an edit, none after the check ran', () => {
  const v = verifyCommand({ command: 'swift build', dir: '/p', why: 'Package.swift' });
  assert.ok(requiredTools([v]).has('run_command'));
  const edited: CallRecord[] = [{ name: 'edit_file', args: { path: '/p/a.swift' }, denied: false }];
  const nudges = new Map<string, number>();
  const ignored = new Map<string, string>();
  const ask = completionCheck([v], edited, nudges, ignored);
  assert.match(ask ?? '', /run `swift build` with run_command/);
  const ran: CallRecord[] = [...edited, { name: 'run_command', args: { command: 'swift build 2>&1 | tail', cwd: '/p' }, denied: false }];
  assert.equal(completionCheck([v], ran, new Map(), new Map()), undefined);
  // Ignored twice → ⚠ chip, no more nudges.
  completionCheck([v], edited, nudges, ignored);
  assert.equal(completionCheck([v], edited, nudges, ignored), undefined);
  assert.equal(ignoredChip(v.name, ignored.get(v.name) ?? ''), '⚠ didn’t follow verify');
});

test('nothing changed, nothing owed', () => {
  const v = verifyCommand({ command: 'npm test', dir: '/p', why: 'x' });
  assert.equal(completionCheck([v], [{ name: 'read_file', args: {}, denied: false }], new Map(), new Map()), undefined);
});

// MARK: tool filtering strictness

const tool = (name: string, readOnly = false): SelectableTool => ({ name, readOnly });
const ALL = [tool('read_file', true), tool('edit_file'), tool('run_command'), tool('repo_map', true), tool('report_read', true)];
const pick = (lastUser: string, strictness?: 'strict' | 'normal' | 'relaxed') => selectTools({
  available: ALL, lastUser, isSubAgent: false, active: [], mcpToolNames: [], mcpWanted: false, delegate: tool('delegate'), strictness,
}).map((t) => t.name);

test('strict (Low) drops the helper and extras; relaxed (High/Max) always offers the helper', () => {
  assert.deepEqual(pick('fix the bug'), ['read_file', 'edit_file', 'run_command', 'repo_map', 'report_read']);
  assert.deepEqual(pick('fix the bug', 'strict'), ['read_file', 'edit_file', 'run_command']);
  assert.ok(!pick('research this', 'strict').includes('delegate'));
  assert.ok(pick('research this', 'strict').includes('report_read'));
  assert.ok(pick('fix the bug', 'relaxed').includes('delegate'));
  assert.ok(!pick('fix the bug', 'normal').includes('delegate'));
});
