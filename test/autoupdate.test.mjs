// prmpt -- the hook keeping itself current.
//
// Auto-apply is on by default, which makes the cost to a turn the thing that
// has to be proved: a stat and a spawn, never a download.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertSilentSuccess,
  baseEnv,
  decision,
  run,
  stubServer,
  tmpDir,
  PLUGIN_DIR,
  LONG_TURN,
} from './helpers.mjs';

/**
 * A copy of the real plugin that is NOT a git checkout, so the auto-updater
 * treats it as an installed copy. Only the files the hook actually loads.
 *
 * bin/prmpt.mjs is replaced with a stub that records its argv instead of
 * updating. That keeps these tests offline -- the real thing would call
 * api.github.com from a detached child, which is both slow and flaky -- and it
 * makes the spawn observable, which is the actual thing under test here. The
 * genuine download/verify/swap path is covered by update.test.mjs.
 */
function fakeInstall(version = '0.1.0') {
  const dir = tmpDir('prmpt-install-');
  for (const sub of ['hooks/lib', 'bin']) fs.mkdirSync(path.join(dir, sub), { recursive: true });

  // hooks/lib is copied WHOLESALE rather than as a named list, because a named
  // list is a second inventory of the plugin that nothing keeps in step. It
  // silently went stale the moment turn-end.mjs imported a new module: the
  // fixture omitted the file, the hook died on MODULE_NOT_FOUND, and six
  // auto-update tests failed for a reason that had nothing to do with
  // auto-updating. The real installer untars the whole tree, so this is also
  // the more faithful fixture.
  for (const rel of ['hooks/turn-end.mjs', 'bin/prmpt.mjs']) {
    fs.copyFileSync(path.join(PLUGIN_DIR, rel), path.join(dir, rel));
  }
  for (const entry of fs.readdirSync(path.join(PLUGIN_DIR, 'hooks', 'lib'))) {
    if (entry.endsWith('.mjs')) {
      fs.copyFileSync(
        path.join(PLUGIN_DIR, 'hooks', 'lib', entry),
        path.join(dir, 'hooks', 'lib', entry),
      );
    }
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'prmpt', version }));

  const spawnLog = path.join(dir, 'spawned.log');
  fs.writeFileSync(path.join(dir, 'bin', 'prmpt.mjs'), [
    "import fs from 'node:fs';",
    "import os from 'node:os';",
    `fs.appendFileSync(${JSON.stringify(spawnLog)}, process.argv.slice(2).join(' ') + os.EOL);`,
    '',
  ].join('\n'));

  assert.equal(fs.existsSync(path.join(dir, '.git')), false, 'the fake install must not be a checkout');
  return dir;
}

/** What the detached child was invoked with, once it has had a moment to run. */
async function spawnedArgs(install) {
  const log = path.join(install, 'spawned.log');
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(log)) return fs.readFileSync(log, 'utf8').trim().split('\n');
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

function payload() {
  return JSON.stringify({
    hook_event_name: 'Stop',
    session_id: `au-${Math.random()}`,
    last_assistant_message: LONG_TURN,
  });
}

/** Run the hook from a fake install dir, with a real token so it would serve. */
async function runFrom(install, env) {
  return run(path.join(install, 'hooks', 'turn-end.mjs'), { env, stdin: payload() });
}

function linkedHome(endpoint) {
  const home = tmpDir('prmpt-au-home-');
  const cfg = path.join(home, '.config', 'prmpt');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'config.json'),
    JSON.stringify({ token: 'a-token', installId: 'x', endpoint }));
  return home;
}

test('the update check costs the turn a marker file, not a download', async () => {
  const server = await stubServer(() => decision());
  try {
    const install = fakeInstall();
    const home = linkedHome(server.url);
    // Opt IN: the suite's baseEnv opts out by default.
    const env = baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url, PRMPT_NO_AUTO_UPDATE: '0' });

    const res = await runFrom(install, env);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /Sponsored/, 'the ad still served');
    // The turn is not paying for the update.
    assert.ok(res.ms < 1500, `auto-update must not be on the turn's clock (${res.ms}ms)`);

    assert.equal(fs.existsSync(path.join(home, '.config', 'prmpt', '.update-check')), true);
    // And it really did hand the work to the CLI, in the background.
    assert.deepEqual(await spawnedArgs(install), ['update --quiet']);
  } finally {
    await server.close();
  }
});

test('the check happens at most once a day', async () => {
  const server = await stubServer(() => decision());
  try {
    const install = fakeInstall();
    const home = linkedHome(server.url);
    const env = baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url, PRMPT_NO_AUTO_UPDATE: '0' });
    const marker = path.join(home, '.config', 'prmpt', '.update-check');

    await runFrom(install, env);
    const first = fs.readFileSync(marker, 'utf8');
    const firstMtime = fs.statSync(marker).mtimeMs;

    assert.deepEqual(await spawnedArgs(install), ['update --quiet']);

    await runFrom(install, env);
    assert.equal(fs.readFileSync(marker, 'utf8'), first);
    assert.equal(fs.statSync(marker).mtimeMs, firstMtime,
      'a second turn inside the window must not re-check');
    // Exactly one child, not two.
    assert.deepEqual(await spawnedArgs(install), ['update --quiet']);
  } finally {
    await server.close();
  }
});

test('a stale marker lets the check run again', async () => {
  const server = await stubServer(() => decision());
  try {
    const install = fakeInstall();
    const home = linkedHome(server.url);
    const env = baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url, PRMPT_NO_AUTO_UPDATE: '0' });
    const marker = path.join(home, '.config', 'prmpt', '.update-check');

    await runFrom(install, env);
    const old = Date.now() - 48 * 60 * 60 * 1000;
    fs.utimesSync(marker, old / 1000, old / 1000);

    await runFrom(install, env);
    assert.ok(fs.statSync(marker).mtimeMs > old + 1000, 'the marker should have been refreshed');
  } finally {
    await server.close();
  }
});

test('PRMPT_NO_AUTO_UPDATE=1 checks nothing', async () => {
  const server = await stubServer(() => decision());
  try {
    const install = fakeInstall();
    const home = linkedHome(server.url);
    const env = baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url, PRMPT_NO_AUTO_UPDATE: '1' });

    const res = await runFrom(install, env);
    assert.equal(res.code, 0);
    assert.equal(fs.existsSync(path.join(home, '.config', 'prmpt', '.update-check')), false);
    assert.deepEqual(await spawnedArgs(install), []);
  } finally {
    await server.close();
  }
});

test('a git checkout is never auto-updated', async () => {
  // The real plugin directory IS a checkout, which is the case that protects
  // anyone developing on it.
  const server = await stubServer(() => decision());
  try {
    const home = linkedHome(server.url);
    const env = baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url, PRMPT_NO_AUTO_UPDATE: '0' });
    const res = await run(path.join(PLUGIN_DIR, 'hooks', 'turn-end.mjs'), { env, stdin: payload() });
    assert.equal(res.code, 0);
    assert.equal(fs.existsSync(path.join(home, '.config', 'prmpt', '.update-check')), false,
      'a checkout must not even record an attempt');
  } finally {
    await server.close();
  }
});

test('PRMPT_DISABLED=1 wins over auto-update', async () => {
  const install = fakeInstall();
  const home = tmpDir('prmpt-au-off-');
  const env = baseEnv({ HOME: home, PRMPT_DISABLED: '1', PRMPT_NO_AUTO_UPDATE: '0' });
  const res = await runFrom(install, env);
  assertSilentSuccess(res, 'disabled');
  assert.equal(fs.existsSync(path.join(home, '.config', 'prmpt')), false);
});

test('an unauthenticated install still updates itself', async () => {
  // Deliberate: an install that has drifted far enough behind to be broken
  // must still be able to fix itself, token or no token.
  const install = fakeInstall();
  const home = tmpDir('prmpt-au-notoken-');
  const env = baseEnv({
    HOME: home,
    PRMPT_ENDPOINT: 'http://127.0.0.1:1/graphql',
    PRMPT_NO_AUTO_UPDATE: '0',
    PRMPT_NO_AUTO_ENROL: '1',
  });
  const res = await runFrom(install, env);
  assertSilentSuccess(res, 'no token');
  assert.equal(fs.existsSync(path.join(home, '.config', 'prmpt', '.update-check')), true);
});
