// The status-line surface: the slot the turn hook parks, the renderer the host
// calls on every redraw, and the config edits that wire the two together.
//
// The renderer runs as a real child process against a real HOME, because the
// contract that matters is "what ends up on stdout" -- that string is literally
// the row above the user's prompt.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  PLUGIN_DIR,
  TEST_TOKEN,
  LONG_TURN,
  baseEnv,
  tmpDir,
  stubServer,
  decision,
  run,
} from './helpers.mjs';

const STATUSLINE = path.join(PLUGIN_DIR, 'hooks', 'statusline.mjs');

/** What a human actually sees: the row with OSC 8 and SGR escapes stripped. */
function visible(s) {
  return s
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '');
}
const TURN_END = path.join(PLUGIN_DIR, 'hooks', 'turn-end.mjs');
const CLI = path.join(PLUGIN_DIR, 'bin', 'prmpt.mjs');

/** Write a config.json into a fresh HOME the way the installer would. */
function seedConfig(home, over = {}) {
  const dir = path.join(home, '.config', 'prmpt');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ token: TEST_TOKEN, installId: 'inst_test', ...over }),
    { mode: 0o600 },
  );
  return dir;
}

function slotFile(home) {
  return path.join(home, '.config', 'prmpt', 'slot.json');
}

// --- the slot ---------------------------------------------------------------

test('a served ad is parked for the status line', async () => {
  const home = tmpDir('prmpt-home-');
  seedConfig(home);
  const server = await stubServer(() => decision());

  const res = await run(TURN_END, {
    env: baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url, CLAUDECODE: '1' }),
    stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', last_assistant_message: LONG_TURN }),
  });
  await server.close();

  assert.equal(res.code, 0);
  const slot = JSON.parse(fs.readFileSync(slotFile(home), 'utf8'));
  assert.equal(slot.headline, 'Ship faster with Widget CI');
  assert.equal(slot.clickUrl, 'https://ads.example/c/req_abc123');
  assert.equal(slot.sessionId, 'sess-1');
  assert.equal(typeof slot.ts, 'number');
});

test('the slot is written 0600 -- it holds a click URL tied to this install', async () => {
  const home = tmpDir('prmpt-home-');
  seedConfig(home);
  const server = await stubServer(() => decision());
  await run(TURN_END, {
    env: baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url, CLAUDECODE: '1' }),
    stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 's', last_assistant_message: LONG_TURN }),
  });
  await server.close();
  assert.equal(fs.statSync(slotFile(home)).mode & 0o777, 0o600);
});

test('no match parks nothing', async () => {
  const home = tmpDir('prmpt-home-');
  seedConfig(home);
  const server = await stubServer(() => ({ data: { serveAd: null } }));
  await run(TURN_END, {
    env: baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url, CLAUDECODE: '1' }),
    stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 's', last_assistant_message: LONG_TURN }),
  });
  await server.close();
  assert.equal(fs.existsSync(slotFile(home)), false);
});

// --- the renderer -----------------------------------------------------------

/** Park a slot directly, so renderer tests don't need the whole turn path. */
function park(home, over = {}) {
  const dir = seedConfig(home);
  fs.writeFileSync(path.join(dir, 'slot.json'), JSON.stringify({
    requestId: 'req_abc123',
    headline: 'Ship faster with Widget CI',
    body: 'Parallel test sharding for Node monorepos.',
    clickUrl: 'https://ads.example/c/req_abc123',
    sessionId: 'sess-1',
    ts: Date.now(),
    ...over,
  }), { mode: 0o600 });
}

test('renders one labelled line and nothing else', async () => {
  const home = tmpDir('prmpt-home-');
  park(home);
  const res = await run(STATUSLINE, {
    env: baseEnv({ HOME: home }),
    stdin: JSON.stringify({ session_id: 'sess-1' }),
  });
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
  const lines = visible(res.stdout).trimEnd().split('\n');
  assert.equal(lines.length, 1, 'the status line is permanent -- one row only');
  assert.match(lines[0], /^Sponsored · /);
  assert.match(lines[0], /Widget CI/);
});

test('the line is wrapped in an OSC 8 hyperlink rather than printing the URL', async () => {
  const home = tmpDir('prmpt-home-');
  park(home);
  const res = await run(STATUSLINE, {
    // NO_COLOR is set by baseEnv; the hyperlink is not colour and must survive it.
    env: baseEnv({ HOME: home }),
    stdin: '{}',
  });
  assert.match(res.stdout, /\x1b\]8;;https:\/\/ads\.example\/c\/req_abc123\x1b\\/);
  assert.ok(
    !visible(res.stdout).includes('https://'),
    'the raw URL must not appear as visible text on a permanent row',
  );
});

test('it never wraps: the visible line fits the terminal width', async () => {
  const home = tmpDir('prmpt-home-');
  park(home, {
    headline: 'A headline that is quite considerably longer than any sensible terminal row would ever be',
    body: 'And a body that is also very long indeed, going on and on well past the point of usefulness.',
  });
  for (const cols of ['40', '60', '80', '120']) {
    const res = await run(STATUSLINE, {
      env: baseEnv({ HOME: home, COLUMNS: cols }),
      stdin: '{}',
    });
    const row = visible(res.stdout).trimEnd();
    assert.ok(row.length <= Number(cols), `${row.length} > ${cols}: "${row}"`);
  }
});

test('an expired slot renders nothing', async () => {
  const home = tmpDir('prmpt-home-');
  park(home, { ts: Date.now() - 60 * 60 * 1000 });
  const res = await run(STATUSLINE, { env: baseEnv({ HOME: home }), stdin: '{}' });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, '');
});

test('a slot from another session is not shown', async () => {
  const home = tmpDir('prmpt-home-');
  park(home, { sessionId: 'sess-elsewhere' });
  const res = await run(STATUSLINE, {
    env: baseEnv({ HOME: home }),
    stdin: JSON.stringify({ session_id: 'sess-here' }),
  });
  assert.equal(res.stdout, '');
});

test('no slot at all is silent, not an error', async () => {
  const home = tmpDir('prmpt-home-');
  seedConfig(home);
  const res = await run(STATUSLINE, { env: baseEnv({ HOME: home }), stdin: '{}' });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
});

test('a corrupt slot is silent, not an error', async () => {
  const home = tmpDir('prmpt-home-');
  const dir = seedConfig(home);
  fs.writeFileSync(path.join(dir, 'slot.json'), 'not json at all {');
  const res = await run(STATUSLINE, { env: baseEnv({ HOME: home }), stdin: '{}' });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
});

test('PRMPT_DISABLED=1 shows no ad', async () => {
  const home = tmpDir('prmpt-home-');
  park(home);
  const res = await run(STATUSLINE, {
    env: baseEnv({ HOME: home, PRMPT_DISABLED: '1' }),
    stdin: '{}',
  });
  assert.equal(res.stdout, '');
});

// --- chaining ---------------------------------------------------------------

test("a pre-existing status line is kept, and ours sits beneath it", async () => {
  const home = tmpDir('prmpt-home-');
  park(home);
  const chain = path.join(home, 'mine.sh');
  fs.writeFileSync(chain, '#!/bin/sh\necho "my own status line"\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(home, '.config', 'prmpt', 'statusline-chain-claude.json'),
    JSON.stringify({ command: `sh ${chain}` }),
  );

  const res = await run(STATUSLINE, {
    env: baseEnv({ HOME: home, CLAUDECODE: '1' }),
    stdin: '{}',
  });
  const lines = visible(res.stdout).trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'my own status line');
  assert.match(lines[1], /^Sponsored · /);
});

test('a broken chained command does not take our line down with it', async () => {
  const home = tmpDir('prmpt-home-');
  park(home);
  fs.writeFileSync(
    path.join(home, '.config', 'prmpt', 'statusline-chain-claude.json'),
    JSON.stringify({ argv: ['/definitely/not/a/real/binary'] }),
  );
  const res = await run(STATUSLINE, {
    env: baseEnv({ HOME: home, CLAUDECODE: '1' }),
    stdin: '{}',
  });
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
  assert.match(visible(res.stdout), /^Sponsored · /);
});

test('in single-row hosts a chained status line wins over the ad', async () => {
  const home = tmpDir('prmpt-home-');
  park(home);
  const chain = path.join(home, 'mine.sh');
  fs.writeFileSync(chain, '#!/bin/sh\necho "my own status line"\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(home, '.config', 'prmpt', 'statusline-chain-codex.json'),
    JSON.stringify({ command: `sh ${chain}` }),
  );
  const res = await run(STATUSLINE, {
    args: ['--line'],
    env: baseEnv({ HOME: home }),
    stdin: '',
  });
  assert.equal(visible(res.stdout).trimEnd(), 'my own status line');
});

// --- installing -------------------------------------------------------------

test('install writes Claude Code settings and chains what was there', async () => {
  const home = tmpDir('prmpt-home-');
  seedConfig(home);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    statusLine: { type: 'command', command: 'echo mine' },
    permissions: { allow: ['Bash(ls:*)'] },
  }, null, 2));

  const res = await run(CLI, {
    args: ['statusline', 'install', '--claude'],
    env: baseEnv({ HOME: home }),
  });
  assert.equal(res.code, 0, res.stderr);

  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(after.statusLine.type, 'command');
  assert.match(after.statusLine.command, /statusline\.mjs/);
  assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] }, 'unrelated settings untouched');

  const chain = JSON.parse(
    fs.readFileSync(path.join(home, '.config', 'prmpt', 'statusline-chain-claude.json'), 'utf8'),
  );
  assert.equal(chain.command, 'echo mine');
});

test('uninstall puts the original Claude Code status line back', async () => {
  const home = tmpDir('prmpt-home-');
  seedConfig(home);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }));

  const env = baseEnv({ HOME: home });
  await run(CLI, { args: ['statusline', 'install', '--claude'], env });
  await run(CLI, { args: ['statusline', 'uninstall', '--claude'], env });

  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(after.statusLine, { type: 'command', command: 'echo mine' });
});

test('uninstall with no prior status line removes the key entirely', async () => {
  const home = tmpDir('prmpt-home-');
  seedConfig(home);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }));

  const env = baseEnv({ HOME: home });
  await run(CLI, { args: ['statusline', 'install', '--claude'], env });
  await run(CLI, { args: ['statusline', 'uninstall', '--claude'], env });

  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal('statusLine' in after, false);
  assert.equal(after.model, 'opus');
});

test('install edits only the [tui] table in Codex config', async () => {
  const home = tmpDir('prmpt-home-');
  seedConfig(home);
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, [
    'model = "gpt-5"',
    '',
    '[mcp_servers.thing]',
    'status_line = "not the tui one"',
    '',
    '[tui]',
    'notifications = true',
    '',
  ].join('\n'));

  const res = await run(CLI, {
    args: ['statusline', 'install', '--codex'],
    env: baseEnv({ HOME: home }),
  });
  assert.equal(res.code, 0, res.stderr);

  const after = fs.readFileSync(cfg, 'utf8');
  assert.match(after, /\[tui\][\s\S]*status_line = \[.*statusline\.mjs.*\] # prmpt/);
  assert.match(after, /status_line_timeout_ms = 1500/);
  assert.match(after, /notifications = true/);
  assert.match(after, /model = "gpt-5"/);
  assert.match(after, /status_line = "not the tui one"/, 'the other table is untouched');
});

test('installing twice into Codex leaves exactly one status_line', async () => {
  const home = tmpDir('prmpt-home-');
  seedConfig(home);
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, '[tui]\n');

  const env = baseEnv({ HOME: home });
  await run(CLI, { args: ['statusline', 'install', '--codex'], env });
  await run(CLI, { args: ['statusline', 'install', '--codex'], env });

  const after = fs.readFileSync(cfg, 'utf8');
  assert.equal((after.match(/^[ \t]*status_line[ \t]*=/gm) || []).length, 1);
});

test('Codex install refuses to replace a built-in status_line it cannot chain', async () => {
  const home = tmpDir('prmpt-home-');
  seedConfig(home);
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  const original = '[tui]\nstatus_line = ["model", "tokens"]\n';
  fs.writeFileSync(cfg, original);

  const res = await run(CLI, {
    args: ['statusline', 'install', '--codex'],
    env: baseEnv({ HOME: home }),
  });
  assert.notEqual(res.code, 0);
  assert.equal(fs.readFileSync(cfg, 'utf8'), original, 'the config is left exactly as it was');
});

test('uninstall leaves a status line that is no longer ours alone', async () => {
  const home = tmpDir('prmpt-home-');
  seedConfig(home);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const env = baseEnv({ HOME: home });
  fs.writeFileSync(settings, JSON.stringify({}));
  await run(CLI, { args: ['statusline', 'install', '--claude'], env });

  // Somebody else takes the slot after we installed.
  const taken = { type: 'command', command: 'echo someone-else' };
  fs.writeFileSync(settings, JSON.stringify({ statusLine: taken }));
  await run(CLI, { args: ['statusline', 'uninstall', '--claude'], env });

  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine, taken);
});
