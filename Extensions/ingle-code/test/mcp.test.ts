// The MCP layer: protocol handshake, tools/list, tools/call, errors, and a real child process that exits cleanly.
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { McpServer, TOOL_NAMES } from '../src/index';
import { copyFixture, cleanup } from './helpers';

after(cleanup);

function client(write: (line: string) => void) {
  let id = 0;
  const waiting = new Map<number, (m: any) => void>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    onLine(line: string) { const m = JSON.parse(line); waiting.get(m.id)?.(m); },
    req(method: string, params: unknown = {}) {
      const n = ++id;
      return new Promise<any>((r) => { waiting.set(n, r); write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); }); // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  };
}

test('in-process MCP server: handshake, list, call, errors', async () => {
  const root = copyFixture('ts-shop', { git: true });
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new McpServer(input, output, { root, noServers: true });
  const done = server.run();
  const c = client((l) => input.write(l));
  let buf = '';
  output.on('data', (d: Buffer) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { c.onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });

  const init = await c.req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.serverInfo.name, 'ingle-code');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await c.req('tools/list');
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), TOOL_NAMES);
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');

  const refs = await c.req('tools/call', { name: 'references', arguments: { symbol: 'discount' } });
  assert.equal(refs.result.isError, false);
  assert.match(refs.result.content[0].text, /^references to discount: \d+ in 3 files/);

  const json = await c.req('tools/call', { name: 'definition', arguments: { symbol: 'discount', format: 'json' } });
  assert.equal(JSON.parse(json.result.content[0].text).items[0].file, 'src/pricing.ts');

  const missing = await c.req('tools/call', { name: 'references', arguments: {} });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /Missing argument: symbol/);

  const unknown = await c.req('tools/call', { name: 'edit_file', arguments: {} });
  assert.equal(unknown.result.isError, true);

  const bad = await c.req('nope/method');
  assert.equal(bad.error.code, -32601);
  assert.deepEqual((await c.req('ping')).result, {});

  input.end();
  await done;
  await server.close();
});

test('bin entry point runs as a process and exits when stdin closes', { timeout: 30_000 }, async () => {
  const root = copyFixture('swift-shop');
  const main = path.resolve(__dirname, '..', 'src', 'mcp', 'main.js');
  const proc = spawn(process.execPath, [main, '--root', root, '--no-servers'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const c = client((l) => proc.stdin.write(l));
  let buf = '';
  proc.stdout.on('data', (d: Buffer) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { c.onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const r = await c.req('tools/call', { name: 'code_status', arguments: {} });
  assert.match(r.result.content[0].text, /swift: 4 files, approximate/);
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  proc.stdin.end();
  assert.equal(await exited, 0);
});
