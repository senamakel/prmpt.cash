// Windows smoke: install.ps1, the native path a Windows user actually takes.
//
// Windows has two install routes and they are not equivalent. install.sh runs
// under Git Bash and is covered by installer.smoke.test.mjs; install.ps1 is the
// one the README hands to a Windows user, and it is a second implementation of
// the same wiring. Two implementations of "merge a hook into somebody's config"
// is exactly the shape of thing that drifts, so this file checks the result of
// each and then checks they agree.
//
// Skipped wholesale off Windows.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  HOSTS,
  IS_WINDOWS,
  TEST_TOKEN,
  hostConfigPath,
  install,
  installPs1,
  ourEntries,
  readJSON,
  runRecorded,
  sandbox,
  smokeEnv,
} from './lib.mjs';
import { stubServer } from '../helpers.mjs';

const skip = IS_WINDOWS ? false : 'not Windows';

/** install.ps1 puts the Amp plugin under %APPDATA%, not under ~/.config. */
function ampPath(box) {
  return path.join(box.home, 'AppData', 'Roaming', 'amp', 'plugins', 'prmpt.ts');
}

test('install.ps1 wires up every host with its own event and timeout unit', { skip }, async () => {
  const box = sandbox();
  const res = await installPs1(box, ['-Agents', 'claude,codex,gemini,amp', '-Dir', box.dir]);
  assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);

  for (const host of HOSTS) {
    const file = hostConfigPath(box, host);
    assert.ok(fs.existsSync(file), `${host.label}: ${file} was not written`);
    assert.ok(
      !fs.readFileSync(file, 'utf8').startsWith('\uFEFF'),
      `${host.label}: install.ps1 left a UTF-8 BOM, which every agent's JSON parser rejects`,
    );
    const [entry] = ourEntries(readJSON(file), host.event);
    assert.ok(entry, `${host.label}: no entry under ${host.event}`);
    assert.equal(entry.timeout, host.timeout, `${host.label}: wrong timeout unit`);
    assert.equal(entry.matcher, host.matcher, `${host.label}: wrong matcher`);
  }
  assert.ok(fs.existsSync(ampPath(box)), 'Amp plugin not copied under %APPDATA%');
});

test('the command install.ps1 recorded runs under cmd.exe', { skip }, async () => {
  const box = sandbox();
  await installPs1(box, ['-Agents', 'claude,codex,gemini', '-Dir', box.dir]);

  for (const host of HOSTS) {
    const [entry] = ourEntries(readJSON(hostConfigPath(box, host)), host.event);
    const out = await runRecorded(entry.command, { env: smokeEnv(box.home) });
    assert.equal(out.code, 0, `${host.label}: ${entry.command} exited ${out.code}: ${out.stderr}`);
    assert.equal(out.stdout, '', `${host.label}: unlinked hook printed to stdout`);
  }
});

test('a Windows path with a space survives install.ps1', { skip }, async () => {
  const box = sandbox();
  const dir = path.join(box.home, 'Local App Data', 'prmpt');
  await installPs1(box, ['-Agents', 'claude', '-Dir', dir]);

  const [entry] = ourEntries(readJSON(hostConfigPath(box, HOSTS[0])), 'Stop');
  const out = await runRecorded(entry.command, { env: smokeEnv(box.home) });
  assert.equal(out.code, 0, `a space broke the recorded command: ${entry.command}\n${out.stderr}`);
});

test('install.ps1 is idempotent and reversible', { skip }, async () => {
  const box = sandbox();
  await installPs1(box, ['-Agents', 'claude,codex,gemini,amp', '-Dir', box.dir]);
  await installPs1(box, ['-Agents', 'claude,codex,gemini,amp', '-Dir', box.dir]);

  for (const host of HOSTS) {
    assert.equal(
      ourEntries(readJSON(hostConfigPath(box, host)), host.event).length,
      1,
      `${host.label}: two runs stacked duplicate entries`,
    );
  }

  const res = await installPs1(box, ['-Uninstall', '-Dir', box.dir]);
  assert.equal(res.code, 0, res.stderr);
  for (const host of HOSTS) {
    assert.equal(ourEntries(readJSON(hostConfigPath(box, host)), host.event).length, 0);
  }
  assert.ok(!fs.existsSync(ampPath(box)), 'Amp plugin survived -Uninstall');
  assert.ok(!fs.existsSync(box.dir), 'install dir survived -Uninstall');
});

test('install.ps1 wires a hook that serves with a supplied wallet token', { skip }, async () => {
  const server = await stubServer((body) => {
    return {
      data: {
        serveAd: {
          requestId: 'req_win',
          headline: 'Quarantine flaky tests before they gate a release',
          body: 'Detects flaky tests from CI history and isolates them.',
          clickUrl: 'https://api.example.test/c/req_win',
        },
      },
    };
  });
  try {
    const box = sandbox();
    const res = await installPs1(box, [
      '-Endpoint', server.url,
      '-Agents', 'codex',
      '-Dir', box.dir,
    ]);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.ok(!res.stdout.includes(TEST_TOKEN), 'install.ps1 echoed the token');

    const [entry] = ourEntries(readJSON(hostConfigPath(box, HOSTS[1])), 'Stop');
    const out = await runRecorded(entry.command, {
      env: smokeEnv(box.home, {
        PRMPT_ENDPOINT: server.url,
        PRMPT_TIMEOUT_MS: '10000',
        PRMPT_TOKEN: TEST_TOKEN,
      }),
      stdin: JSON.stringify({
        hook_event_name: 'Stop',
        last_assistant_message:
          'I moved the flaky integration tests behind a retry budget and pinned the ' +
          'Postgres container to 16, so the suite stops failing on a cold CI runner.',
      }),
    });
    assert.equal(out.code, 0, out.stderr);
    const envelope = JSON.parse(out.stdout);
    assert.ok(envelope.systemMessage.startsWith('Sponsored · '), out.stdout);
    assert.equal(server.headers.at(-1).authorization, `Bearer ${TEST_TOKEN}`);
  } finally {
    await server.close();
  }
});

test('install.sh under Git Bash and install.ps1 agree on what they write', { skip }, async () => {
  // Same machine, same agents, two installers. The hook path differs (one is
  // told a POSIX-style dir, the other a native one) so the comparison is on
  // everything except the path itself.
  const a = sandbox();
  const b = sandbox();
  await install(a, ['--agents', 'claude,codex,gemini', '--dir', a.dirArg]);
  await installPs1(b, ['-Agents', 'claude,codex,gemini', '-Dir', b.dir]);

  for (const host of HOSTS) {
    const strip = (e) => ({ ...e, command: e.command.replace(/node .*turn-end\.mjs"?/, 'node <hook>') });
    const [fromSh] = ourEntries(readJSON(hostConfigPath(a, host)), host.event);
    const [fromPs] = ourEntries(readJSON(hostConfigPath(b, host)), host.event);
    assert.deepEqual(
      strip(fromPs),
      strip(fromSh),
      `${host.label}: the two installers disagree about the hook entry`,
    );
  }
});

// ---------------------------------------------------------------- the command
//
// install.ps1's half of the PATH shim. It is a second implementation of what
// install.sh does -- a .cmd rather than a shell script, and a registry write
// rather than a line in a shell rc -- so it gets its own coverage rather than
// being assumed from the POSIX side.
//
// Nothing here asserts the registry write itself: smokeEnv sets
// PRMPT_NO_PATH_PERSIST=1 precisely so these runs cannot leave a dead directory
// on the machine's user PATH. What is asserted is the part a wrong PATH entry
// could not save anyway -- that the file exists, runs, and belongs to us.

/** Where install.ps1 puts the shim for a sandbox HOME. */
function shimPath(box) {
  return path.join(box.home, '.local', 'bin', 'prmpt.cmd');
}

test('install.ps1 leaves a runnable prmpt.cmd behind', { skip }, async () => {
  const box = sandbox();
  const res = await installPs1(box, ['-Agents', 'claude', '-Dir', box.dir]);
  assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);

  const shim = shimPath(box);
  assert.ok(fs.existsSync(shim), `no shim at ${shim}: ${res.stdout}${res.stderr}`);

  // Run it the way cmd.exe would, which is the whole point of a .cmd: no node,
  // no install directory, just the name.
  const out = await runRecorded(`"${shim}" --help`, { env: smokeEnv(box.home) });
  assert.equal(out.code, 0, `${out.stdout}${out.stderr}`);
  assert.match(out.stdout, /usage: prmpt/, out.stdout);
});

test('-NoPath installs the hooks and no command', { skip }, async () => {
  const box = sandbox();
  const res = await installPs1(box, ['-Agents', 'claude', '-Dir', box.dir, '-NoPath']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(fs.existsSync(shimPath(box)), false, 'a shim was written despite -NoPath');
  assert.match(res.stdout, /prmpt\.mjs onboard/, res.stdout);
});

test('-BinDir decides where the command goes', { skip }, async () => {
  const box = sandbox();
  const binDir = path.join(box.home, 'elsewhere');
  const res = await installPs1(box, ['-Agents', 'claude', '-Dir', box.dir, '-BinDir', binDir]);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(binDir, 'prmpt.cmd')), `${res.stdout}${res.stderr}`);
  assert.equal(fs.existsSync(shimPath(box)), false, 'wrote to the default directory too');
});

test("somebody else's prmpt.cmd is neither overwritten nor uninstalled", { skip }, async () => {
  const box = sandbox();
  const shim = shimPath(box);
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, '@echo off\r\necho not ours\r\n');

  const res = await installPs1(box, ['-Agents', 'claude', '-Dir', box.dir]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(fs.readFileSync(shim, 'utf8'), /not ours/, 'a foreign prmpt.cmd was overwritten');

  const un = await installPs1(box, ['-Uninstall', '-Dir', box.dir]);
  assert.equal(un.code, 0, un.stderr);
  assert.ok(fs.existsSync(shim), 'uninstall deleted a prmpt.cmd it did not write');
});

test('-Uninstall takes our command away', { skip }, async () => {
  const box = sandbox();
  await installPs1(box, ['-Agents', 'claude', '-Dir', box.dir]);
  assert.ok(fs.existsSync(shimPath(box)));

  const un = await installPs1(box, ['-Uninstall', '-Dir', box.dir]);
  assert.equal(un.code, 0, un.stderr);
  assert.equal(fs.existsSync(shimPath(box)), false, 'the shim outlived the install it points at');
});

test('both installers put the command in the same place', { skip }, async () => {
  // One machine can be installed both ways -- install.sh under Git Bash, then
  // install.ps1, or the reverse. If they disagreed about the directory the
  // second run would leave the first one's `prmpt` behind, pointing at a tree
  // that may since have been replaced.
  const a = sandbox();
  const b = sandbox();
  await install(a, ['--agents', 'claude', '--dir', a.dirArg]);
  await installPs1(b, ['-Agents', 'claude', '-Dir', b.dir]);

  assert.equal(
    path.relative(a.home, path.join(a.home, '.local', 'bin', 'prmpt')),
    path.relative(b.home, shimPath(b)).replace(/\.cmd$/, ''),
    'the two installers disagree about where the command goes',
  );
  assert.ok(fs.existsSync(path.join(a.home, '.local', 'bin', 'prmpt')));
  assert.ok(fs.existsSync(shimPath(b)));
});
