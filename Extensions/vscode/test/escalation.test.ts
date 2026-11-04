import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CHECK_FAIL_LIMIT, STUCK_REASON, REVIEW_REASON, addTrigger, briefsDir, buildBrief, callFailed, checkKey, codeExcerpts,
  commandReason, coverageReason, errorLocations, flintSummary, newRunLog, normaliseCommand, offerFor, projectLine,
  recordCall, redactPaths, reviewFoundProblems, saveBrief, scrubSecrets, slug,
} from '../src/engine/escalation';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ingle-escalation-')));
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

const FAIL = 'exit code 1\n\n> t@1.0.0 test\n> node --test\n\nAssertionError: 1 !== 2\n    at test (/x/test/sum.test.js:4:10)';
const PASS = 'exit code 0\nok 1 - sums';

// MARK: what counts as a check, and as a failure

test('checks are recognised whatever the decoration', () => {
  assert.equal(normaliseCommand('cd app && npm test 2>&1 | tail -n 40'), 'npm test');
  assert.equal(normaliseCommand('cd /x/app && cd /x/app && npm test'), 'npm test');
  assert.equal(checkKey('run_command', { command: 'cd /x && npm test' }), checkKey('run_command', { command: 'npm test 2>&1 | tail -n 30' }));
  assert.equal(checkKey('run_command', { command: 'npm test' }), 'npm test');
  assert.equal(checkKey('run_command', { command: 'swift build' }), 'swift build');
  assert.equal(checkKey('run_command', { command: 'python3 -m pytest -q' }), 'python3 -m pytest -q');
  assert.equal(checkKey('run_command', { command: 'ls -la' }), undefined);
  assert.equal(checkKey('run_command', { command: 'git status' }), undefined);
  // The project's own check command counts even when it doesn't look like one.
  assert.equal(checkKey('run_command', { command: './ci.sh' }, ['./ci.sh']), './ci.sh');
  assert.equal(checkKey('get_problems', {}), 'get_problems');
  assert.equal(checkKey('get_problems', { command: 'swift build' }), 'get_problems (swift build)');
  assert.equal(checkKey('read_file', { path: 'a' }), undefined);
});

test('failures are read from the tool output', () => {
  assert.equal(callFailed('run_command', FAIL), true);
  assert.equal(callFailed('run_command', PASS), false);
  assert.equal(callFailed('run_command', 'stopped after 2 minutes\n…'), true);
  assert.equal(callFailed('get_problems', '2 errors, 0 warnings\na.ts:1:1: error: x'), true);
  assert.equal(callFailed('get_problems', '0 errors, 3 warnings\n…'), false);
  assert.equal(callFailed('get_problems', 'No errors or warnings in the project.'), false);
  assert.equal(callFailed('get_problems', '`make` failed (exit code 2) without file:line errors.'), true);
  assert.equal(callFailed('read_file', 'export const a = 1'), false);
});

// MARK: triggers

test('the same check failing 3 times triggers, once', () => {
  const log = newRunLog();
  assert.equal(recordCall(log, { name: 'run_command', args: { command: 'npm test' }, output: FAIL }), false);
  assert.equal(recordCall(log, { name: 'run_command', args: { command: 'cd . && npm test 2>&1' }, output: FAIL }), false);
  assert.equal(offerFor(log), undefined);
  assert.equal(recordCall(log, { name: 'run_command', args: { command: 'npm test' }, output: FAIL }), true);
  assert.equal(CHECK_FAIL_LIMIT, 3);
  assert.deepEqual(log.triggers.map((t) => t.kind), ['check-failed']);
  assert.match(log.triggers[0].reason, /`npm test` failed 3 times/);
  // A fourth failure doesn't add it again.
  recordCall(log, { name: 'run_command', args: { command: 'npm test' }, output: FAIL });
  assert.equal(log.triggers.length, 1);
});

test('passing runs, different checks and other commands don\'t add up', () => {
  const log = newRunLog();
  recordCall(log, { name: 'run_command', args: { command: 'npm test' }, output: FAIL });
  recordCall(log, { name: 'run_command', args: { command: 'npm test' }, output: PASS });
  recordCall(log, { name: 'run_command', args: { command: 'npm run lint' }, output: FAIL });
  recordCall(log, { name: 'run_command', args: { command: 'ls missing' }, output: 'exit code 1\nls: missing: No such file' });
  recordCall(log, { name: 'run_command', args: { command: 'ls missing' }, output: 'exit code 1\nls: missing: No such file' });
  recordCall(log, { name: 'run_command', args: { command: 'ls missing' }, output: 'exit code 1\nls: missing: No such file' });
  assert.equal(log.triggers.length, 0);
  // Denied and skipped calls aren't failures.
  for (let i = 0; i < 3; i++) recordCall(log, { name: 'run_command', args: { command: 'npm run lint' }, output: '', denied: true });
  assert.equal(log.triggers.length, 0);
});

test('get_problems reporting errors 3 times triggers', () => {
  const log = newRunLog();
  for (let i = 0; i < 3; i++) recordCall(log, { name: 'get_problems', args: {}, output: '1 error, 0 warnings\nsrc/a.ts:3:1: error: nope' });
  assert.deepEqual(log.triggers.map((t) => t.kind), ['check-failed']);
});

test('the stuck stop, an ignored command, review problems and coverage each trigger', () => {
  for (const [kind, reason] of [
    ['stuck', STUCK_REASON], ['command-ignored', commandReason('verify')], ['review-problems', REVIEW_REASON], ['coverage', coverageReason(3)],
  ] as const) {
    const log = newRunLog();
    recordCall(log, { name: 'read_file', args: { path: '/x/a.ts' }, output: 'text' });
    addTrigger(log, kind, reason);
    assert.deepEqual(offerFor(log), [reason], kind);
  }
  assert.equal(coverageReason(1), '1 affected place not checked.');
});

test('offered at most once per run, and never for a run with no tool use (plain chat)', () => {
  const chat = newRunLog();
  addTrigger(chat, 'stuck', STUCK_REASON);
  assert.equal(offerFor(chat), undefined, 'no tools: ordinary chat');
  const log = newRunLog();
  recordCall(log, { name: 'read_file', args: { path: '/x/a.ts' }, output: 'text' });
  assert.equal(offerFor(log), undefined, 'no trigger');
  addTrigger(log, 'stuck', STUCK_REASON);
  addTrigger(log, 'stuck', STUCK_REASON);
  assert.deepEqual(offerFor(log), [STUCK_REASON]);
  addTrigger(log, 'review-problems', REVIEW_REASON);
  assert.equal(offerFor(log), undefined, 'already offered this run');
});

test('review notes: problems vs "Looks good"', () => {
  assert.equal(reviewFoundProblems('Looks good.'), false);
  assert.equal(reviewFoundProblems('**Looks good** — nothing to change.'), false);
  assert.equal(reviewFoundProblems('LGTM'), false);
  assert.equal(reviewFoundProblems('No issues found.'), false);
  assert.equal(reviewFoundProblems('Stopped.'), false);
  assert.equal(reviewFoundProblems(''), false);
  assert.equal(reviewFoundProblems('- sum() still returns a string for empty input\n- the test expects 3'), true);
});

// MARK: the brief

test('error locations come from compiler, test and Python output', () => {
  const locs = errorLocations([
    'src/sum.ts:12:5 - error TS2322: Type string is not assignable',
    '    at Object.<anonymous> (/repo/test/sum.test.js:4:10)',
    'Sources/App/Main.swift:30:9: error: cannot find x',
    '  File "app/main.py", line 9, in <module>',
    'see https://example.com/a.html:80',
  ].join('\n'));
  assert.deepEqual(locs, [
    { file: 'src/sum.ts', line: 12 }, { file: '/repo/test/sum.test.js', line: 4 },
    { file: 'Sources/App/Main.swift', line: 30 }, { file: 'app/main.py', line: 9 },
  ]);
});

test('the brief has the goal, project, attempts, errors and only the relevant code', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
  lines[29] = 'export function sum(a, b) { return a - b; }';
  const root = project('brief', {
    'package.json': '{"name":"t"}',
    'tsconfig.json': '{}',
    'src/sum.js': lines.join('\n'),
    'test/sum.test.js': "const assert = require('assert');\nassert.equal(sum(1, 2), 3);\n",
    'src/unrelated.js': 'module.exports = 42;\n',
    '.env': 'API_KEY=sk-should-never-appear-0000000000000000',
  });
  const log = newRunLog(root);
  recordCall(log, { name: 'read_file', args: { path: 'test/sum.test.js' }, output: '…' });
  recordCall(log, { name: 'read_file', args: { path: '.env' }, output: '…' });
  recordCall(log, { name: 'edit_file', args: { path: 'src/sum.js' }, output: 'Edited src/sum.js' });
  const fail = `exit code 1\nAssertionError: -1 !== 3\n    at sum (${root}/src/sum.js:30:30)\n    at test/sum.test.js:2:8`;
  for (let i = 0; i < 3; i++) recordCall(log, { name: 'run_command', args: { command: 'npm test' }, output: fail });
  const reasons = offerFor(log)!;
  const { excerpts, omitted } = codeExcerpts(log);
  const files = excerpts.map((x) => x.file);
  assert.deepEqual(files, ['src/sum.js', 'test/sum.test.js']);
  assert.ok(!files.includes('.env') && !files.includes('src/unrelated.js'));
  assert.deepEqual([excerpts[0].start, excerpts[0].end], [20, 40], 'trimmed to around the error');
  assert.deepEqual(omitted, []);
  const brief = buildBrief({
    goal: 'Make sum() pass its test', project: projectLine(root, 'main'), model: 'Qwen3 8B', reasons,
    attempts: log.attempts, errors: log.errors, excerpts, omitted, lastReply: 'I could not get it to pass.',
    date: new Date(2026, 10, 4),
  });
  assert.match(brief, /^# Help wanted: Make sum\(\) pass its test/);
  assert.match(brief, /on 2026-11-04/);
  assert.match(brief, /## Goal\n\nMake sum\(\) pass its test/);
  assert.match(brief, /## Project\n\nbrief · Node\.js\/TypeScript \(git branch main\)/);
  assert.match(brief, /## Why it stopped\n\n- `npm test` failed 3 times\./);
  assert.match(brief, /## What was tried\n\n1\. read_file `test\/sum\.test\.js` → ok/);
  assert.match(brief, /run_command `npm test` → failed/);
  assert.match(brief, /## Errors\n\nFrom `npm test`:\n\n```text\nexit code 1\nAssertionError: -1 !== 3/);
  assert.match(brief, /### src\/sum\.js \(lines 20–40\)\n\n```js\n/);
  assert.match(brief, /return a - b;/);
  assert.match(brief, /## The local model’s last words\n\n> I could not get it to pass\./);
  assert.doesNotMatch(brief, /sk-should-never-appear/);
});

test('code excerpts stay within the budget and say what was left out', () => {
  const big = Array.from({ length: 80 }, (_, i) => `const v${i} = ${'x'.repeat(40)};`).join('\n');
  const root = project('budget', { 'a.js': big, 'b.js': big, 'c.js': big });
  const log = newRunLog(root);
  for (const f of ['a.js', 'b.js', 'c.js']) recordCall(log, { name: 'edit_file', args: { path: f }, output: 'ok' });
  const { excerpts, omitted } = codeExcerpts(log, 8000);
  assert.ok(excerpts.reduce((n, x) => n + x.text.length, 0) <= 8000);
  assert.ok(omitted.length >= 1);
  // Files outside the project are never quoted.
  const outside = project('outside', { 'x.js': 'secret stuff' });
  const log2 = newRunLog(root);
  recordCall(log2, { name: 'read_file', args: { path: path.join(outside, 'x.js') }, output: '' });
  assert.equal(codeExcerpts(log2).excerpts.length, 0);
});

test('scrubbing: a saved secret becomes its placeholder, other keys are redacted', () => {
  const value = 'hunter2-fake-secret-value';
  const text = `curl -H "Authorization: ${value}" … base64 ${Buffer.from(value).toString('base64')}\nghp_${'a1B2'.repeat(9)} and sk-ant-${'x'.repeat(30)}`;
  const out = scrubSecrets(text, [{ name: 'test-token', value }]);
  assert.ok(!out.includes(value));
  assert.ok(!out.includes(Buffer.from(value).toString('base64')));
  assert.match(out, /\{\{secret:test-token\}\}/);
  assert.match(out, /\[redacted GitHub token\]/);
  assert.match(out, /\[redacted Anthropic key\]/);
});

test('home paths and the username are redacted', () => {
  const text = 'at /Users/alice/Projects/app/src/a.ts:3 — owner alice, not malice or alice2';
  assert.equal(redactPaths(text, '/Users/alice', 'alice'), 'at ~/Projects/app/src/a.ts:3 — owner <user>, not malice or alice2');
  // Short usernames are left alone (they'd match ordinary words).
  assert.equal(redactPaths('ab cd', '/Users/ab', 'ab'), 'ab cd');
});

test('Flint gets a short summary of what was tried', () => {
  const log = newRunLog();
  for (let i = 0; i < 3; i++) recordCall(log, { name: 'run_command', args: { command: 'npm test' }, output: FAIL });
  const s = flintSummary('Qwen3 8B', offerFor(log)!, log.attempts, log.errors);
  assert.match(s, /^Ingle: Qwen3 8B tried this and couldn’t finish\. `npm test` failed 3 times\./);
  assert.match(s, /run_command `npm test` → failed/);
  assert.match(s, /AssertionError: 1 !== 2/);
  assert.ok(s.length < 2500);
});

test('briefs are saved as .ingle/briefs/YYYY-MM-DD-<slug>.md without overwriting', () => {
  const root = project('save', {});
  assert.equal(briefsDir(root), path.join(root, '.ingle', 'briefs'));
  assert.equal(briefsDir(undefined, '/h'), path.join('/h', '.ingle', 'briefs'));
  assert.equal(slug('Make sum() pass its test!'), 'make-sum-pass-its-test');
  const d = new Date(2026, 10, 4);
  const a = saveBrief(briefsDir(root), 'Make sum() pass', '# one', undefined, d);
  const b = saveBrief(briefsDir(root), 'Make sum() pass', '# two', undefined, d);
  assert.equal(path.basename(a), '2026-11-04-make-sum-pass.md');
  assert.equal(path.basename(b), '2026-11-04-make-sum-pass-2.md');
  assert.equal(saveBrief(briefsDir(root), 'x', '# one again', a, d), a);
  assert.equal(fs.readFileSync(a, 'utf8'), '# one again');
});
