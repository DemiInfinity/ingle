// Task 32: the task list, plan mode's tool filtering, queued (steering) messages and committing a run's files.
import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  allDone, allowedInPlanMode, MAX_TASKS, parseTasks, planModeFilter, tasksFromPlan, tasksPrompt, tasksResult, tasksTool,
  type TaskItem,
} from '../src/tools/tasks';
import { canInsertNow, insertQueued, SteerQueue, steerText } from '../src/engine/steer';
import { cleanCommitMessage, commitFiles, diffFor, formatMessage, relativeTo, repoFor } from '../src/tools/gitCommit';
import { EFFORT } from '../src/engine/effort';

// MARK: task list state

test('parseTasks reads the list and its statuses', () => {
  const list = parseTasks({ items: [
    { content: 'Read the parser', status: 'done' },
    { content: 'Add a test', status: 'in_progress' },
    { content: 'Fix the bug', status: 'pending' },
  ] });
  assert.deepEqual(list, [
    { content: 'Read the parser', status: 'done' },
    { content: 'Add a test', status: 'in_progress' },
    { content: 'Fix the bug', status: 'pending' },
  ]);
});

test('parseTasks accepts JSON text, other status words and plain strings', () => {
  const list = parseTasks({ items: '[{"content":"One","status":"completed"},{"task":"Two","status":"In Progress"},"Three"]' }) as TaskItem[];
  assert.deepEqual(list.map((t) => t.status), ['done', 'in_progress', 'pending']);
  assert.deepEqual(list.map((t) => t.content), ['One', 'Two', 'Three']);
});

test('only one item stays in progress, and the list is capped', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ content: `Step ${i + 1}`, status: 'in_progress' }));
  const list = parseTasks({ items: many }) as TaskItem[];
  assert.equal(list.length, MAX_TASKS);
  assert.equal(list.filter((t) => t.status === 'in_progress').length, 1);
  assert.equal(list[0].status, 'in_progress');
});

test('bad input comes back as a sentence for the model', () => {
  assert.equal(typeof parseTasks({ items: 'not json' }), 'string');
  assert.equal(typeof parseTasks({}), 'string');
  assert.equal(typeof parseTasks({ items: [] }), 'string');
});

test('the tool stores the list and reports progress', async () => {
  let stored: TaskItem[] = [];
  const tool = tasksTool((l) => { stored = l; });
  const out = await tool.run({ items: [{ content: 'A', status: 'done' }, { content: 'B', status: 'in_progress' }] }, {} as never);
  assert.equal(stored.length, 2);
  assert.match(String(out), /1\/2 done\. Now: B/);
  assert.match(tasksResult([{ content: 'A', status: 'done' }]), /all 1 done/);
  assert.deepEqual(tool.describe({ items: [{ content: 'A', status: 'done' }, { content: 'B', status: 'pending' }] }).detail, '1/2 done');
});

test('the prompt shows an unfinished list and nothing once it is done', () => {
  const list: TaskItem[] = [{ content: 'A', status: 'done' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }];
  assert.equal(tasksPrompt(list).split('\n').slice(1).join('\n'), '[x] A\n[>] B\n[ ] C');
  assert.equal(tasksPrompt(list.map((t) => ({ ...t, status: 'done' as const }))), '');
  assert.equal(tasksPrompt(undefined), '');
  assert.ok(allDone([]));
  assert.ok(!allDone(list));
});

test('a plan reply becomes a task list (last numbered list wins)', () => {
  const reply = 'I looked at the code.\n\nFindings:\n- the parser skips blanks\n- no tests\n\nPlan:\n1. Add a failing test for blank lines\n2. **Fix** `parse()`\n   (keep the old signature)\n3. Run the tests\n\nShall I go ahead?';
  assert.deepEqual(tasksFromPlan(reply), [
    { content: 'Add a failing test for blank lines', status: 'in_progress' },
    { content: 'Fix parse()', status: 'pending' },
    { content: 'Run the tests', status: 'pending' },
  ]);
  assert.deepEqual(tasksFromPlan('Just one thing: rename it.'), []);
  assert.deepEqual(tasksFromPlan('1. Only one step'), []);
});

test('Max plans into the task list and High encourages it', () => {
  assert.ok(EFFORT.max.plan);
  assert.match(EFFORT.high.promptLine, /update_tasks/);
});

// MARK: plan mode tool filtering

test('plan mode offers only read/search tools, the task list and the helper', () => {
  const tools = [
    { name: 'read_file', readOnly: true }, { name: 'search_code', readOnly: true }, { name: 'web_search', readOnly: true },
    { name: 'edit_file', readOnly: false }, { name: 'write_file', readOnly: false }, { name: 'run_command', readOnly: false },
    { name: 'mcp_call', readOnly: false }, { name: 'memory_save', readOnly: false },
    { name: 'update_tasks', readOnly: false }, { name: 'delegate', readOnly: false },
  ];
  assert.deepEqual(planModeFilter(tools).map((t) => t.name), ['read_file', 'search_code', 'web_search', 'update_tasks', 'delegate']);
  assert.ok(!allowedInPlanMode({ name: 'edit_file', readOnly: false }));
  assert.ok(!allowedInPlanMode(undefined));
});

// MARK: queued messages (steer while it works)

type M = { role: string; content?: string; toolCalls?: unknown[] };

test('queued messages go in after the step’s tool results, in the order typed', () => {
  const q = new SteerQueue();
  q.push('chat', { id: '1', text: 'also handle tabs' });
  q.push('chat', { id: '2', text: 'and keep it short' });
  q.push('other', { id: '3', text: 'not this chat' });
  const msgs: M[] = [{ role: 'user', content: 'fix it' }, { role: 'assistant', toolCalls: [{}, {}] }, { role: 'tool' }];
  // Mid-step (one of two results still missing): nothing goes in yet.
  assert.equal(canInsertNow(msgs), false);
  assert.equal(insertQueued(msgs, q, 'chat', (m) => ({ role: 'user', content: m.text })), 0);
  msgs.push({ role: 'tool' });
  assert.equal(insertQueued(msgs, q, 'chat', (m) => ({ role: 'user', content: m.text })), 2);
  assert.deepEqual(msgs.slice(-3).map((m) => m.content ?? m.role), ['tool', 'also handle tabs', 'and keep it short']);
  assert.ok(!q.has('chat'));
  assert.deepEqual(q.peek('other').map((m) => m.text), ['not this chat']);
});

test('a queued message can be removed before it goes in', () => {
  const q = new SteerQueue();
  q.push('c', { id: 'a', text: 'one' });
  q.push('c', { id: 'b', text: 'two' });
  assert.ok(q.remove('c', 'a'));
  assert.ok(!q.remove('c', 'zzz'));
  assert.deepEqual(q.take('c').map((m) => m.text), ['two']);
  assert.deepEqual(q.take('c'), []);
});

test('the model is told the message came mid-run', () => {
  assert.match(steerText('use tabs'), /while you were working[\s\S]*\nuse tabs$/);
  assert.ok(canInsertNow([{ role: 'user' }]));
  assert.ok(canInsertNow([{ role: 'assistant' }]));
});

// MARK: commit exactly the run's files

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingle-workflow-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('commitFiles commits only the given files, including a deletion, and never pushes', async () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q');
  sh(repo, 'config', 'user.email', 'test@example.invalid');
  sh(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'bye\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'start');
  // The run: edits a.txt, creates new.txt, deletes gone.txt. Unrelated: other.txt (changed and staged).
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a changed\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  fs.rmSync(path.join(repo, 'gone.txt'));
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other changed\n');
  sh(repo, 'add', 'other.txt');
  const files = ['a.txt', 'new.txt', 'gone.txt'].map((f) => path.join(repo, f));
  const found = await repoFor(files);
  assert.ok('repo' in found, JSON.stringify(found));
  const rel = relativeTo(found.repo, files);
  assert.deepEqual(rel, ['a.txt', 'new.txt', 'gone.txt']);
  const diff = await diffFor(found.repo, rel);
  assert.match(diff, /a changed/);
  assert.match(diff, /\+new/);
  assert.doesNotMatch(diff, /other changed/);
  const r = await commitFiles(found.repo, rel, 'Change a, add new, remove gone', true);
  assert.ok('hash' in r, JSON.stringify(r));
  const shown = sh(repo, 'show', '--name-status', '--format=%B', 'HEAD');
  assert.match(shown, /^Change a, add new, remove gone/);
  assert.match(shown, /Signed-off-by: Test <test@example.invalid>/);
  assert.match(shown, /M\ta\.txt/);
  assert.match(shown, /A\tnew\.txt/);
  assert.match(shown, /D\tgone\.txt/);
  assert.doesNotMatch(shown, /other\.txt/);
  // other.txt is still staged, untouched by the commit.
  assert.match(sh(repo, 'status', '--porcelain'), /^M  other\.txt/m);
  // Nothing left to commit for the run's files.
  const again = await commitFiles(found.repo, rel.slice(0, 1), 'again', false);
  assert.ok('error' in again);
});

test('files outside a repo are refused; messages are cleaned', async () => {
  const loose = path.join(tmp, 'loose');
  fs.mkdirSync(loose);
  fs.writeFileSync(path.join(loose, 'x.txt'), 'x');
  const r = await repoFor([path.join(loose, 'x.txt')]);
  assert.ok('error' in r);
  assert.equal(cleanCommitMessage('```\nFix the parser\n```'), 'Fix the parser');
  assert.equal(cleanCommitMessage('<think>hmm</think>Commit message: "Add tests"'), 'Add tests');
  assert.equal(cleanCommitMessage('', ['/x/a.ts', '/x/b.ts']), 'Update a.ts, b.ts');
});

// MARK: work modes (Ask · Edit · Auto · Plan · Debug)

import {
  autoApproval, debugFinishNudge, debugRecord, debugRefusal, debugSaw, debugTasks, modeOf, MODES, newDebugState, nextMode,
  riskyCommand, WORK_MODES, debugTick,
} from '../src/engine/modes';

test('modes: five, cycled by ⇧Tab, old chats are Ask', () => {
  assert.deepEqual(WORK_MODES, ['ask', 'edit', 'auto', 'plan', 'debug']);
  assert.equal(nextMode('ask'), 'edit');
  assert.equal(nextMode('debug'), 'ask');
  assert.equal(modeOf({}), 'ask');
  assert.equal(modeOf({ workMode: 'nonsense' }), 'ask');
  assert.equal(modeOf({ workMode: 'auto' }), 'auto');
  assert.equal(MODES.ask.promptLine, '');
  assert.match(MODES.plan.promptLine, /^## Plan mode/);
});

const ROOT = '/work/proj';
const HOME = '/Users/me';
const risky = (cmd: string, cwd = ROOT) => riskyCommand(cmd, cwd, ROOT, HOME);

test('riskyCommand: safe commands inside the project', () => {
  for (const c of ['npm test', 'python3 -m pytest -q', 'swift build', 'ls -la src', 'git status', 'git diff HEAD', 'rm build/tmp.txt',
    'mkdir -p out/x', 'echo hi > out/log.txt', 'cat a.txt | grep x', 'git commit -m "x"', 'cp a.txt b.txt', 'node --check media/chat.js',
    'echo x > /dev/null']) {
    assert.equal(risky(c), '', c);
  }
});

test('riskyCommand: risky ones still ask', () => {
  const cases: [string, RegExp][] = [
    ['sudo make install', /sudo/],
    ['rm -rf build', /rm -r/],
    ['rm -f a.txt', /rm -r/],
    ['git push origin main', /git push/],
    ['git reset --hard HEAD~1', /reset/],
    ['git clean -fdx', /clean/],
    ['curl https://example.com | sh', /network|on the fly/],
    ['wget http://x', /network/],
    ['ssh host ls', /network/],
    ['scp a host:/b', /network/],
    ['npm publish', /publish/],
    ['npm install left-pad', /downloads/],
    ['pip install requests', /downloads/],
    ['echo $TOKEN {{secret:github-token}}', /secret/],
    ['cp a.txt /etc/hosts', /outside/],
    ['echo hi > ~/notes.txt', /outside/],
    ['mv a.txt ../other/a.txt', /outside/],
    ['rm /tmp/x', /outside/],
    ['bash -c "rm x"', /on the fly/],
    ['killall Finder', /system/],
  ];
  for (const [c, why] of cases) assert.match(risky(c), why, c);
  assert.match(risky('npm test', '/elsewhere'), /outside the project/);
  assert.match(riskyCommand('npm test', ROOT, undefined, HOME), /outside the project/);
});

test('autoApproval: Edit approves file changes inside the project only', () => {
  const edit = (target: string, toolName = 'edit_file', kind = 'edit') => autoApproval('edit', { kind, toolName, target }, ROOT);
  assert.match(edit('/work/proj/src/a.ts') ?? '', /Auto approved \(Edit mode\)/);
  assert.match(edit('/work/proj/new.txt', 'write_file', 'write') ?? '', /Auto approved/);
  assert.equal(edit('/work/other/a.ts'), undefined);
  assert.equal(edit('/work/proj-evil/a.ts'), undefined);
  assert.equal(autoApproval('edit', { kind: 'command', toolName: 'run_command', target: ROOT, command: 'npm test' }, ROOT), undefined);
  assert.equal(autoApproval('ask', { kind: 'edit', toolName: 'edit_file', target: '/work/proj/a.ts' }, ROOT), undefined);
  assert.equal(autoApproval('edit', { kind: 'edit', toolName: 'edit_file', target: '/work/proj/a.ts', secrets: true }, ROOT), undefined);
  assert.equal(autoApproval('edit', { kind: 'edit', toolName: 'edit_file', target: '/work/proj/a.ts' }, undefined), undefined);
});

test('autoApproval: Auto adds safe commands inside the project; never MCP, SSH, links or reads outside', () => {
  const cmd = (command: string, target = ROOT) => autoApproval('auto', { kind: 'command', toolName: 'run_command', target, command }, ROOT);
  assert.match(cmd('npm test') ?? '', /Auto approved \(Auto mode\)/);
  assert.equal(cmd('git push'), undefined);
  assert.equal(cmd('npm test', '/elsewhere'), undefined);
  assert.match(autoApproval('auto', { kind: 'edit', toolName: 'edit_file', target: '/work/proj/a.ts' }, ROOT) ?? '', /Auto mode/);
  for (const r of [{ kind: 'mcp', toolName: 'mcp_call' }, { kind: 'ssh', toolName: 'ssh_command', command: 'ls' }, { kind: 'open', toolName: 'open_url' },
    { kind: 'read', toolName: 'read_file', target: '/etc/hosts' }, { kind: 'memory', toolName: 'memory_save' }]) {
    assert.equal(autoApproval('auto', r, ROOT), undefined, r.toolName);
  }
  assert.equal(autoApproval('plan', { kind: 'edit', toolName: 'edit_file', target: '/work/proj/a.ts' }, ROOT), undefined);
});

test('Debug: edits wait for the failure and its cause; the fix must be confirmed', () => {
  const s = newDebugState();
  assert.deepEqual(debugTasks().map((t) => t.status), ['in_progress', 'pending', 'pending', 'pending']);
  assert.match(debugRefusal(s, 'edit_file') ?? '', /reproduce or locate/);
  assert.equal(debugRefusal(s, 'read_file'), undefined);
  debugRecord(s, 'run_command');          // reproduced
  assert.match(debugRefusal(s, 'edit_file') ?? '', /first write the cause/);
  debugSaw(s, 'The test fails because…\nCause: parse() skips the last line (see line 12).');
  assert.equal(debugRefusal(s, 'write_file'), undefined);
  debugRecord(s, 'edit_file');
  assert.match(debugFinishNudge(s) ?? '', /^Ingle: before you finish \(Debug mode\)/);
  debugRecord(s, 'run_command');          // rerun confirms
  assert.equal(debugFinishNudge(s), undefined);
  const t = newDebugState();
  t.located = t.cause = t.edited = true;
  assert.ok(debugFinishNudge(t));
  assert.ok(debugFinishNudge(t));
  assert.equal(debugFinishNudge(t), undefined, 'at most two nudges');
  const u = newDebugState();
  debugSaw(u, '**Root cause:** off by one');
  assert.ok(u.cause);
});

test('commit messages keep the summary as the subject (bug: lines were folded into it)', () => {
  assert.equal(formatMessage('Add calc module\nIntroduce add and subtract\nDocument the API'), 'Add calc module\n\nIntroduce add and subtract\nDocument the API');
  assert.equal(formatMessage('One line  '), 'One line');
  assert.equal(formatMessage('Subject\n\nBody'), 'Subject\n\nBody');
  assert.equal(cleanCommitMessage('Fix it\nbecause'), 'Fix it\n\nbecause');
});

test('Debug ticks its own task list as the steps happen (bug: it stayed 0/4 when the model never updated it)', () => {
  const s = newDebugState();
  let list = debugTasks();
  assert.equal(debugTick(s, list), undefined, 'nothing changed yet');
  debugRecord(s, 'read_file');
  list = debugTick(s, list)!;
  assert.deepEqual(list.map((t) => t.status), ['done', 'in_progress', 'pending', 'pending']);
  debugSaw(s, 'Cause: subtract adds');
  debugRecord(s, 'edit_file');
  debugRecord(s, 'run_command');
  list = debugTick(s, list)!;
  assert.deepEqual(list.map((t) => t.status), ['done', 'done', 'done', 'done']);
  assert.equal(debugTick(s, [{ content: 'The model’s own list', status: 'pending' }]), undefined, 'a replaced list is left alone');
});

// MARK: plan files

import { parsePlan, planFromReply, plansDir, renderPlan, savePlan, slug, tasksFromPlanFile, tickPlanFile, tickPlanText } from '../src/tools/planFiles';

test('plan files: where they go and their names', () => {
  assert.equal(plansDir('/work/proj', '/Users/me'), '/work/proj/.ingle/plans');
  assert.equal(plansDir(undefined, '/Users/me'), '/Users/me/.ingle/plans');
  assert.equal(slug('Add a subtract(a, b) function to calc.py!'), 'add-a-subtract-a-b-function');
  assert.equal(slug('???'), 'plan');
  const dir = path.join(tmp, 'plans');
  const doc = planFromReply('x\n1. A\n2. B', ['A', 'B'], 'Do the thing', 'chat-1', new Date('2026-11-04T10:00:00Z'));
  const a = savePlan(dir, doc, new Date('2026-11-04T10:00:00Z'));
  const b = savePlan(dir, doc, new Date('2026-11-04T10:00:00Z'));
  assert.equal(path.basename(a), '2026-11-04-do-the-thing.md');
  assert.equal(path.basename(b), '2026-11-04-do-the-thing-2.md');
});

test('plan files: written from a plan reply and read back', () => {
  const reply = 'I read calc.py.\n\nPlan:\n1. Add **subtract** to `calc.py`\n2. Write tests\n3. Update the README\n\nShall I go ahead?';
  const steps = tasksFromPlan(reply).map((t) => t.content);
  const doc = planFromReply(reply, steps, 'Add subtract, with tests.\nAnd docs.', 'chat-9', new Date('2026-11-04T10:00:00.123Z'));
  const text = renderPlan(doc);
  assert.match(text, /^---\ntitle: Add subtract, with tests\nstatus: draft\nchat: chat-9\ncreated: 2026-11-04T10:00:00Z\n---\n/);
  assert.match(text, /## Steps\n\n- \[ \] Add subtract to calc.py\n- \[ \] Write tests\n- \[ \] Update the README\n/);
  assert.match(text, /## Notes\n\nI read calc.py.\n\nPlan:\n\nShall I go ahead\?/);
  const back = parsePlan(text);
  assert.equal(back.title, 'Add subtract, with tests');
  assert.equal(back.status, 'draft');
  assert.equal(back.chat, 'chat-9');
  assert.deepEqual(back.steps.map((s) => s.content), ['Add subtract to calc.py', 'Write tests', 'Update the README']);
  assert.match(back.goal, /^Add subtract, with tests\.\nAnd docs\.$/);
});

test('plan files: Approve reads your edits, and steps are ticked in the file as they finish', () => {
  // You edited the file: removed a step, added one, ticked one, added a note.
  const edited = '---\ntitle: "Fix: the parser"\nstatus: draft\nchat: c\ncreated: x\n---\n\n# Fix: the parser\n\n## Goal\n\nFix it\n\n## Steps\n\n- [x] Read the parser\n- [ ] Add a failing test\n- [ ] Fix parse()\n\n## Notes\n\nKeep the old API.\n- [ ] not a step\n';
  const doc = parsePlan(edited);
  assert.equal(doc.title, 'Fix: the parser');
  const tasks = tasksFromPlanFile(doc);
  assert.deepEqual(tasks, [
    { content: 'Read the parser', status: 'done' },
    { content: 'Add a failing test', status: 'in_progress' },
    { content: 'Fix parse()', status: 'pending' },
  ]);
  const approved = tickPlanText(edited, tasks, 'approved')!;
  assert.match(approved, /\nstatus: approved\n/);
  const later = tickPlanText(approved, [
    { content: 'Read the parser', status: 'done' }, { content: 'Add a failing test', status: 'done' }, { content: 'Fix parse()', status: 'in_progress' },
  ])!;
  assert.match(later, /- \[x\] Add a failing test\n- \[ \] Fix parse\(\)/);
  assert.match(later, /- \[ \] not a step/, 'only the Steps section is touched');
  assert.match(later, /Keep the old API\./);
  // The model's list has different wording/length: ticked by matching text only.
  const done = tickPlanText(later, [{ content: 'fix parse()', status: 'done' }, { content: 'Something else', status: 'done' }])!;
  assert.match(done, /- \[x\] Fix parse\(\)/);
  assert.match(done, /\nstatus: done\n/, 'every step ticked → done');
  assert.equal(tickPlanText(done, [{ content: 'fix parse()', status: 'done' }]), undefined, 'nothing changed');
  const f = path.join(tmp, 'tick.md');
  fs.writeFileSync(f, edited);
  tickPlanFile(f, tasks, 'approved');
  assert.match(fs.readFileSync(f, 'utf8'), /status: approved/);
  tickPlanFile(path.join(tmp, 'missing.md'), tasks);  // no throw
});
