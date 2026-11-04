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

test('settingsPrompt: the other assistant, awake or asleep', () => {
  const asleep = settingsPrompt({ ...base, me: 'Ember', others: [{ name: 'Flint', role: 'hard jobs', awake: false }] });
  assert.match(asleep, /Flint \(hard jobs\): asleep right now/);
  assert.match(asleep, /answer as yourself \(Ember\) — never pretend to be Flint/);
  assert.match(asleep, /differently each time/);
  const awake = settingsPrompt({ ...base, me: 'Ember', others: [{ name: 'Flint', role: 'hard jobs', awake: true }] });
  assert.match(awake, /Flint \(hard jobs\): awake too right now/);
});

test('settingsPrompt: knows who the user was talking to before switching', () => {
  const t = settingsPrompt({ ...base, me: 'Ember', earlier: ['Flint'] });
  assert.match(t, /Earlier in this chat the user was talking to Flint/);
  assert.match(t, /now you, Ember, have taken over/);
  assert.doesNotMatch(settingsPrompt({ ...base, me: 'Ember', earlier: ['Ember'] }), /Earlier in this chat/);
});

test('settingsPrompt: Ember and Flint talk about themselves as a team ("we")', () => {
  const t = settingsPrompt({ ...base, me: 'Ember', others: [{ name: 'Flint', role: 'hard jobs', awake: false }] });
  assert.match(t, /You and Flint are one team inside Ingle/);
  assert.match(t, /share the same memory, rules, skills, commands and this chat's history/);
  assert.match(t, /Talk about the team as "we"/);
  assert.match(t, /Never call yourselves separate, unconnected instances/);
});
