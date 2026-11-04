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
