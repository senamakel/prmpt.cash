// The prompt-start hook: Claude Code's UserPromptSubmit.
//
// This is the fetch half of the status-line surface. It runs at the instant
// the user presses enter, which means two things at once:
//
//   - it BLOCKS the user, so it must exit immediately and do its network call
//     in a detached child, exactly the way self-enrolment and auto-update do;
//   - it is the only place in the plugin that has ever seen the user's prompt,
//     so the assertions about what does NOT leave the machine live here.
//
// Every request the detached child makes lands on the stub server, so the wire
// is observable even though the hook exited long before it happened.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  TEST_TOKEN,
  assertNoKeyLeak,
  assertSilentSuccess,
  baseEnv,
  configDirOf,
  decision,
  runPromptStart,
  stubServer,
  tmpDir,
  waitFor,
} from './helpers.mjs';

/** A prompt with a phrase in it that must never reach the wire. */
const PROMPT =
  'the nightingale acquisition keeps timing out when the retry budget is exhausted, ' +
  'please look at the exponential backoff in the storage client';
const DISTINCTIVE = 'nightingale acquisition keeps timing out';

/** Run the hook and wait for the detached child to reach the stub, or not. */
async function fire({ payload = {}, env = {}, respond = () => decision(), expectRequest = true } = {}) {
  const home = tmpDir('prmpt-ps-home-');
  const server = await stubServer(respond);
  try {
    const res = await runPromptStart({
      stdin: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-prompt-start',
        prompt: PROMPT,
        ...payload,
      }),
      env: baseEnv({
        HOME: home,
        CLAUDECODE: '1',
        PRMPT_TOKEN: TEST_TOKEN,
        PRMPT_ENDPOINT: server.url,
        PRMPT_NO_AUTO_ENROL: '1',
        ...env,
      }),
    });
    // A test expecting silence should not sit out the whole deadline to prove
    // it: give the detached child a real chance, then stop waiting.
    const request = await waitFor(() => server.requests[0] ?? null, {
      timeout: expectRequest ? 8000 : 750,
    });
    return { res, server, home, request };
  } finally {
    await server.close();
  }
}

// --- the blocking contract --------------------------------------------------

test('it exits 0, silently, and well inside the time a user would notice', async () => {
  const { res } = await fire();
  assertSilentSuccess(res, 'prompt-start');
  assertNoKeyLeak(res, 'prompt-start');
  // The hook must not wait on the network at all. The serve request alone is
  // allowed 15s in the detached child; if any of that were inline it would
  // show up here.
  assert.ok(res.ms < 1000, `prompt-start blocked the user for ${res.ms.toFixed(0)}ms`);
});

test('a malformed payload is not an error, it is silence', async () => {
  const server = await stubServer(() => decision());
  try {
    const res = await runPromptStart({
      stdin: 'not json at all',
      env: baseEnv({ PRMPT_TOKEN: TEST_TOKEN, PRMPT_ENDPOINT: server.url }),
    });
    assertSilentSuccess(res, 'garbage stdin');
  } finally {
    await server.close();
  }
});

// --- the wire ---------------------------------------------------------------

test('it asks for the STATUS_LINE surface with locally derived tokens', async () => {
  const { request } = await fire();
  assert.ok(request, 'the detached child never reached the server');
  const input = request.body.variables.input;
  assert.equal(input.surface, 'STATUS_LINE');
  assert.ok(Array.isArray(input.signalTokens), 'signalTokens must be an array');
  assert.ok(input.signalTokens.length > 0, 'no tokens were derived');
  assert.ok(input.signalTokens.includes('backoff'), `expected a real keyword: ${input.signalTokens}`);
  assert.equal(input.turnText, undefined, 'STATUS_LINE has no turn text and must send none');
});

test('the raw prompt never appears in the request body', async () => {
  // The single most important assertion in this file. README.md promises "Not
  // sent: your prompts"; the status-line surface keeps that promise literally
  // by sending a sorted bag of keywords and never the text.
  const { request } = await fire();
  assert.ok(request, 'the detached child never reached the server');
  const raw = request.raw;
  assert.ok(!raw.includes(PROMPT), 'the whole prompt was transmitted');
  assert.ok(!raw.includes(DISTINCTIVE), `a distinctive phrase was transmitted: ${DISTINCTIVE}`);
  for (const phrase of [
    'nightingale acquisition',
    'timing out',
    'retry budget',
    'exponential backoff',
    'storage client',
  ]) {
    assert.ok(!raw.includes(phrase), `a phrase from the prompt survived: ${phrase}`);
  }
});

test('the request carries only the fields the status-line surface needs', async () => {
  const cwd = tmpDir('prmpt-ps-repo-');
  fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.com/x\n');
  const { request } = await fire({ payload: { cwd } });
  assert.ok(request);
  const input = request.body.variables.input;
  assert.deepEqual(
    Object.keys(input).sort(),
    ['fileTypes', 'harness', 'installId', 'repoLanguage', 'sessionId', 'signalTokens', 'surface'].sort(),
  );
  assert.equal(input.repoLanguage, 'go');
  assert.equal(input.harness, 'claude-code');
});

test('the token travels in the Authorization header and nowhere else', async () => {
  const { server, request } = await fire();
  assert.ok(request);
  assert.equal(server.headers[0].authorization, `Bearer ${TEST_TOKEN}`);
  assert.ok(!request.raw.includes(TEST_TOKEN));
});

// --- the slot ---------------------------------------------------------------

test('a decision is parked in the slot for the status line to find', async () => {
  const { home } = await fire();
  const slot = path.join(configDirOf(home), 'slot.json');
  const found = await waitFor(() => (fs.existsSync(slot) ? slot : null));
  assert.ok(found, 'no slot file was written');
  const parsed = JSON.parse(fs.readFileSync(slot, 'utf8'));
  assert.equal(parsed.requestId, 'req_abc123');
  assert.equal(parsed.headline, 'Ship faster with Widget CI');
  assert.equal(parsed.clickUrl, 'https://ads.example/c/req_abc123');
  assert.equal(parsed.sessionId, 'sess-prompt-start');
  // The filler is what makes this one billable when it renders. Without it the
  // renderer could not tell it from a turn-end ad that was billed already.
  assert.equal(parsed.filler, 'prompt');
  assert.ok(!parsed.impressedAt, 'nothing is billable until it renders');
  assert.equal(fs.statSync(slot).mode & 0o777, 0o600);
});

test('no match leaves whatever was parked alone', async () => {
  const { home, request } = await fire({ respond: () => ({ data: { serveAd: null } }) });
  assert.ok(request, 'the child should still have asked');
  const slot = path.join(configDirOf(home), 'slot.json');
  // Give the child the same grace the positive case gets before concluding.
  const appeared = await waitFor(() => (fs.existsSync(slot) ? slot : null), { timeout: 750 });
  assert.equal(appeared, null, 'a no-match wrote a slot file');
});

// --- the opt-outs -----------------------------------------------------------

test('PRMPT_DISABLED=1 makes no request and writes nothing', async () => {
  const { server, home, res } = await fire({ env: { PRMPT_DISABLED: '1' }, expectRequest: false });
  assertSilentSuccess(res, 'disabled');
  assert.equal(server.requests.length, 0, 'a disabled install still called the backend');
  assert.ok(!fs.existsSync(configDirOf(home)), 'a disabled install created config state');
});

test('an install with no token asks for nothing', async () => {
  const { server, res } = await fire({ env: { PRMPT_TOKEN: undefined }, expectRequest: false });
  assertSilentSuccess(res, 'no token');
  assert.equal(server.requests.length, 0);
});

test('an empty prompt yields no request, because there is no signal', async () => {
  const { server, res } = await fire({ payload: { prompt: 'can you please do it' }, expectRequest: false });
  assertSilentSuccess(res, 'no signal');
  assert.equal(server.requests.length, 0, 'a prompt of pure stopwords was still served');
});

test('a host that is not Claude Code is left alone', async () => {
  // The status line is a Claude Code surface and nothing else has one, so
  // fetching for it anywhere else spends a request on an ad that can never be
  // displayed -- and bills an impression that never happened.
  const { server, res } = await fire({ env: { CLAUDECODE: undefined }, expectRequest: false });
  assertSilentSuccess(res, 'not claude code');
  assert.equal(server.requests.length, 0);
});
