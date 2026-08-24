// Fail-open: the governing contract. Anything that is not "a real decision
// arrived inside the deadline" must end in exit 0 with EMPTY stdout and
// stderr, so the hook is indistinguishable from not being installed.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  LONG_TURN,
  TEST_API_KEY,
  assertNoKeyLeak,
  assertSilentSuccess,
  baseEnv,
  runHook,
  stubServer,
  tmpDir,
} from './helpers.mjs';

const CLAUDE_STOP = { hook_event_name: 'Stop', last_assistant_message: LONG_TURN };

/** Run the hook against a stub with the given response behaviour. */
async function against(handler, { payload = CLAUDE_STOP, env = {} } = {}) {
  const server = await stubServer(handler);
  try {
    const res = await runHook({
      stdin: JSON.stringify(payload),
      env: baseEnv({ ADENGINE_API_KEY: TEST_API_KEY, ADENGINE_ENDPOINT: server.url, ...env }),
    });
    return { res, server };
  } finally {
    await server.close();
  }
}

test('no API key configured: silent, and no request is attempted', async () => {
  const server = await stubServer(() => ({ data: { serveAd: null } }));
  try {
    const res = await runHook({
      stdin: JSON.stringify(CLAUDE_STOP),
      env: baseEnv({ ADENGINE_ENDPOINT: server.url }),
    });
    assertSilentSuccess(res, 'no api key');
    assert.equal(server.requests.length, 0, 'must not call the backend without a key');
  } finally {
    await server.close();
  }
});

test('ADENGINE_DISABLED=1: silent, and no request is attempted', async () => {
  const server = await stubServer(() => ({ data: { serveAd: null } }));
  try {
    const res = await runHook({
      stdin: JSON.stringify(CLAUDE_STOP),
      env: baseEnv({
        ADENGINE_API_KEY: TEST_API_KEY,
        ADENGINE_ENDPOINT: server.url,
        ADENGINE_DISABLED: '1',
      }),
    });
    assertSilentSuccess(res, 'disabled');
    assertNoKeyLeak(res, 'disabled');
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('connection refused', async () => {
  // Bind then immediately release a port so nothing is listening on it.
  const server = await stubServer(() => ({}));
  const { port } = server;
  await server.close();

  const res = await runHook({
    stdin: JSON.stringify(CLAUDE_STOP),
    env: baseEnv({
      ADENGINE_API_KEY: TEST_API_KEY,
      ADENGINE_ENDPOINT: `http://127.0.0.1:${port}/graphql`,
    }),
  });
  assertSilentSuccess(res, 'connection refused');
  assertNoKeyLeak(res, 'connection refused');
});

test('HTTP 500', async () => {
  const { res } = await against((_body, _req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
  });
  assertSilentSuccess(res, 'http 500');
  assertNoKeyLeak(res, 'http 500');
});

test('HTTP 401 (a revoked key) is as quiet as everything else', async () => {
  const { res } = await against((_body, _req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"unauthorized"}');
  });
  assertSilentSuccess(res, 'http 401');
  assertNoKeyLeak(res, 'http 401');
});

test('malformed JSON body', async () => {
  const { res } = await against((_body, _req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('<html>this is not json at all');
  });
  assertSilentSuccess(res, 'malformed json');
});

test('a GraphQL errors response', async () => {
  const { res } = await against(() => ({
    data: null,
    errors: [{ message: 'rate limited' }],
  }));
  assertSilentSuccess(res, 'graphql errors');
});

test('serveAd: null (no campaign matched)', async () => {
  const { res } = await against(() => ({ data: { serveAd: null } }));
  assertSilentSuccess(res, 'no fill');
});

test('a decision missing headline', async () => {
  const { res } = await against(() => ({
    data: { serveAd: { requestId: 'r1', body: 'b', clickUrl: 'https://x/c/r1' } },
  }));
  assertSilentSuccess(res, 'missing headline');
});

test('a decision missing requestId', async () => {
  const { res } = await against(() => ({
    data: { serveAd: { headline: 'Buy this', body: 'b', clickUrl: 'https://x/c/r1' } },
  }));
  assertSilentSuccess(res, 'missing requestId');
});

test('a decision with a blank headline', async () => {
  const { res } = await against(() => ({
    data: { serveAd: { requestId: 'r1', headline: '   ', clickUrl: 'https://x/c/r1' } },
  }));
  assertSilentSuccess(res, 'blank headline');
});

test('an empty 200 body', async () => {
  const { res } = await against((_body, _req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('');
  });
  assertSilentSuccess(res, 'empty body');
});

test('the server hangs up mid-response', async () => {
  const { res } = await against((_body, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '999' });
    res.write('{"data":');
    req.socket.destroy();
  });
  assertSilentSuccess(res, 'truncated response');
});

for (const [label, stdin] of [
  ['garbage on stdin', 'this is not json {{{'],
  ['an empty object on stdin', '{}'],
  ['empty stdin', ''],
  ['whitespace-only stdin', '   \n  '],
  ['a JSON array on stdin', '[1,2,3]'],
  ['a JSON string on stdin', '"just a string"'],
  ['JSON null on stdin', 'null'],
]) {
  test(`${label}: silent`, async () => {
    const server = await stubServer(() => ({ data: { serveAd: null } }));
    try {
      const res = await runHook({
        stdin,
        env: baseEnv({ ADENGINE_API_KEY: TEST_API_KEY, ADENGINE_ENDPOINT: server.url }),
      });
      assertSilentSuccess(res, label);
      assertNoKeyLeak(res, label);
      assert.equal(server.requests.length, 0, `${label}: must not call the backend`);
    } finally {
      await server.close();
    }
  });
}

test('a transcript_path that does not exist', async () => {
  const missing = path.join(tmpDir('adengine-missing-'), 'nope', 'transcript.jsonl');
  const { res, server } = await against(() => ({ data: { serveAd: null } }), {
    payload: { session_id: 's', transcript_path: missing, hook_event_name: 'Stop' },
    env: { CLAUDECODE: '1' },
  });
  assertSilentSuccess(res, 'missing transcript');
  assert.equal(server.requests.length, 0);
});

test('a turn under the 80 character minimum', async () => {
  const { res, server } = await against(() => ({ data: { serveAd: null } }), {
    payload: { hook_event_name: 'Stop', last_assistant_message: 'Done.' },
  });
  assertSilentSuccess(res, 'short turn');
  assert.equal(server.requests.length, 0, 'a short turn carries no signal; do not spend a request');
});

test('a turn exactly one character under the minimum is not sent', async () => {
  const { server } = await against(() => ({ data: { serveAd: null } }), {
    payload: { hook_event_name: 'Stop', last_assistant_message: 'a'.repeat(79) },
  });
  assert.equal(server.requests.length, 0);
});

test('a turn exactly at the minimum is sent', async () => {
  const { server } = await against(() => ({ data: { serveAd: null } }), {
    payload: { hook_event_name: 'Stop', last_assistant_message: 'a'.repeat(80) },
  });
  assert.equal(server.requests.length, 1);
});

test('an unreadable config.json does not break the hook', async () => {
  const home = tmpDir('adengine-badcfg-');
  const cfgDir = path.join(home, '.config', 'adengine');
  const fs = await import('node:fs');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), 'not json');

  const server = await stubServer(() => ({ data: { serveAd: null } }));
  try {
    const res = await runHook({
      stdin: JSON.stringify(CLAUDE_STOP),
      env: baseEnv({ HOME: home, ADENGINE_API_KEY: TEST_API_KEY, ADENGINE_ENDPOINT: server.url }),
    });
    assertSilentSuccess(res, 'corrupt config');
  } finally {
    await server.close();
  }
});
