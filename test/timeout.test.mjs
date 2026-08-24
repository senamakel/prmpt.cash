// The most important test in the suite.
//
// On Gemini CLI hooks run synchronously inside the agent loop, so a backend
// that accepts the connection and then never answers would stall the user's
// turn for as long as it felt like. The AbortController deadline is what
// stops that, and it is worth an explicit, timed assertion.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LONG_TURN,
  TEST_TOKEN,
  assertNoKeyLeak,
  assertSilentSuccess,
  baseEnv,
  runHook,
  stubServer,
} from './helpers.mjs';

test('a server that never responds is abandoned well inside 3s', async () => {
  const sockets = [];
  // Accept the request, read it fully, then simply never write a response.
  const server = await stubServer((_body, req) => {
    sockets.push(req.socket);
    return undefined; // handler wrote nothing and res is not ended: hang.
  });

  try {
    const res = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'AfterAgent', prompt_response: LONG_TURN }),
      env: baseEnv({ PRMPT_TOKEN: TEST_TOKEN, PRMPT_ENDPOINT: server.url }),
    });

    assertSilentSuccess(res, 'hanging server');
    assertNoKeyLeak(res, 'hanging server');
    assert.equal(server.requests.length, 1, 'the request should have reached the stub');

    // The hook's deadline is 1500ms; process spawn adds a little on top.
    assert.ok(
      res.ms < 3000,
      `hook took ${res.ms.toFixed(0)}ms; must abandon a hanging backend well under 3000ms`,
    );
    // And it must actually have waited for the deadline rather than bailing
    // early for some unrelated reason -- otherwise this test proves nothing.
    assert.ok(
      res.ms > 1000,
      `hook returned in ${res.ms.toFixed(0)}ms, which is too fast to have hit the 1500ms deadline`,
    );
    console.log(`  [timing] hanging-backend hook run: ${res.ms.toFixed(0)}ms (deadline 1500ms)`);
  } finally {
    for (const s of sockets) s.destroy();
    await server.close();
  }
});

test('PRMPT_TIMEOUT_MS shortens the deadline', async () => {
  const sockets = [];
  const server = await stubServer((_body, req) => {
    sockets.push(req.socket);
    return undefined;
  });
  try {
    const res = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: LONG_TURN }),
      env: baseEnv({
        PRMPT_TOKEN: TEST_TOKEN,
        PRMPT_ENDPOINT: server.url,
        PRMPT_TIMEOUT_MS: '200',
      }),
    });
    assertSilentSuccess(res, 'short deadline');
    assert.ok(res.ms < 1500, `hook took ${res.ms.toFixed(0)}ms with a 200ms deadline`);
    console.log(`  [timing] 200ms-deadline hook run: ${res.ms.toFixed(0)}ms`);
  } finally {
    for (const s of sockets) s.destroy();
    await server.close();
  }
});

test('a slow-but-inside-the-deadline response is still used', async () => {
  const server = await stubServer((_body, _req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          serveAd: {
            requestId: 'r-slow',
            headline: 'Slow but punctual',
            body: '',
            clickUrl: 'https://ads.example/c/r-slow',
          },
        },
      }));
    }, 300);
    return undefined;
  });
  try {
    const res = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: LONG_TURN }),
      env: baseEnv({ PRMPT_TOKEN: TEST_TOKEN, PRMPT_ENDPOINT: server.url }),
    });
    assert.equal(res.code, 0);
    assert.equal(res.stderr, '');
    assert.match(res.stdout, /Slow but punctual/);
  } finally {
    await server.close();
  }
});
