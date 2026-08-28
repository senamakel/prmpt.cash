// Local tokenisation of the user's prompt.
//
// This module is the entire privacy story of the status-line surface. The
// prompt itself never leaves the machine: what goes over the wire is a sorted
// bag of individual keywords, from which the sentence cannot be rebuilt.
//
// These are unit tests on a pure function because the property being asserted
// -- "this text does not survive this transformation" -- is a property of the
// transformation, and is much easier to pin down here than through a process
// boundary. hooks/prompt-start.mjs is tested at the process boundary too.

import test from 'node:test';
import assert from 'node:assert/strict';

import { signalTokens } from '../hooks/lib/tokens.mjs';

test('a prompt becomes lowercased keywords with the stopwords removed', () => {
  const tokens = signalTokens('Please fix the flaky Postgres integration test');
  assert.deepEqual(tokens, ['flaky', 'fix', 'integration', 'postgres', 'test']);
});

test('the tokens are sorted, so the sentence cannot be reconstructed', () => {
  // Order is the last thing that carries the prompt's meaning as prose. Sorting
  // is what turns "a list of the words you typed, in order" into a bag.
  const tokens = signalTokens('zebra apple monkey');
  assert.deepEqual(tokens, ['apple', 'monkey', 'zebra']);
});

test('a distinctive phrase never survives as a phrase', () => {
  const phrase = 'acquire nightingale before the quarterly restructure';
  const tokens = signalTokens(phrase);
  assert.ok(!JSON.stringify(tokens).includes(phrase), 'the phrase survived verbatim');
  assert.ok(!tokens.join(' ').includes('acquire nightingale'), 'two adjacent words survived');
});

test('duplicates collapse', () => {
  assert.deepEqual(signalTokens('cache cache CACHE Cache'), ['cache']);
});

test('very short and very long words are dropped', () => {
  const tokens = signalTokens(`a bc ${'x'.repeat(60)} defg`);
  assert.deepEqual(tokens, ['bc', 'defg']);
});

test('the list is capped', () => {
  const many = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  const tokens = signalTokens(many);
  assert.ok(tokens.length <= 32, `expected at most 32 tokens, got ${tokens.length}`);
});

// --- the things that must never become a token ------------------------------

test('fenced code blocks are removed before tokenising', () => {
  const tokens = signalTokens('speed this up\n```\nconst apiSecret = "hunter2";\n```\n');
  assert.ok(tokens.includes('speed'));
  for (const leaked of ['apisecret', 'hunter2', 'const']) {
    assert.ok(!tokens.includes(leaked), `code block leaked: ${leaked}`);
  }
});

test('inline code spans are removed before tokenising', () => {
  const tokens = signalTokens('why does `SUPER_SECRET_VALUE` break the build');
  assert.ok(tokens.includes('build'));
  assert.ok(!tokens.includes('super_secret_value'));
  assert.ok(!tokens.includes('super'));
});

test('URLs, paths and email addresses are removed whole', () => {
  const tokens = signalTokens(
    'check https://internal.acme.example/secret-plan and /home/janedoe/keys.txt ' +
    'then mail jane.doe@acme.example about deploys',
  );
  assert.ok(tokens.includes('deploys'), 'ordinary words still survive');
  for (const leaked of ['internal', 'acme', 'janedoe', 'keys', 'jane', 'doe', 'secret', 'plan', 'home']) {
    assert.ok(!tokens.includes(leaked), `identifier leaked: ${leaked}`);
  }
});

test('Windows paths are removed too', () => {
  const tokens = signalTokens('open C:\\Users\\JaneSmith\\secrets.env please');
  assert.ok(tokens.includes('open'));
  assert.ok(!tokens.includes('janesmith'));
  assert.ok(!tokens.includes('users'));
});

test('high-entropy blobs that look like secrets are dropped', () => {
  const tokens = signalTokens(
    'rotate the key 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a and redeploy',
  );
  assert.deepEqual(tokens, ['key', 'redeploy', 'rotate']);
});

test('a token is never long enough to be a credential', () => {
  const tokens = signalTokens('token sk-live-REDACTED-TEST-FIXTURE');
  assert.ok(tokens.every((t) => t.length <= 24), `over-long token survived: ${tokens}`);
});

// --- shape ------------------------------------------------------------------

test('anything that is not a string yields no tokens', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.deepEqual(signalTokens(bad), []);
  }
});

test('a prompt made only of stopwords yields nothing', () => {
  assert.deepEqual(signalTokens('can you please do it for me'), []);
});

test('only the head of a very long prompt is read', () => {
  // Bounded work: UserPromptSubmit blocks the user, so a pasted novel must not
  // turn into a linear scan of megabytes.
  const tokens = signalTokens('alpha ' + 'filler '.repeat(200000) + 'omega');
  assert.ok(tokens.includes('alpha'));
  assert.ok(!tokens.includes('omega'), 'the tail was read after all');
});
