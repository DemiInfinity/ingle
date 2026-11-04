import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// commands.ts reads ~/.ingle/commands, so point HOME at a temp folder before loading it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingle-home-'));
process.env.HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cmds: typeof import('../src/tools/commands') = require('../src/tools/commands');
type CommandEntry = import('../src/tools/commands').CommandEntry;
type CallRecord = import('../src/tools/commands').CallRecord;

function writeCommand(dir: string, file: string, text: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

const userDir = path.join(home, '.ingle', 'commands');
writeCommand(userDir, 'figma.md', [
  '---', 'description: Use Figma for UI', 'when: Component, UI kit', 'must_use: mcp:figma/get_file, search_code, skill:design',
  'never_use: write_file, mcp:github', 'then_run: npm run lint', '---', '', 'Check the design first.',
].join('\n'));
writeCommand(userDir, 'lint.md', '---\nwhen: always\nthen_run: npm test\n---\n');
writeCommand(userDir, 'blank-when.md', '---\ndescription: no when at all\nnever_use: open_url\n---\n');
writeCommand(userDir, 'off.md', '---\nwhen: always\nnever_use: run_command\nenabled: Off\n---\n');
writeCommand(userDir, 'notes.txt', '---\nwhen: always\n---\n');
const workspace = path.join(home, 'project');
writeCommand(path.join(workspace, '.ingle', 'commands'), 'deploy.md', '---\nwhen: deploy\nmust_use: run_command\n---\n');

const all = cmds.listCommands(workspace);
const byName = (n: string): CommandEntry => {
  const c = all.find((x) => x.name === n);
  assert.ok(c, `command ${n} loaded`);
  return c;
};

test('parseRequirement understands tools, mcp servers/tools and skills', () => {
  assert.deepEqual(cmds.parseRequirement(' search_code '), { kind: 'tool', tool: 'search_code', raw: 'search_code' });
  assert.deepEqual(cmds.parseRequirement('MCP: figma / get_file'), { kind: 'mcp', server: 'figma', tool: 'get_file', raw: 'MCP: figma / get_file' });
  assert.deepEqual(cmds.parseRequirement('mcp:github'), { kind: 'mcp', server: 'github', tool: undefined, raw: 'mcp:github' });
  assert.deepEqual(cmds.parseRequirement('skill:design'), { kind: 'skill', name: 'design', raw: 'skill:design' });
});

test('parseRequirement rejects empty items', () => {
  assert.equal(cmds.parseRequirement('   '), undefined);
  assert.equal(cmds.parseRequirement('mcp:'), undefined);
  assert.equal(cmds.parseRequirement('mcp:/tool'), undefined);
  assert.equal(cmds.parseRequirement('skill:  '), undefined);
});

test('listCommands loads .md files only, project ones prefixed', () => {
  assert.deepEqual(all.map((c) => c.name).sort(), ['blank-when', 'figma', 'lint', 'off', 'project/deploy']);
});

test('listCommands parses every field', () => {
  const f = byName('figma');
  assert.equal(f.description, 'Use Figma for UI');
  assert.deepEqual(f.when, ['component', 'ui kit']);
  assert.equal(f.always, false);
  assert.deepEqual(f.mustUse.map((r) => r.kind), ['mcp', 'tool', 'skill']);
  assert.deepEqual(f.neverUse, ['write_file', 'mcp:github']);
  assert.equal(f.thenRun, 'npm run lint');
  assert.equal(f.enabled, true);
  assert.equal(f.body, 'Check the design first.');
});

test('when: always and a missing when both mean always', () => {
  assert.equal(byName('lint').always, true);
  assert.deepEqual(byName('lint').when, []);
  assert.equal(byName('blank-when').always, true);
});

test('enabled accepts off/false/no/0 in any case', () => {
  assert.equal(byName('off').enabled, false);
});

test('activeCommands matches triggers case-insensitively as substrings', () => {
  const names = (msg: string) => cmds.activeCommands(all, msg).map((c) => c.name).sort();
  assert.deepEqual(names('Build a new COMPONENTS page'), ['blank-when', 'figma', 'lint']);
  assert.deepEqual(names('add it to the UI kit'), ['blank-when', 'figma', 'lint']);
  assert.deepEqual(names('Deploy to staging'), ['blank-when', 'lint', 'project/deploy']);
  assert.deepEqual(names('hello'), ['blank-when', 'lint']);
});

test('disabled commands are never active, even when always', () => {
  assert.ok(!cmds.activeCommands(all, 'anything').some((c) => c.name === 'off'));
});

test('bannedBy blocks tools by name and MCP calls by server', () => {
  const active = [byName('figma')];
  assert.equal(cmds.bannedBy(active, 'WRITE_FILE', {})?.item, 'write_file');
  assert.equal(cmds.bannedBy(active, 'mcp_call', { server: 'GitHub', tool: 'create_issue' })?.item, 'mcp:github');
  assert.equal(cmds.bannedBy(active, 'mcp_call', { server: 'figma', tool: 'get_file' }), undefined);
  assert.equal(cmds.bannedBy(active, 'read_file', {}), undefined);
});

test('blockedMessage suggests the non-skill must_use items instead', () => {
  const msg = cmds.blockedMessage(byName('figma'), 'write_file');
  assert.match(msg, /^Blocked by the command "figma": you must not use write_file\./);
  assert.match(msg, /mcp_call with server "figma" and tool "get_file"/);
  assert.match(msg, /use search_code/);
  assert.doesNotMatch(msg, /design skill/);
});

test('requirementMet checks the calls made this request', () => {
  const calls: CallRecord[] = [
    { name: 'Search_Code', args: {}, denied: false },
    { name: 'mcp_call', args: { server: 'figma', tool: 'list_pages' }, denied: false },
  ];
  const [mcpReq, toolReq, skillReq] = byName('figma').mustUse;
  assert.equal(cmds.requirementMet(toolReq, calls), true);
  assert.equal(cmds.requirementMet(mcpReq, calls), false, 'wrong MCP tool');
  assert.equal(cmds.requirementMet(mcpReq, [...calls, { name: 'mcp_call', args: { server: 'Figma', tool: 'GET_FILE' }, denied: false }]), true);
  assert.equal(cmds.requirementMet({ kind: 'mcp', server: 'figma', raw: 'mcp:figma' }, calls), true, 'any tool on the server');
  assert.equal(cmds.requirementMet(skillReq, []), true, 'skills are attached automatically');
});

test('thenRunOwed is true only after an allowed file change with no later matching run', () => {
  const edit: CallRecord = { name: 'edit_file', args: {}, denied: false };
  const run = (command: string): CallRecord => ({ name: 'run_command', args: { command }, denied: false });
  assert.equal(cmds.thenRunOwed('npm run lint', []), false);
  assert.equal(cmds.thenRunOwed('npm run lint', [edit]), true);
  assert.equal(cmds.thenRunOwed('npm run lint', [edit, run('cd app && NPM RUN LINT')]), false);
  assert.equal(cmds.thenRunOwed('npm run lint', [run('npm run lint'), edit]), true);
  assert.equal(cmds.thenRunOwed('npm run lint', [edit, run('npm test')]), true);
  assert.equal(cmds.thenRunOwed('npm run lint', [{ ...edit, denied: true }]), false, 'denied edits change nothing');
  assert.equal(cmds.thenRunOwed('  ', [edit]), false);
});

test('commandsBlock lists every active rule, and is empty with none', () => {
  assert.equal(cmds.commandsBlock([]), '');
  const block = cmds.commandsBlock([byName('figma')]);
  assert.match(block, /^## COMMANDS/);
  assert.match(block, /### figma — Use Figma for UI/);
  assert.match(block, /- Follow the design skill/);
  assert.match(block, /- Before you finish you MUST use search_code\./);
  assert.match(block, /- Never use mcp:github\./);
  assert.match(block, /- After changing files you MUST run: npm run lint/);
  assert.match(block, /Check the design first\.$/);
});

test('commandText writes frontmatter that listCommands reads back', () => {
  const text = cmds.commandText({ description: 'Lint\nalways', when: '', mustUse: '', neverUse: 'write_file', thenRun: 'npm run lint', instructions: '  Be tidy. ' });
  assert.equal(text, '---\ndescription: Lint always\nwhen: always\nnever_use: write_file\nthen_run: npm run lint\nenabled: true\n---\n\nBe tidy.\n');
  const dir = path.join(home, 'roundtrip');
  writeCommand(path.join(dir, '.ingle', 'commands'), 'rt.md', text);
  const back = cmds.listCommands(dir).find((c) => c.name === 'project/rt');
  assert.ok(back);
  assert.equal(back.always, true);
  assert.deepEqual(back.neverUse, ['write_file']);
  assert.equal(back.body, 'Be tidy.');
});

test('project commands are kept even when a user command has the same file name', () => {
  const dir = path.join(home, 'dupe');
  writeCommand(path.join(dir, '.ingle', 'commands'), 'lint.md', '---\nwhen: never\n---\n');
  // Project names are prefixed, so they can't clash with user ones; both are kept (as on the Mac).
  assert.deepEqual(cmds.listCommands(dir).filter((c) => c.name.endsWith('lint')).map((c) => c.name).sort(), ['lint', 'project/lint']);
});

test('listRules keeps a user rule and a project rule with the same file name', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const stores: typeof import('../src/tools/stores') = require('../src/tools/stores');
  const dir = path.join(home, 'rules-project');
  writeCommand(path.join(home, '.ingle', 'rules'), 'style.md', '---\ndescription: user style\n---\nUse tabs.');
  writeCommand(path.join(dir, '.ingle', 'rules'), 'style.md', '---\ndescription: project style\n---\nUse spaces.');
  assert.deepEqual(stores.listRules(dir).map((r) => r.name).sort(), ['project/style', 'style']);
});

// MARK: unified rules (task 8) — the Mac app (Commands.swift) follows the same rules.

test('rule: when means every request only when it is empty or exactly "always"', () => {
  assert.deepEqual(cmds.parseWhen(''), { when: [], always: true });
  assert.deepEqual(cmds.parseWhen(undefined), { when: [], always: true });
  assert.deepEqual(cmds.parseWhen(' ALWAYS '), { when: [], always: true });
  assert.deepEqual(cmds.parseWhen('always, deploy'), { when: ['always', 'deploy'], always: false });
  const dir = path.join(home, 'when-mixed');
  writeCommand(path.join(dir, '.ingle', 'commands'), 'mixed.md', '---\nwhen: always, deploy\nnever_use: open_url\n---\n');
  const mixed = cmds.listCommands(dir).find((c) => c.name === 'project/mixed');
  assert.ok(mixed);
  assert.equal(mixed.always, false);
  assert.equal(cmds.activeCommands([mixed], 'hello').length, 0);
  assert.equal(cmds.activeCommands([mixed], 'deploy it').length, 1);
});

test('rule: never_use accepts mcp:server and mcp:server/tool', () => {
  const c: CommandEntry = { ...byName('figma'), neverUse: ['mcp:tracker/delete_issue'] };
  assert.equal(cmds.bannedBy([c], 'mcp_call', { server: 'tracker', tool: 'delete_issue' })?.item, 'mcp:tracker/delete_issue');
  assert.equal(cmds.bannedBy([c], 'mcp_call', { server: 'tracker', tool: 'create_issue' }), undefined);
  assert.equal(cmds.bannedBy([byName('figma')], 'mcp_call', { server: 'github', tool: 'anything' })?.item, 'mcp:github');
  // mcp: bans are blocked per call, not removed by name.
  assert.deepEqual([...cmds.bannedToolNames([byName('figma')])], ['write_file']);
});

test('rule: required tools (and run_command for then_run) are offered from everything available', () => {
  assert.deepEqual([...cmds.requiredTools([byName('figma')])].sort(), ['mcp_call', 'mcp_tools', 'run_command', 'search_code']);
  assert.deepEqual([...cmds.requiredTools([byName('lint')])], ['run_command']);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sel: typeof import('../src/engine/toolSelection') = require('../src/engine/toolSelection');
  const available = [{ name: 'read_file', readOnly: true }, { name: 'view_image', readOnly: true }];
  const need = { mustUse: [cmds.parseRequirement('view_image')!], neverUse: [], thenRun: '' };
  const picked = sel.selectTools({ available, lastUser: 'hello', isSubAgent: false, active: [need], mcpToolNames: [], mcpWanted: false });
  assert.ok(picked.some((t) => t.name === 'view_image'), 'added although the filter would drop it');
});

test('rule: a required tool that cannot be offered gives ⚠ straight away with a reason, and no nudges', () => {
  const research: CommandEntry = { ...byName('lint'), name: 'research', thenRun: '', mustUse: [cmds.parseRequirement('web_search')!] };
  assert.equal(cmds.unavailableReason(research, ['read_file', 'run_command']), 'web_search isn’t available');
  assert.equal(cmds.unavailableReason(research, ['WEB_SEARCH']), undefined);
  assert.equal(cmds.unavailableReason(byName('lint'), ['read_file']), 'run_command isn’t available');
  assert.equal(cmds.unavailableReason(byName('figma'), ['search_code', 'run_command']), 'mcp_call isn’t available');
  const skillOnly: CommandEntry = { ...byName('lint'), thenRun: '', mustUse: [cmds.parseRequirement('skill:x')!] };
  assert.equal(cmds.unavailableReason(skillOnly, []), undefined, 'skills are attached, not offered');
  const givenUp = new Map([['research', 'web_search isn’t available']]);
  assert.equal(cmds.completionCheck([research], [], new Map(), givenUp), undefined, 'no nudge');
  assert.equal(cmds.ignoredChip('research', givenUp.get('research')!), '⚠ didn’t follow research (web_search isn’t available)');
  assert.equal(cmds.ignoredChip('lint', ''), '⚠ didn’t follow lint');
});

test('rule: every file-changing tool makes then_run owed', () => {
  assert.deepEqual(cmds.FILE_CHANGING_TOOLS.slice().sort(), ['edit_file', 'write_file']);
  for (const name of cmds.FILE_CHANGING_TOOLS) {
    assert.equal(cmds.thenRunOwed('npm test', [{ name, args: {}, denied: false }]), true, name);
  }
  assert.equal(cmds.thenRunOwed('npm test', [{ name: 'read_file', args: {}, denied: false }]), false);
});

test('rule: all owed commands go in one nudge, at most two per command, then ⚠', () => {
  const active = [byName('figma'), byName('lint')];
  const calls: CallRecord[] = [{ name: 'write_file', args: {}, denied: false }];
  const nudges = new Map<string, number>();
  const givenUp = new Map<string, string>();
  const first = cmds.completionCheck(active, calls, nudges, givenUp);
  assert.ok(first);
  assert.ok(first.startsWith(cmds.NUDGE_PREFIX));
  assert.ok(cmds.isNudgeText(first));
  assert.match(first, /the command "figma": use the figma MCP's get_file tool .*, and use search_code, and run `npm run lint`/);
  assert.match(first, /\n- the command "lint": run `npm test` with run_command/);
  assert.match(first, /Do that now, then finish your answer\.$/);
  assert.ok(cmds.completionCheck(active, calls, nudges, givenUp));
  assert.equal(cmds.completionCheck(active, calls, nudges, givenUp), undefined, 'no third nudge');
  assert.deepEqual([...givenUp.keys()].sort(), ['figma', 'lint']);
  // Once the work is done there's nothing owed.
  const done: CallRecord[] = [...calls, { name: 'run_command', args: { command: 'npm test' }, denied: false }];
  assert.equal(cmds.completionCheck([byName('lint')], done, new Map(), new Map()), undefined);
  assert.equal(cmds.nudgeText(['verify']), 'Ingle: before you finish, you still need to:\n- verify\nDo that now, then finish your answer.');
  assert.ok(cmds.isNudgeText('Ingle: the command "x" requires you to …'), 'older chats');
});

test('rule: command_create refuses advice-only commands, but hand-written ones still load', () => {
  const base = { name: 'tone', mustUse: '', neverUse: '', thenRun: '' };
  assert.match(cmds.commandCreateRefusal(base) ?? '', /rule_create/);
  assert.equal(cmds.commandCreateRefusal({ ...base, neverUse: 'write_file' }), undefined);
  assert.equal(cmds.commandCreateRefusal({ ...base, mustUse: 'web_search' }), undefined);
  assert.equal(cmds.commandCreateRefusal({ ...base, thenRun: 'npm test' }), undefined);
  assert.match(cmds.commandCreateRefusal({ ...base, name: ' ', thenRun: 'x' }) ?? '', /needs a name/);
  const dir = path.join(home, 'advice');
  writeCommand(path.join(dir, '.ingle', 'commands'), 'deep-research.md', '---\ndescription: Research deeply\nwhen: research\n---\n\nRead at least five sources.');
  const advice = cmds.listCommands(dir).find((c) => c.name === 'project/deep-research');
  assert.ok(advice);
  assert.equal(advice.body, 'Read at least five sources.');
  assert.match(cmds.commandsBlock([advice]), /### project\/deep-research — Research deeply\nRead at least five sources\.$/);
});

test('rule: helpers obey bans (tool names hidden, mcp: blocked per call)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sel: typeof import('../src/engine/toolSelection') = require('../src/engine/toolSelection');
  const available = [{ name: 'read_file', readOnly: true }, { name: 'web_fetch', readOnly: true }, { name: 'write_file', readOnly: false }];
  const ban = { mustUse: [], neverUse: ['web_fetch', 'mcp:github'], thenRun: '' };
  const names = sel.selectTools({ available, lastUser: 'x', isSubAgent: true, active: [ban], mcpToolNames: [], mcpWanted: false }).map((t) => t.name);
  assert.deepEqual(names, ['read_file']);
  assert.ok(cmds.bannedBy([{ ...byName('figma'), ...ban }], 'mcp_call', { server: 'github' }));
});

test('rule: a command whose final name is taken is skipped, with a note in the index', () => {
  const dir = path.join(home, 'dupe-names');
  const cdir = path.join(dir, '.ingle', 'commands');
  writeCommand(cdir, 'a.md', '---\nname: same\nwhen: x\nnever_use: open_url\n---\n');
  writeCommand(cdir, 'b.md', '---\nname: same\nwhen: y\nnever_use: open_url\n---\n');
  writeCommand(userDir, 'clash.md', '---\nname: project/clash\nwhen: z\nnever_use: open_url\n---\n');
  writeCommand(cdir, 'clash.md', '---\nwhen: z\nnever_use: write_file\n---\n');
  try {
    const { commands, skipped } = cmds.loadAllCommands(dir);
    assert.deepEqual(commands.filter((c) => c.name === 'project/same').map((c) => c.when), [['x']], 'first one wins');
    assert.deepEqual(commands.filter((c) => c.name === 'project/clash').map((c) => c.neverUse), [['open_url']], 'yours wins');
    assert.deepEqual(skipped.map((c) => path.basename(c.file)).sort(), ['b.md', 'clash.md']);
    const index = cmds.commandsIndexText(dir);
    assert.match(index, /Skipped .*b\.md: another command is already called project\/same\./);
    assert.match(index, /Skipped .*clash\.md: another command is already called project\/clash\./);
  } finally {
    fs.rmSync(path.join(userDir, 'clash.md'));
  }
});
