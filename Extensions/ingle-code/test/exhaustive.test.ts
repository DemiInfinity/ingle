// read_exhaustively against a fake local Ollama (no model needed), plus the local-only and unreachable rules.
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { CodeEngine, callTool } from '../src/index';
import { chunkLines, parseNote, resolveOllamaHost } from '../src/engine/exhaustive';
import { copyFixture, cleanup } from './helpers';

after(cleanup);

test('OLLAMA_HOST must be local', () => {
  assert.equal(resolveOllamaHost('http://localhost:11434'), 'http://localhost:11434');
  assert.equal(resolveOllamaHost('127.0.0.1:1234'), 'http://127.0.0.1:1234');
  assert.equal(resolveOllamaHost('0.0.0.0'), 'http://127.0.0.1:11434');
  assert.equal(resolveOllamaHost(':9999'), 'http://localhost:9999');
  assert.throws(() => resolveOllamaHost('http://example.com:11434'), /only uses a local engine/);
  assert.throws(() => resolveOllamaHost('192.168.1.5'), /only uses a local engine/);
});

test('chunks cover every line exactly once', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} ${'x'.repeat(i % 50)}`);
  const chunks = chunkLines(lines, 2000);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[chunks.length - 1].endLine, 1000);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].startLine, chunks[i - 1].endLine + 1);
  assert.ok(chunks.every((c) => c.text.length <= 2000));
});

test('notes parse from JSON or fall back to text', () => {
  assert.deepEqual(parseNote('{"relevant": true, "note": "error at line 5"}'), { relevant: true, note: 'error at line 5' });
  assert.equal(parseNote('not json').relevant, false);
});

test('reads a big log in pages of chunks with a local model', async (t) => {
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'big:70b', size: 9e10 }, { name: 'nomic-embed-text', size: 1e8 }, { name: 'coder:0.5b-base', size: 5e8 }, { name: 'tiny:1b', size: 1e9 }] })); return; }
      if (req.url === '/api/version') { res.end('{"version":"0"}'); return; }
      const j = JSON.parse(body);
      prompts.push(j.prompt);
      assert.equal(j.model, 'tiny:1b');
      const relevant = /FATAL/.test(j.prompt);
      res.end(JSON.stringify({ response: JSON.stringify({ relevant, note: relevant ? 'FATAL error found' : 'routine info lines' }) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const root = copyFixture('ts-shop');
  const log = Array.from({ length: 3000 }, (_, i) => (i === 2500 ? 'FATAL: disk full' : `INFO request ${i} ok`));
  fs.writeFileSync(path.join(root, 'app.log'), log.join('\n'));
  const engine = new CodeEngine({ root, noServers: true, ollamaHost: `http://127.0.0.1:${port}` });
  t.after(() => engine.dispose());

  const p1 = await engine.readExhaustively('app.log', 'Why did it crash?');
  assert.equal(p1.model, 'tiny:1b');
  assert.ok(p1.chunks > p1.notes.length, 'more chunks than one page');
  assert.equal(p1.fromChunk, 1);
  let all = [...p1.notes];
  for (let page = 2; page <= p1.pages; page++) all = all.concat((await engine.readExhaustively('app.log', 'Why did it crash?', { page })).notes);
  assert.equal(all.length, p1.chunks, 'every chunk read once');
  assert.equal(all[all.length - 1].endLine, 3000);
  const hit = all.filter((n) => n.relevant);
  assert.equal(hit.length, 1);
  assert.ok(hit[0].startLine <= 2501 && 2501 <= hit[0].endLine);
  assert.equal(prompts.length, p1.chunks);

  const text = await callTool(engine, 'read_exhaustively', { path: 'app.log', question: 'crash?' });
  assert.match(text.text, /not finished: \d+ chunks left\. Call again with page: 2/);
});

test('unreachable Ollama gives a clear error', async (t) => {
  const root = copyFixture('ts-shop');
  const engine = new CodeEngine({ root, noServers: true, ollamaHost: 'http://127.0.0.1:9', model: 'x' });
  t.after(() => engine.dispose());
  const out = await callTool(engine, 'read_exhaustively', { path: 'src/cart.ts', question: 'what?' });
  assert.equal(out.isError, true);
  assert.match(out.text, /Ollama isn't reachable at http:\/\/127\.0\.0\.1:9/);
  const remote = new CodeEngine({ root, noServers: true, ollamaHost: 'http://10.0.0.2:11434' });
  t.after(() => remote.dispose());
  const r = await callTool(remote, 'read_exhaustively', { path: 'src/cart.ts', question: 'what?' });
  assert.match(r.text, /only uses a local engine/);
});
