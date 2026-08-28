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
  assert.deepEqual(tokens, ['fix', 'flaky', 'integration', 'postgres', 'test']);
});

test('the tokens are sorted, so the sentence cannot be reconstructed', () => {
  // Order is the last thing that carries the prompt's meaning as prose. Sorting
  // is what turns "a list of the words you typed, in order" into a bag.
  const tokens = signalTokens('zebra apple monkey');
  assert.deepEqual(tokens, ['apple', 'monkey', 'zebra']);
});

test('a distinctive phrase never survives as a phrase', () => {
  // Sorting can leave two words next to each other by coincidence, so the
  // property worth asserting is not "no pair survives" -- it is that the
  // PROMPT'S order is gone and the sentence itself is nowhere in the output.
  const phrase = 'nightingale acquisition closes before the quarterly restructure';
  const tokens = signalTokens(phrase);
  assert.ok(!JSON.stringify(tokens).includes(phrase), 'the phrase survived verbatim');
  assert.ok(!tokens.join(' ').includes('nightingale acquisition'), 'the prompt order survived');
  assert.deepEqual(tokens, [...tokens].sort(), 'the tokens are not sorted');
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

test('an unterminated fence takes everything after it', () => {
  // A prompt that opens a code block and never closes it is common -- the
  // paste got truncated, or the model is mid-sentence. Treating the remainder
  // as prose would ship the whole snippet.
  const tokens = signalTokens('look at this\n```js\nconst apiSecret = "hunter2";\n');
  assert.ok(tokens.includes('look'));
  assert.ok(!tokens.includes('apisecret'));
  assert.ok(!tokens.includes('hunter2'));
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
  // Assembled at runtime on purpose. Spelling a live-key-shaped literal into a
  // file in a PUBLIC repo trips GitHub's push protection -- and it would be
  // indistinguishable from a real leak to anyone reading the history later.
  const secret = 'Zq7Xm2Rt9Vb4Nh6Kd1Ls8Pw3Cy5Ge0Ja';
  const credentialShaped = ['sk', 'live', secret].join('_');
  const tokens = signalTokens(`token ${credentialShaped}`);
  // The whole credential must be gone, not merely shortened -- assert that
  // directly rather than inferring it from a length bound, which a tokeniser
  // that split the key into harmless-looking chunks would also satisfy.
  assert.deepEqual(tokens, ['token'], `credential survived tokenisation: ${tokens}`);
  assert.ok(!tokens.some((t) => secret.toLowerCase().includes(t)), 'a fragment of the key survived');
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
