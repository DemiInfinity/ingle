import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { selectTools, type SelectableTool, type SelectionInput } from '../src/engine/toolSelection';
import { parseRequirement, type Requirement } from '../src/tools/commands';

const tool = (name: string, readOnly = false): SelectableTool => ({ name, readOnly });
const ALL: SelectableTool[] = [
  tool('read_file', true), tool('list_files', true), tool('search_code', true), tool('edit_file'), tool('write_file'),
  tool('run_command'), tool('skill_create'), tool('rule_create'), tool('command_create'), tool('read_document', true),
  tool('view_image', true), tool('open_url'), tool('memory_read', true), tool('memory_rewrite'), tool('memory_forget'),
  tool('mcp_tools', true), tool('mcp_call'),
];
const DELEGATE = tool('delegate');

function pick(lastUser: string, over: Partial<SelectionInput<SelectableTool>> = {}): string[] {
  return selectTools({
    available: ALL, lastUser, isSubAgent: false, active: [], mcpToolNames: ['mcp_tools', 'mcp_call'],
    mcpWanted: false, delegate: DELEGATE, ...over,
  }).map((t) => t.name);
}
const cmd = (mustUse: string[], neverUse: string[] = []) => ({
  mustUse: mustUse.map(parseRequirement).filter((r): r is Requirement => !!r), neverUse,
});

test('a plain coding message gets only the core tools', () => {
  assert.deepEqual(pick('fix the failing build'), ['read_file', 'list_files', 'search_code', 'edit_file', 'write_file', 'run_command']);
});

test('optional tools appear when the message mentions them', () => {
  assert.ok(pick('make a skill for releases').includes('skill_create'));
  assert.ok(pick('make a skill for releases').includes('rule_create'));
  assert.ok(pick('write a command for linting').includes('command_create'));
  assert.ok(pick('Summarise this PDF').includes('read_document'));
  assert.ok(pick('look at the screenshot').includes('view_image'));
  assert.ok(pick('open the docs page in the browser').includes('open_url'));
  assert.ok(pick('see https://example.test').includes('open_url'));
  assert.deepEqual(pick('remember I like tabs').filter((n) => n.startsWith('memory_')), ['memory_read', 'memory_rewrite', 'memory_forget']);
});

test('"open" alone does not offer open_url', () => {
  assert.ok(!pick('open the file').includes('open_url'));
});

test('MCP tools follow mcpWanted', () => {
  assert.ok(!pick('list my issues').includes('mcp_call'));
  assert.deepEqual(pick('list my issues', { mcpWanted: true }).filter((n) => n.startsWith('mcp_')), ['mcp_tools', 'mcp_call']);
});

test('delegate is added for research-style requests only', () => {
  assert.ok(!pick('fix the bug').includes('delegate'));
  assert.equal(pick('Investigate why the tests are slow').at(-1), 'delegate');
  assert.ok(pick('compare these libraries').includes('delegate'));
  assert.ok(!pick('investigate it', { delegate: undefined }).includes('delegate'));
});

test('sub-agents only get read-only tools and never delegate', () => {
  const got = pick('investigate the memory pdf screenshot', { isSubAgent: true });
  assert.deepEqual(got, ['read_file', 'list_files', 'search_code', 'read_document', 'view_image', 'memory_read', 'mcp_tools']);
});

test('must_use forces tools that would otherwise be hidden', () => {
  const got = pick('hello', { active: [cmd(['view_image', 'DELEGATE'])] });
  assert.ok(got.includes('view_image'));
  assert.ok(got.includes('delegate'));
});

test('must_use of an MCP forces the MCP tools', () => {
  assert.ok(pick('hello', { active: [cmd(['mcp:figma'])] }).includes('mcp_call'));
});

test('never_use removes tools, even ones forced by another command', () => {
  const got = pick('remember this', { active: [cmd(['memory_read']), cmd([], [' Write_File ', 'memory_read', 'mcp:github'])] });
  assert.ok(!got.includes('write_file'));
  assert.ok(!got.includes('memory_read'));
  assert.ok(got.includes('memory_rewrite'));
});

test('never_use of an MCP server leaves the MCP tools (blocked per call instead)', () => {
  assert.ok(pick('use mcp', { mcpWanted: true, active: [cmd([], ['mcp:github'])] }).includes('mcp_call'));
});

test('selectTools does not change the list it is given', () => {
  const available = [...ALL];
  pick('investigate', { available });
  assert.deepEqual(available, ALL);
});

test('never_use also hides tools from sub-agents', () => {
  const got = pick('read the readme', { isSubAgent: true, active: [cmd([], ['READ_FILE'])] });
  assert.ok(!got.includes('read_file'));
  assert.ok(got.includes('list_files'));
});
