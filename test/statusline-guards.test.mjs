// The status-line renderer's non-negotiables.
//
// hooks/statusline.mjs is polled continuously by Claude Code while the model
// works, and whatever it writes to stdout IS the row above somebody's prompt.
// test/statusline.test.mjs covers what it draws; this file covers the four
// promises it must not break while drawing it:
//
//   - it makes NO network call, ever;
//   - it never eats the status line the user already had, however badly that
//     command behaves;
//   - it never hands the terminal an escape sequence the backend wrote;
//   - it bills an impression EXACTLY once per decision, and only for a decision
//     that owes one. See test/statusline-impression.test.mjs for the billing.
//
// Every test runs the real command as a subprocess. The one about the network
// points PRMPT_ENDPOINT at a live stub and then asserts the stub was never
// touched, because "it doesn't call the network" is only worth asserting
// against a network that was there to be called.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  TEST_TOKEN,
  baseEnv,
  configDirOf,
  runStatusLine,
  stubServer,
  tmpDir,
} from './helpers.mjs';

const SESSION = 'sess-status-line';

const AD = {
  requestId: 'req_sl_1',
  headline: 'Quarantine flaky tests automatically',
  body: 'Detects flakes from CI history.',
  clickUrl: 'https://ads.example/c/req_sl_1',
};

/** The payload Claude Code puts on the status-line command's stdin. */
function statusLinePayload(over = {}) {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: '/does/not/exist.jsonl',
    cwd: '/tmp',
    model: { id: 'claude-opus-4-6', display_name: 'Opus' },
    workspace: { current_dir: '/tmp', project_dir: '/tmp' },
    version: '2.1.250',
    output_style: 'default',
    ...over,
  });
}

/** A sandbox HOME with an optional parked slot and an optional chained command. */
function box({ slot = AD, chain } = {}) {
  const home = tmpDir('prmpt-sl-home-');
  const dir = configDirOf(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (slot) {
    fs.writeFileSync(
      path.join(dir, 'slot.json'),
      `${JSON.stringify({ sessionId: SESSION, ts: Date.now(), ...slot })}\n`,
      { mode: 0o600 },
    );
  }
  if (chain) {
    fs.writeFileSync(
      path.join(dir, 'statusline-chain-claude.json'),
      `${JSON.stringify({ type: 'command', command: chain })}\n`,
      { mode: 0o600 },
    );
  }
  return { home, dir };
}

/**
 * A stand-in for the status line the user already had.
 *
 * A node script rather than a shell one-liner so the same test runs on Windows,
 * and it echoes its own stdin so the "the host's payload reaches it" assertion
 * has something to look at.
 */
function priorStatusLine(text, { exitCode = 0, sleepMs = 0 } = {}) {
  const dir = tmpDir('prmpt-prior-');
  const file = path.join(dir, 'prior.mjs');
  fs.writeFileSync(
    file,
    `let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  setTimeout(() => {
    let model = '?';
    try { model = JSON.parse(raw).model.display_name; } catch {}
    process.stdout.write(${JSON.stringify(text)}.replace('{model}', model));
    process.exit(${exitCode});
  }, ${sleepMs});
});
`,
  );
  return `"${process.execPath}" "${file}"`;
}

/** Strip every ANSI/OSC escape, leaving what a human would actually read. */
function visible(s) {
  return s
    .replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '');
}

async function render({ slot = AD, chain, env = {}, payload } = {}) {
  const { home, dir } = box({ slot, chain });
  const res = await runStatusLine({
    stdin: payload ?? statusLinePayload(),
    env: baseEnv({ HOME: home, CLAUDECODE: '1', ...env }),
  });
  return { res, home, dir, out: res.stdout.replace(/\n$/, '') };
}

/** The row our ad is drawn on: the last one, closest to the prompt. */
function adRow(out) {
  const rows = visible(out).split('\n');
  return rows[rows.length - 1];
}

// --- the network ------------------------------------------------------------

test('the status-line command makes no network request at all', async () => {
  const server = await stubServer(() => ({ data: { serveAd: null } }));
  try {
    const { res } = await render({
      env: { PRMPT_TOKEN: TEST_TOKEN, PRMPT_ENDPOINT: server.url },
    });
    assert.equal(res.code, 0);
    assert.equal(
      server.requests.length,
      0,
      `the renderer made ${server.requests.length} request(s); it must make none`,
    );
  } finally {
    await server.close();
  }
});

// --- never eat somebody's status line ---------------------------------------

test("the chained command is handed the host's own payload on stdin", async () => {
  // It has to be: theirs was written against Claude Code's document, and a
  // wrapper that swallowed stdin would break every status line it wrapped.
  const { out } = await render({
    chain: priorStatusLine('model={model}'),
    payload: statusLinePayload({ model: { id: 'x', display_name: 'Haiku' } }),
  });
  assert.ok(
    visible(out).startsWith('model=Haiku'),
    `stdin did not reach the chained command: ${JSON.stringify(out)}`,
  );
});

test('a chained command that fails leaves us printing our own row only', async () => {
  const { res, out } = await render({ chain: priorStatusLine('', { exitCode: 3 }) });
  assert.equal(res.code, 0, 'their failure must not become ours');
  assert.equal(res.stderr, '');
  assert.match(adRow(out), /^Sponsored · /);
});

test('a chained command that hangs does not hang the status line', async () => {
  const { res } = await render({ chain: priorStatusLine('too-slow', { sleepMs: 10_000 }) });
  assert.equal(res.code, 0);
  assert.ok(res.ms < 5000, `the renderer waited ${res.ms.toFixed(0)}ms on a hung command`);
});

test('a chained command that is our own script is refused, never recursed into', async () => {
  // Re-running the installer over an install of its own would otherwise record
  // our command as the thing to chain, and every render would fork forever.
  const { res, out } = await render({
    chain: `"${process.execPath}" "${path.join(process.cwd(), 'hooks', 'statusline.mjs')}"`,
  });
  assert.equal(res.code, 0);
  assert.ok(res.ms < 5000, 'the renderer recursed into itself');
  assert.match(adRow(out), /^Sponsored · /);
});

test('PRMPT_DISABLED=1 shows no ad but keeps the user their status line', async () => {
  const { res, out } = await render({
    chain: priorStatusLine('my-repo (main)'),
    env: { PRMPT_DISABLED: '1' },
  });
  assert.equal(res.code, 0);
  assert.equal(visible(out), 'my-repo (main)', 'disabling prmpt must not touch their line');
  assert.ok(!out.includes('Sponsored'));
});

test('no slot still prints the chained status line untouched', async () => {
  const { res, out } = await render({ slot: null, chain: priorStatusLine('my-repo (main)') });
  assert.equal(res.code, 0);
  assert.equal(visible(out), 'my-repo (main)');
});

// --- the backend is not trusted with the user's terminal --------------------

test('NO_COLOR drops the styling but keeps the link', async () => {
  const { out } = await render({ env: { NO_COLOR: '1' } });
  assert.ok(!/\x1b\[[0-9;]*m/.test(out), `SGR styling survived NO_COLOR: ${JSON.stringify(out)}`);
  // The hyperlink is not colour: it is the only way the user ever gets paid,
  // and dropping it would silently remove the earning path.
  assert.ok(out.includes(`\x1b]8;;${AD.clickUrl}\x1b\\`), 'NO_COLOR removed the link');
});

test('escape sequences in the headline are never handed to the terminal', async () => {
  // The headline is written by a model, server-side, and lands unescaped on the
  // row above somebody's prompt. An escape in it could clear the screen, move
  // the cursor or hide what it just did.
  const { out } = await render({
    slot: { ...AD, headline: 'Buy\x1b[2J\x1b[Hthis\x07 now\r\nsecond line' },
  });
  const afterLabel = out.slice(out.indexOf('Sponsored'));
  assert.ok(!afterLabel.includes('\x1b[2J'), 'a screen-clear reached the terminal');
  assert.ok(!afterLabel.includes('\x07'), 'a bell reached the terminal');
  assert.equal(out.split('\n').length, 1, 'the headline broke the line in two');
});

test('a clickUrl that is not a plain http URL is not made into a link', async () => {
  // The URL sits inside an OSC 8 escape, so a control character in it would
  // close the sequence early and print whatever followed straight to screen.
  const { res, out } = await render({
    slot: { ...AD, clickUrl: 'https://ads.example/c/x\x1b\\\x1b[31mPWNED' },
  });
  assert.equal(res.code, 0);
  assert.ok(!out.includes('PWNED'), 'the injected payload reached the terminal');
  assert.ok(!out.includes('\x1b]8;;'), 'an unsafe URL was still turned into a link');
  assert.match(adRow(out), /^Sponsored · /, 'the ad text itself should still render');
});
