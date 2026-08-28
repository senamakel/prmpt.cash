// The status-line command: the render half of the status-line surface.
//
// Claude Code polls this continuously while the model works and watches it for
// slowness, so the contract is stricter than any other file in the plugin:
//
//   - it makes NO network call, ever;
//   - it reads one small file and prints one line;
//   - it bills the impression exactly once per decision, however many times it
//     is asked to draw it;
//   - and it never, ever eats the status line the user already had.
//
// Every test here runs the real command as a subprocess. The ones about the
// network point PRMPT_ENDPOINT at a live stub and then assert the stub was
// never touched, because "it doesn't call the network" is only worth asserting
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

/** A sandbox HOME with an optional parked slot and an optional wrapped command. */
function box({ slot = AD, wrapped } = {}) {
  const home = tmpDir('prmpt-sl-home-');
  const dir = configDirOf(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (slot) {
    fs.writeFileSync(
      path.join(dir, `slot-${SESSION}.json`),
      `${JSON.stringify({ ...slot, createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
  }
  if (wrapped) {
    fs.writeFileSync(path.join(dir, 'statusline.json'), `${JSON.stringify({ wrapped })}\n`, {
      mode: 0o600,
    });
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

async function render({ slot = AD, wrapped, env = {}, payload } = {}) {
  const { home, dir } = box({ slot, wrapped });
  const res = await runStatusLine({
    stdin: payload ?? statusLinePayload(),
    env: baseEnv({ HOME: home, CLAUDECODE: '1', ...env }),
  });
  return { res, home, dir, line: res.stdout.replace(/\n$/, '') };
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

// --- the line ---------------------------------------------------------------

test('it emits exactly one line, on stdout, with nothing on stderr', async () => {
  const { res } = await render();
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '', `stderr must stay empty, got ${JSON.stringify(res.stderr)}`);
  assert.equal(res.stdout.split('\n').filter(Boolean).length, 1);
});

test('the line is labelled as sponsored and carries the headline', async () => {
  const { line } = await render();
  const text = visible(line);
  assert.match(text, /Sponsored/, 'the line must be labelled');
  assert.ok(text.includes('Quarantine flaky tests'), `headline missing from: ${text}`);
});

test('the ad segment never exceeds 60 characters', async () => {
  const { line } = await render({
    slot: { ...AD, headline: 'A headline of quite unreasonable length '.repeat(10).trim() },
  });
  const text = visible(line);
  assert.ok(text.length <= 60, `the ad segment rendered ${text.length} characters: ${text}`);
  assert.ok(text.endsWith('…'), 'a clipped segment must say so');
});

test('the click URL is a hyperlink, not extra text on the line', async () => {
  const { line } = await render({ env: { NO_COLOR: undefined } });
  // OSC 8: ESC ] 8 ; ; URL ESC \  TEXT  ESC ] 8 ; ; ESC \
  assert.ok(line.includes(`\x1b]8;;${AD.clickUrl}\x1b\\`), `no OSC 8 open in: ${JSON.stringify(line)}`);
  assert.ok(line.endsWith('\x1b]8;;\x1b\\'), `no OSC 8 close in: ${JSON.stringify(line)}`);
  // The URL must not also be printed as visible text; the line has no room and
  // a terminal without OSC 8 support would then show it twice.
  assert.ok(!visible(line).includes(AD.clickUrl), 'the URL was printed as text as well');
});

test('NO_COLOR drops the styling but keeps the link', async () => {
  const { line } = await render({ env: { NO_COLOR: '1' } });
  assert.ok(!/\x1b\[[0-9;]*m/.test(line), `SGR styling survived NO_COLOR: ${JSON.stringify(line)}`);
  // The hyperlink is not colour: it is the only way the user ever gets paid,
  // and dropping it would silently remove the earning path.
  assert.ok(line.includes(`\x1b]8;;${AD.clickUrl}\x1b\\`), 'NO_COLOR removed the link');
});

// --- chaining ---------------------------------------------------------------

test("a pre-existing status line's output is preserved as a prefix", async () => {
  const { line } = await render({ wrapped: priorStatusLine('my-repo (main) {model}') });
  const text = visible(line);
  assert.ok(text.startsWith('my-repo (main) Opus'), `the prior line was not the prefix: ${text}`);
  assert.ok(text.includes('Sponsored'), 'our segment was dropped');
});

test("the wrapped command is handed the host's own payload on stdin", async () => {
  // It has to be: theirs was written against Claude Code's document, and a
  // wrapper that swallowed stdin would break every status line it wrapped.
  const { line } = await render({
    wrapped: priorStatusLine('model={model}'),
    payload: statusLinePayload({ model: { id: 'x', display_name: 'Haiku' } }),
  });
  assert.ok(visible(line).startsWith('model=Haiku'), `stdin did not reach the wrapped command: ${line}`);
});

test('a wrapped command that fails leaves us printing our own segment only', async () => {
  const { res, line } = await render({
    wrapped: priorStatusLine('', { exitCode: 3 }),
  });
  assert.equal(res.code, 0, 'their failure must not become ours');
  assert.equal(res.stderr, '');
  assert.ok(visible(line).includes('Sponsored'));
});

test('a wrapped command that hangs does not hang the status line', async () => {
  const { res } = await render({
    wrapped: priorStatusLine('too-slow', { sleepMs: 10_000 }),
    env: { PRMPT_STATUSLINE_WRAP_MS: '300' },
  });
  assert.equal(res.code, 0);
  assert.ok(res.ms < 5000, `the renderer waited ${res.ms.toFixed(0)}ms on a hung command`);
});

test('a wrapped command that is our own script is refused, never recursed into', async () => {
  // Re-running the installer over an install of its own would otherwise record
  // our command as the thing to wrap, and every render would fork forever.
  const { res, line } = await render({
    wrapped: `"${process.execPath}" "${path.join(process.cwd(), 'hooks', 'status-line.mjs')}"`,
  });
  assert.equal(res.code, 0);
  assert.ok(res.ms < 5000, 'the renderer recursed into itself');
  assert.ok(visible(line).includes('Sponsored'));
});

// --- when there is nothing to show ------------------------------------------

test('no slot and no wrapped command prints nothing at all', async () => {
  const { res } = await render({ slot: null });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
});

test('no slot still prints the wrapped status line untouched', async () => {
  const { res, line } = await render({ slot: null, wrapped: priorStatusLine('my-repo (main)') });
  assert.equal(res.code, 0);
  assert.equal(visible(line), 'my-repo (main)');
});

test('a stale slot is not rendered', async () => {
  const { home, dir } = box({ slot: AD });
  const file = path.join(dir, `slot-${SESSION}.json`);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  const res = await runStatusLine({
    stdin: statusLinePayload(),
    env: baseEnv({ HOME: home, CLAUDECODE: '1' }),
  });
  assert.equal(res.stdout, '', 'an hour-old decision was still drawn');
});

test('PRMPT_DISABLED=1 shows no ad but keeps the user their status line', async () => {
  const { res, line } = await render({
    wrapped: priorStatusLine('my-repo (main)'),
    env: { PRMPT_DISABLED: '1' },
  });
  assert.equal(res.code, 0);
  assert.equal(visible(line), 'my-repo (main)', 'disabling prmpt must not touch their line');
  assert.ok(!line.includes('Sponsored'));
});

test('a slot for a different session is not rendered', async () => {
  const { res } = await render({ payload: statusLinePayload({ session_id: 'some-other-session' }) });
  assert.equal(res.stdout, '');
});

// --- the impression ---------------------------------------------------------

test('an impression marker is written once per requestId, never twice', async () => {
  const { home, dir } = box({ slot: AD });
  const pending = path.join(dir, 'pending.jsonl');

  for (let i = 0; i < 5; i++) {
    const res = await runStatusLine({
      stdin: statusLinePayload(),
      env: baseEnv({ HOME: home, CLAUDECODE: '1' }),
    });
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('Sponsored'), `render ${i} drew nothing`);
  }

  const lines = fs.readFileSync(pending, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `five renders billed ${lines.length} impressions`);
  assert.equal(JSON.parse(lines[0]).requestId, AD.requestId);
});

test('nothing is billed for a decision that was never drawn', async () => {
  const { dir } = await render({ slot: null });
  assert.ok(!fs.existsSync(path.join(dir, 'pending.jsonl')), 'an unrendered slot was billed');
});

test('nothing is billed while prmpt is disabled', async () => {
  const { dir } = await render({ env: { PRMPT_DISABLED: '1' } });
  assert.ok(!fs.existsSync(path.join(dir, 'pending.jsonl')));
});

test('a terminal too narrow for the ad gets the status line and no bill', async () => {
  const { res, line, dir } = await render({
    wrapped: priorStatusLine('a-really-quite-long-directory-name (feature/branch) Opus | 41% left'),
    env: { COLUMNS: '70' },
  });
  assert.equal(res.code, 0);
  assert.ok(!visible(line).includes('Sponsored'), 'the ad was squeezed in anyway');
  assert.ok(visible(line).startsWith('a-really-quite-long-directory-name'));
  assert.ok(!fs.existsSync(path.join(dir, 'pending.jsonl')), 'an ad that did not fit was billed');
});

test('the whole line respects COLUMNS when the ad does fit', async () => {
  const { line } = await render({
    wrapped: priorStatusLine('repo (main)'),
    env: { COLUMNS: '60' },
  });
  const text = visible(line);
  assert.ok(text.length <= 60, `line is ${text.length} chars, over COLUMNS=60: ${text}`);
  assert.ok(text.includes('Sponsored'));
});
