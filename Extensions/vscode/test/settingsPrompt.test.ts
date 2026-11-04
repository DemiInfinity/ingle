import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { settingsPrompt } from '../src/engine/prompt';

const base = { model: 'qwen3.6:35b-mlx', role: 'Daily coding', effort: 'medium' as const, mode: 'ask' as const,
  reasoning: false, web: false, sshHosts: [] as string[] };

test('settingsPrompt: states every switch and what it means', () => {
  const t = settingsPrompt(base);
  assert.match(t, /## This chat's settings/);
  assert.match(t, /Effort: Medium/);
  assert.match(t, /Mode: Ask — every file change and command asks first/);
  assert.match(t, /Reasoning: Off — answer directly/);
  assert.match(t, /Web: Off/);
  assert.match(t, /SSH: Off/);
  assert.doesNotMatch(t, /Editor context/);
});

test('settingsPrompt: on states', () => {
  const t = settingsPrompt({ ...base, effort: 'high', mode: 'auto', reasoning: true, web: true, sshHosts: ['nas'], editor: true });
  assert.match(t, /Effort: High — read the related code first/);
  assert.match(t, /Mode: Auto/);
  assert.match(t, /Reasoning: On/);
  assert.match(t, /Web: On/);
  assert.match(t, /SSH: On — hosts: nas/);
  assert.match(t, /Editor context: On/);
});
