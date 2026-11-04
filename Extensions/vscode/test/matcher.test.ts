import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { keywordMatches, Matcher, semanticBar, words } from '../src/engine/matcher';
import type { OllamaClient } from '../src/engine/ollama';

test('words drops short words and stop words', () => {
  assert.deepEqual([...words('Please help me deploy this Swift app to TestFlight')].sort(), ['deploy', 'swift', 'testflight']);
});

const candidates = [
  { id: 'skill:swift-release', text: 'Release a Swift app: archive with xcodebuild, upload to TestFlight, notarise' },
  { id: 'rule:british-english', text: 'Write British English in UI text and docs' },
  { id: 'memory:pets', text: 'The user has two cats called Pixel and Byte' },
];

test('keywordMatches needs an overlap score of at least 3', () => {
  assert.deepEqual(keywordMatches('archive and upload the swift build', candidates), ['skill:swift-release']);
  assert.deepEqual(keywordMatches('upload a photo', candidates), []);
});

test('a word in the candidate id counts as 2', () => {
  // "release" is in the id; "swift" overlaps the text → 2 + 1 (+1 for "release" in the text too).
  assert.deepEqual(keywordMatches('release swift', candidates), ['skill:swift-release']);
  assert.deepEqual(keywordMatches('cats pixel', candidates), [], 'two text words only score 2');
});

test('keywordMatches orders by score and respects the limit', () => {
  const many = [
    { id: 'a', text: 'alpha bravo charlie' },
    { id: 'b', text: 'alpha bravo charlie delta echo' },
  ];
  assert.deepEqual(keywordMatches('alpha bravo charlie delta echo', many), ['b', 'a']);
  assert.deepEqual(keywordMatches('alpha bravo charlie delta echo', many, 1), ['b']);
});

test('Matcher ignores short messages and uses keywords without the embed model', async () => {
  let embedCalls = 0;
  const client = { embed: async () => { embedCalls++; return null; } } as unknown as OllamaClient;
  const m = new Matcher();
  assert.deepEqual(await m.matches(client, [], 'thanks swift', candidates), []);
  assert.deepEqual(await m.matches(client, ['llama3'], 'archive and upload the swift build', candidates), ['skill:swift-release']);
  assert.equal(embedCalls, 0);
});

test('Matcher falls back to keywords when embeddings fail', async () => {
  const client = { embed: async () => null } as unknown as OllamaClient;
  const got = await new Matcher().matches(client, ['nomic-embed-text:latest'], 'archive and upload the swift build', candidates);
  assert.deepEqual(got, ['skill:swift-release']);
});

/** Fake embeddings: the query points along axis 0; the candidate with id `winner` does too, the rest are spread out. */
function fakeClient(cands: { id: string; text: string }[], winner: string): OllamaClient {
  return {
    embed: async (_model: string, input: string[]) => input.map((s) => {
      if (s.startsWith('search_query: ')) return [1, 0, 0, 0, 0, 0, 0, 0, 0];
      const i = cands.findIndex((x) => s === 'search_document: ' + x.text);
      const v = new Array(9).fill(0);
      if (cands[i]?.id === winner) v[0] = 1; else v[1 + (i % 8)] = 1;
      return v;
    }),
  } as unknown as OllamaClient;
}

test('Matcher returns a clear semantic winner among many candidates', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `skill:s${i}`, text: `candidate number ${i}` }));
  const got = await new Matcher().matches(fakeClient(many, 'skill:s3'), ['nomic-embed-text'], 'ship the new build to testers today', many);
  assert.deepEqual(got, ['skill:s3']);
});

test('Matcher finds a clear semantic winner among only a few candidates', async () => {
  // Used to return nothing: one outlier among n <= 5 can't be 2 SD above the mean.
  const got = await new Matcher().matches(fakeClient(candidates, 'skill:swift-release'), ['nomic-embed-text'], 'archive and upload the swift build', candidates);
  assert.deepEqual(got, ['skill:swift-release']);
});

test('semanticBar: few candidates need 1 SD and 0.75, many need 2 SD and 0.7', () => {
  assert.equal(semanticBar([0.8]), 0.8, 'one candidate: its own score, if at least 0.75');
  assert.equal(semanticBar([0.72]), 0.75);
  assert.ok(Math.abs(semanticBar([0.9, 0.5]) - 0.9) < 1e-9, 'two candidates: the top one only');
  assert.equal(semanticBar([0.72, 0.7, 0.68]), 0.75, 'middling scores, no winner');
  const many = [0.95, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3];
  assert.ok(semanticBar(many) < 0.95 && semanticBar(many) > 0.7);
  assert.equal(semanticBar([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), 0.7);
});
