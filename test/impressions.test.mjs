// Reporting the impressions the status line has already drawn.
//
// The renderer bills locally -- it appends a requestId to pending.jsonl and
// returns, because it may not touch the network. Something else has to tell
// the backend, and that something is the next hook to run: turn-end.mjs when
// the turn finishes, or prompt-start.mjs when the next one begins.
//
// Neither of them may wait for it, so the flush happens in the same detached
// child that fetches status-line decisions, and both of those hooks are
// asserted here to have exited long before the request lands.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  LONG_TURN,
  TEST_TOKEN,
  assertSilentSuccess,
  baseEnv,
  configDirOf,
  decision,
  runHook,
  runPromptStart,
  stubServer,
  tmpDir,
  waitFor,
} from './helpers.mjs';

/** A stub that answers both mutations and records which was which. */
async function backend({ accept = true } = {}) {
  const server = await stubServer((body) => {
    const query = body?.query ?? '';
    if (query.includes('confirmImpressions')) {
      if (!accept) return { errors: [{ message: 'nope' }] };
      return { data: { confirmImpressions: body.variables.requestIds.length } };
    }
    return decision();
  });
  server.confirms = () =>
    server.requests.filter((r) => (r.body?.query ?? '').includes('confirmImpressions'));
  return server;
}

/** A HOME with impressions already rendered and awaiting confirmation. */
function homeWithPending(ids) {
  const home = tmpDir('prmpt-imp-home-');
  const dir = configDirOf(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, 'pending.jsonl'),
    ids.map((requestId) => JSON.stringify({ requestId, at: new Date().toISOString() })).join('\n') + '\n',
    { mode: 0o600 },
  );
  return { home, pending: path.join(dir, 'pending.jsonl') };
}

test('the end-of-turn hook reports what the status line rendered', async () => {
  const { home, pending } = homeWithPending(['req_a', 'req_b']);
  const server = await backend();
  try {
    const res = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: LONG_TURN }),
      env: baseEnv({ HOME: home, PRMPT_TOKEN: TEST_TOKEN, PRMPT_ENDPOINT: server.url }),
    });
    assert.equal(res.code, 0);
    assert.equal(res.stderr, '');

    const confirm = await waitFor(() => server.confirms()[0] ?? null);
    assert.ok(confirm, 'the impressions were never reported');
    assert.deepEqual(confirm.body.variables.requestIds, ['req_a', 'req_b']);

    const drained = await waitFor(() => (fs.existsSync(pending) ? null : true));
    assert.ok(drained, 'confirmed impressions were not forgotten');
  } finally {
    await server.close();
  }
});

test('a turn too short to serve still reports what is owed', async () => {
  // The flush must not sit behind the ad path: most turns never reach it.
  const { home } = homeWithPending(['req_short']);
  const server = await backend();
  try {
    const res = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'ok' }),
      env: baseEnv({ HOME: home, PRMPT_TOKEN: TEST_TOKEN, PRMPT_ENDPOINT: server.url }),
    });
    assertSilentSuccess(res, 'short turn');
    const confirm = await waitFor(() => server.confirms()[0] ?? null);
    assert.ok(confirm, 'a short turn skipped the flush');
  } finally {
    await server.close();
  }
});

test('the next prompt reports them too', async () => {
  const { home } = homeWithPending(['req_c']);
  const server = await backend();
  try {
    const res = await runPromptStart({
      stdin: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-flush',
        prompt: 'why is the retry budget exhausted on cold starts',
      }),
      env: baseEnv({
        HOME: home,
        CLAUDECODE: '1',
        PRMPT_TOKEN: TEST_TOKEN,
        PRMPT_ENDPOINT: server.url,
      }),
    });
    assertSilentSuccess(res, 'prompt-start flush');
    const confirm = await waitFor(() => server.confirms()[0] ?? null);
    assert.ok(confirm, 'prompt-start skipped the flush');
    assert.deepEqual(confirm.body.variables.requestIds, ['req_c']);
  } finally {
    await server.close();
  }
});

test('a flush the backend refuses keeps the impressions for next time', async () => {
  // An unreported impression is money owed to the user. It is retried, never
  // dropped because one request failed.
  const { home, pending } = homeWithPending(['req_kept']);
  const server = await backend({ accept: false });
  try {
    await runHook({
      stdin: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: LONG_TURN }),
      env: baseEnv({ HOME: home, PRMPT_TOKEN: TEST_TOKEN, PRMPT_ENDPOINT: server.url }),
    });
    const confirm = await waitFor(() => server.confirms()[0] ?? null);
    assert.ok(confirm, 'nothing was attempted');
    // Give the child time to have wrongly deleted the file before concluding.
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(fs.existsSync(pending), 'a failed flush threw the impressions away');
    assert.match(fs.readFileSync(pending, 'utf8'), /req_kept/);
  } finally {
    await server.close();
  }
});

test('a turn with nothing pending spawns nothing and reports nothing', async () => {
  // This is every turn on almost every install, so it must cost a stat and no
  // more -- certainly not a process.
  const home = tmpDir('prmpt-imp-empty-');
  const server = await backend();
  try {
    await runHook({
      stdin: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: LONG_TURN }),
      env: baseEnv({ HOME: home, PRMPT_TOKEN: TEST_TOKEN, PRMPT_ENDPOINT: server.url }),
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(server.confirms().length, 0, 'an empty pending log still called the backend');
  } finally {
    await server.close();
  }
});
