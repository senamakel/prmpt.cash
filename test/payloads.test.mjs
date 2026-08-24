// Payload shapes: every host hands the hook the turn differently, and each
// shape must yield the right turn text and the right harness attribution.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  LONG_TURN,
  TEST_API_KEY,
  assertNoKeyLeak,
  assistantEntry,
  baseEnv,
  decision,
  runHook,
  servedInput,
  stubServer,
  tmpDir,
  userEntry,
  writeTranscript,
} from './helpers.mjs';

/**
 * Run the hook against a stub that always returns a decision, and hand back
 * the request body it received. `env` is merged over a scrubbed base env, so
 * CLAUDECODE / CURSOR_* from the surrounding session cannot skew detection.
 */
async function serve({ payload, argv = false, env = {} } = {}) {
  const server = await stubServer(() => decision());
  try {
    const res = await runHook({
      args: argv ? [JSON.stringify(payload)] : [],
      stdin: argv ? '' : JSON.stringify(payload),
      env: baseEnv({
        ADENGINE_API_KEY: TEST_API_KEY,
        ADENGINE_ENDPOINT: server.url,
        ...env,
      }),
    });
    assertNoKeyLeak(res, 'serve');
    return { res, input: servedInput(server), server };
  } finally {
    await server.close();
  }
}

test('Claude Code: several assistant lines in one turn are joined in order', async () => {
  const transcript = writeTranscript([
    userEntry('please refactor the retry loop'),
    assistantEntry('First I read the storage client and found the retry loop.'),
    assistantEntry('Then I switched it to exponential backoff on a transient 503.'),
    assistantEntry('Finally I added a regression test covering the backoff schedule.'),
  ]);
  const { res, input } = await serve({
    payload: {
      session_id: 'sess-claude-1',
      transcript_path: transcript,
      cwd: process.cwd(),
      hook_event_name: 'Stop',
    },
    env: { CLAUDECODE: '1' },
  });

  assert.equal(res.code, 0);
  assert.equal(input.harness, 'claude-code');
  assert.equal(input.sessionId, 'sess-claude-1');
  assert.match(input.turnText, /^First I read/);
  assert.match(input.turnText, /Finally I added a regression test/);
  // Order preserved: the walk collects backwards then reverses.
  assert.ok(input.turnText.indexOf('First I read') < input.turnText.indexOf('Then I switched'));
});

test('Claude Code: a thinking block is never transmitted', async () => {
  const SECRET_THOUGHT = 'THINKING_BLOCK_MUST_NOT_BE_SENT_upstream_creds_are_in_vault';
  const transcript = writeTranscript([
    userEntry('fix the flaky test'),
    assistantEntry([
      { type: 'thinking', thinking: SECRET_THOUGHT },
      { type: 'text', text: LONG_TURN },
    ]),
  ]);
  const { input } = await serve({
    payload: { session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' },
    env: { CLAUDECODE: '1' },
  });

  assert.equal(input.turnText, LONG_TURN);
  assert.ok(!JSON.stringify(input).includes('THINKING_BLOCK'));
});

test('Claude Code: the backwards walk stops at the previous user message', async () => {
  const transcript = writeTranscript([
    userEntry('first question'),
    assistantEntry('PREVIOUS TURN TEXT that belongs to an earlier exchange entirely.'),
    userEntry('second question'),
    assistantEntry(LONG_TURN),
  ]);
  const { input } = await serve({
    payload: { session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' },
    env: { CLAUDECODE: '1' },
  });

  assert.equal(input.turnText, LONG_TURN);
  assert.ok(!input.turnText.includes('PREVIOUS TURN TEXT'));
});

test('Claude Code: a transcript ending in a tool result still finds the turn text', async () => {
  // A tool result is recorded as a `user` entry, which is also the walk's stop
  // condition -- so a trailing one must not swallow the whole turn.
  const transcript = writeTranscript([
    userEntry('run the tests'),
    assistantEntry(LONG_TURN),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  ]);
  const { res, input, server } = await serve({
    payload: { session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' },
    env: { CLAUDECODE: '1' },
  });

  assert.equal(res.code, 0);
  // Documented behaviour: the walk stops at the trailing user/tool entry, so
  // no assistant text is gathered and the hook stays silent rather than
  // sending a previous turn's text.
  assert.equal(input, undefined, 'no request should be made when the walk finds no text');
  assert.equal(server.requests.length, 0);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
});

test('Claude Code: version and model ride along as harnessVersion and model', async () => {
  const transcript = writeTranscript([
    userEntry('q'),
    assistantEntry(LONG_TURN, { version: '2.3.4', model: 'claude-sonnet-4-5' }),
  ]);
  const { input } = await serve({
    payload: { session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' },
    env: { CLAUDECODE: '1' },
  });

  assert.equal(input.harnessVersion, '2.3.4');
  assert.equal(input.model, 'claude-sonnet-4-5');
});

test('Codex Stop: last_assistant_message on stdin, harness codex', async () => {
  const { res, input } = await serve({
    payload: { hook_event_name: 'Stop', last_assistant_message: LONG_TURN },
    // CLAUDECODE deliberately absent: it is the only thing separating Claude
    // Code from Codex, since both name the event `Stop`.
    env: {},
  });

  assert.equal(res.code, 0);
  assert.equal(input.harness, 'codex');
  assert.equal(input.turnText, LONG_TURN);
});

test('Codex notify: agent-turn-complete as a single JSON argv', async () => {
  const { res, input } = await serve({
    payload: {
      type: 'agent-turn-complete',
      'last-assistant-message': LONG_TURN,
      'thread-id': 'thread-xyz',
    },
    argv: true,
  });

  assert.equal(res.code, 0);
  assert.equal(input.harness, 'codex');
  assert.equal(input.turnText, LONG_TURN);
  assert.equal(input.sessionId, 'thread-xyz');
});

test('Codex notify: a non-turn notify type is ignored entirely', async () => {
  const server = await stubServer(() => decision());
  try {
    const res = await runHook({
      args: [JSON.stringify({ type: 'agent-something-else', 'last-assistant-message': LONG_TURN })],
      env: baseEnv({ ADENGINE_API_KEY: TEST_API_KEY, ADENGINE_ENDPOINT: server.url }),
    });
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '');
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('Gemini CLI: AfterAgent with prompt_response', async () => {
  const { res, input } = await serve({
    payload: { hook_event_name: 'AfterAgent', prompt_response: LONG_TURN },
  });

  assert.equal(res.code, 0);
  assert.equal(input.harness, 'gemini-cli');
  assert.equal(input.turnText, LONG_TURN);
});

test('Cursor: afterAgentResponse with text', async () => {
  const { res, input } = await serve({
    payload: { hook_event_name: 'afterAgentResponse', text: LONG_TURN },
    // Cursor is detected from its own env vars; the event name alone is not
    // recognised by detectHarness (see the findings note in the report).
    env: { CURSOR_TRACE_ID: 'trace-1' },
  });

  assert.equal(res.code, 0);
  assert.equal(input.harness, 'cursor');
  assert.equal(input.turnText, LONG_TURN);
});

test('payloads without a transcript omit harnessVersion and model rather than sending empty strings', async () => {
  for (const payload of [
    { hook_event_name: 'Stop', last_assistant_message: LONG_TURN },
    { hook_event_name: 'AfterAgent', prompt_response: LONG_TURN },
  ]) {
    const { input, server } = await serve({ payload });
    assert.ok(!('harnessVersion' in input), 'harnessVersion should be absent');
    assert.ok(!('model' in input), 'model should be absent');
    // JSON.stringify drops the undefined values entirely, so they are not on
    // the wire either.
    assert.ok(!server.requests[0].raw.includes('harnessVersion'));
    assert.ok(!server.requests[0].raw.includes('"model"'));
  }
});

test('ADENGINE_HARNESS overrides detection', async () => {
  const { input } = await serve({
    payload: { hook_event_name: 'Stop', last_assistant_message: LONG_TURN },
    env: { CLAUDECODE: '1', ADENGINE_HARNESS: 'my-custom-agent' },
  });
  assert.equal(input.harness, 'my-custom-agent');
});

test('a turn longer than the 4000 char ceiling is clipped to its tail', async () => {
  const head = 'HEAD_MARKER ';
  const tail = ' TAIL_MARKER';
  const big = head + 'x'.repeat(5000) + tail;
  const { input } = await serve({
    payload: { hook_event_name: 'Stop', last_assistant_message: big },
  });
  assert.equal(input.turnText.length, 4000);
  assert.ok(input.turnText.endsWith(tail));
  assert.ok(!input.turnText.includes('HEAD_MARKER'));
});

test('a huge transcript is read from its tail without stalling', async () => {
  const dir = tmpDir('adengine-big-');
  const file = path.join(dir, 'big.jsonl');
  const filler = Array.from({ length: 4000 }, (_, i) =>
    JSON.stringify(assistantEntry(`old line ${i} ` + 'y'.repeat(200))),
  ).join('\n');
  fs.writeFileSync(file, filler + '\n' + JSON.stringify(userEntry('go')) + '\n' +
    JSON.stringify(assistantEntry(LONG_TURN)) + '\n');
  assert.ok(fs.statSync(file).size > 512 * 1024, 'fixture must exceed the tail window');

  const { res, input } = await serve({
    payload: { session_id: 's', transcript_path: file, hook_event_name: 'Stop' },
    env: { CLAUDECODE: '1' },
  });
  assert.equal(res.code, 0);
  assert.equal(input.turnText, LONG_TURN);
});
