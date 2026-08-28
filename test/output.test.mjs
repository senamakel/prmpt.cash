// Output format and privacy.
//
// When a decision does arrive, exactly one line of JSON goes to stdout and
// nothing at all goes to stderr -- and the request that produced it carries
// only the handful of fields the backend needs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  LONG_TURN,
  TEST_TOKEN,
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

async function hit(over = {}, { payload, env = {} } = {}) {
  const server = await stubServer(() => decision(over));
  try {
    const res = await runHook({
      stdin: JSON.stringify(payload ?? { hook_event_name: 'Stop', last_assistant_message: LONG_TURN }),
      env: baseEnv({ PRMPT_TOKEN: TEST_TOKEN, PRMPT_ENDPOINT: server.url, ...env }),
    });
    assertNoKeyLeak(res, 'decision');
    return { res, server, input: servedInput(server) };
  } finally {
    await server.close();
  }
}

test('stdout is exactly one line of {"systemMessage":...} when it is a pipe', async () => {
  const { res } = await hit();

  assert.equal(res.code, 0);
  assert.equal(res.stderr, '', 'nothing may ever be written to stderr');
  assert.ok(res.stdout.endsWith('\n'));
  const lines = res.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected one line, got ${lines.length}`);

  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(parsed), ['systemMessage']);
  assert.equal(typeof parsed.systemMessage, 'string');
});

test('the message is at most 3 lines and carries the headline and the click URL', async () => {
  const { res } = await hit();
  const { systemMessage } = JSON.parse(res.stdout.trim());
  const lines = systemMessage.split('\n');

  assert.ok(lines.length <= 3, `expected at most 3 lines, got ${lines.length}`);
  assert.match(lines[0], /^Sponsored · /, 'the block must be labelled as sponsored');
  assert.ok(systemMessage.includes('Ship faster with Widget CI'));
  assert.ok(systemMessage.includes('https://ads.example/c/req_abc123'));
  assert.equal(lines.at(-1), 'https://ads.example/c/req_abc123', 'the URL is the last line');
});

test('a decision without a body renders two lines', async () => {
  const { res } = await hit({ body: '' });
  const { systemMessage } = JSON.parse(res.stdout.trim());
  assert.equal(systemMessage.split('\n').length, 2);
});

test('an over-long headline and body are clipped, never wrapped onto extra lines', async () => {
  const { res } = await hit({
    headline: 'A '.repeat(200).trim(),
    body: 'B '.repeat(400).trim(),
  });
  const { systemMessage } = JSON.parse(res.stdout.trim());
  const lines = systemMessage.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].length <= 'Sponsored · '.length + 90, `headline line too long: ${lines[0].length}`);
  assert.ok(lines[1].length <= 140, `body line too long: ${lines[1].length}`);
  assert.ok(lines[0].endsWith('…') && lines[1].endsWith('…'), 'clipped lines are elided');
});

test('a multi-line headline is collapsed so the block never grows', async () => {
  const { res } = await hit({ headline: 'Line one\nline two\n\nline three' });
  const { systemMessage } = JSON.parse(res.stdout.trim());
  assert.equal(systemMessage.split('\n').length, 3);
  assert.ok(systemMessage.includes('Line one line two line three'));
});

test('a missing clickUrl falls back to a URL derived from the endpoint', async () => {
  const server = await stubServer(() => ({
    data: { serveAd: { requestId: 'req_fb', headline: 'Fallback headline', body: '' } },
  }));
  try {
    const res = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: LONG_TURN }),
      env: baseEnv({ PRMPT_TOKEN: TEST_TOKEN, PRMPT_ENDPOINT: server.url }),
    });
    const { systemMessage } = JSON.parse(res.stdout.trim());
    assert.ok(systemMessage.endsWith(`http://127.0.0.1:${server.port}/c/req_fb`));
    assert.equal(res.stderr, '');
  } finally {
    await server.close();
  }
});

test('PRMPT_OUTPUT=text writes the plain block instead of the JSON envelope', async () => {
  const { res } = await hit({}, { env: { PRMPT_OUTPUT: 'text' } });
  assert.equal(res.stderr, '');
  const lines = res.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Sponsored · Ship faster/);
  assert.ok(!res.stdout.includes('systemMessage'));
  // NO_COLOR is set in the base env, so no escape codes either.
  assert.ok(!res.stdout.includes('\x1b['));
});

test('PRMPT_OUTPUT=json forces the envelope', async () => {
  const { res } = await hit({}, { env: { PRMPT_OUTPUT: 'json' } });
  assert.ok(JSON.parse(res.stdout.trim()).systemMessage);
});

// --- privacy ---------------------------------------------------------------

test('the request body carries only the expected fields', async () => {
  const cwd = tmpDir('prmpt-repo-');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(cwd, 'tsconfig.json'), '{}');

  const { server, input } = await hit({}, {
    payload: { hook_event_name: 'Stop', last_assistant_message: LONG_TURN, cwd },
  });

  const body = server.requests[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['query', 'variables']);
  assert.deepEqual(Object.keys(body.variables), ['input']);
  // Deliberately exact, not a subset. A new field on this request is a new
  // thing leaving the user's machine, and it should have to be added here on
  // purpose. `surface` joined the set when the status-line surface landed:
  // the backend now has two places an ad can appear and must be told which.
  assert.deepEqual(
    Object.keys(input).sort(),
    ['fileTypes', 'harness', 'installId', 'repoLanguage', 'sessionId', 'surface', 'turnText'].sort(),
  );
  assert.equal(input.surface, 'TURN_END', 'the end-of-turn hook serves the TURN_END surface');
  assert.equal(input.repoLanguage, 'typescript');
  assert.deepEqual(input.fileTypes, ['.ts', '.tsx']);
});

test('the end-of-turn hook never sends signalTokens', async () => {
  // signalTokens is the status-line surface's substitute for turn text. The
  // end-of-turn hook has the real thing, so sending both would be sending the
  // user's prompt alongside a reply that already matched on its own.
  const { input } = await hit();
  assert.equal(input.signalTokens, undefined);
});

test('the token travels in the Authorization header and nowhere else', async () => {
  const { server, res } = await hit();
  const headers = server.headers[0];
  assert.equal(headers.authorization, `Bearer ${TEST_TOKEN}`);
  assert.ok(!server.requests[0].raw.includes(TEST_TOKEN), 'the token must not be in the body');
  assertNoKeyLeak(res, 'header only');
});

test('no file contents, file paths, env vars or thinking blocks are transmitted', async () => {
  const repo = tmpDir('prmpt-privacy-');
  const SECRET_FILE_CONTENT = 'AWS_SECRET_ACCESS_KEY=hunter2-do-not-transmit';
  const secretFile = path.join(repo, 'secrets.env');
  fs.writeFileSync(secretFile, SECRET_FILE_CONTENT);
  fs.writeFileSync(path.join(repo, 'go.mod'), 'module example.com/x\n');

  const transcript = writeTranscript([
    userEntry('what did you change'),
    assistantEntry([
      { type: 'thinking', thinking: 'PRIVATE_REASONING_TRACE about ' + SECRET_FILE_CONTENT },
      { type: 'text', text: LONG_TURN },
    ]),
  ]);

  const server = await stubServer(() => decision());
  try {
    const res = await runHook({
      stdin: JSON.stringify({
        session_id: 'sess-privacy',
        transcript_path: transcript,
        cwd: repo,
        hook_event_name: 'Stop',
      }),
      env: baseEnv({
        CLAUDECODE: '1',
        PRMPT_TOKEN: TEST_TOKEN,
        PRMPT_ENDPOINT: server.url,
        MY_UNRELATED_SECRET: 'ENV_VAR_VALUE_MUST_NOT_BE_SENT',
      }),
    });
    assert.equal(res.code, 0);
    assert.equal(res.stderr, '');

    const raw = server.requests[0].raw;
    for (const forbidden of [
      SECRET_FILE_CONTENT,
      'PRIVATE_REASONING_TRACE',
      'ENV_VAR_VALUE_MUST_NOT_BE_SENT',
      secretFile,
      transcript,
      repo,
      'secrets.env',
    ]) {
      assert.ok(!raw.includes(forbidden), `request body leaked: ${forbidden}`);
    }
    // The install id is a hash, not anything identifying in the clear.
    const input = servedInput(server);
    assert.match(input.installId, /^[0-9a-f]{32}$/);
    assert.equal(input.repoLanguage, 'go');
  } finally {
    await server.close();
  }
});

test('the same install produces a stable installId across runs', async () => {
  const home = tmpDir('prmpt-stable-');
  const seen = [];
  for (let i = 0; i < 2; i++) {
    const server = await stubServer(() => ({ data: { serveAd: null } }));
    try {
      await runHook({
        stdin: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: LONG_TURN }),
        env: baseEnv({ HOME: home, PRMPT_TOKEN: TEST_TOKEN, PRMPT_ENDPOINT: server.url }),
      });
      seen.push(servedInput(server).installId);
    } finally {
      await server.close();
    }
  }
  assert.equal(seen[0], seen[1]);
});
