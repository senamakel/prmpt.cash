// Installation smoke: does install.sh leave a working hook behind, on this OS?
//
// Runs on Linux, macOS and Windows (Git Bash). Nothing here needs an agent to
// be installed — that is the job of agents.smoke.test.mjs. This file is about
// the installer's own contract: the right event in the right file with the
// right timeout unit, idempotently, without eating a config that was already
// there, and reversibly.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  AMP_PLUGIN,
  HOSTS,
  PLUGIN_DIR,
  STATUSLINE_STATE,
  agentFreePath,
  entriesFor,
  exec,
  hostConfigPath,
  install,
  ourEntries,
  readJSON,
  runRecorded,
  sandbox,
  shellPath,
  smokeEnv,
} from './lib.mjs';

const ALL_AGENTS = 'claude,codex,gemini,amp';

test('install.sh is valid POSIX sh on this platform', async () => {
  const res = await exec('sh', ['-n', shellPath(path.join(PLUGIN_DIR, 'install.sh'))], {
    env: smokeEnv(process.env.HOME ?? process.env.USERPROFILE ?? '.'),
  });
  assert.equal(res.code, 0, `sh -n failed: ${res.stderr}`);
});

test('--help exits 0 and documents every flag', async () => {
  const box = sandbox();
  const res = await install(box, ['--help']);
  assert.equal(res.code, 0, res.stderr);
  for (const flag of ['--no-login', '--version', '--agents', '--endpoint', '--dir', '--project', '--uninstall']) {
    assert.ok(res.stdout.includes(flag), `--help does not mention ${flag}`);
  }
});

test('an unknown flag fails loudly rather than installing something unexpected', async () => {
  const box = sandbox();
  const res = await install(box, ['--install-code', 'retired', '--dir', box.dirArg]);
  assert.notEqual(res.code, 0, 'unknown flag should not exit 0');
  assert.ok(/unknown option/.test(res.stderr), res.stderr);
  assert.ok(!fs.existsSync(box.dir), 'nothing should have been installed');
});

test('a forced install wires up every host with its own event and timeout unit', async () => {
  const box = sandbox();
  const res = await install(box, ['--agents', ALL_AGENTS, '--dir', box.dirArg]);
  assert.equal(res.code, 0, `installer failed:\n${res.stdout}\n${res.stderr}`);

  // The plugin itself landed.
  assert.ok(fs.existsSync(path.join(box.dir, 'hooks', 'turn-end.mjs')), 'hook not copied');
  assert.ok(fs.existsSync(path.join(box.dir, 'hooks', 'lib', 'api.mjs')), 'hook lib not copied');

  for (const host of HOSTS) {
    const file = hostConfigPath(box, host);
    assert.ok(fs.existsSync(file), `${host.label}: ${file} was not written`);
    const config = readJSON(file);

    const mine = ourEntries(config, host.event);
    assert.equal(mine.length, 1, `${host.label}: expected exactly one entry under ${host.event}`);

    const [entry] = mine;
    assert.equal(entry.type, 'command', `${host.label}: wrong hook type`);
    assert.equal(
      entry.timeout,
      host.timeout,
      `${host.label}: timeout must be ${host.timeout} — the unit differs per host and is not interchangeable`,
    );
    assert.equal(entry.matcher, host.matcher, `${host.label}: wrong matcher`);
    assert.ok(entry.command.includes('turn-end.mjs'), `${host.label}: command does not run the hook`);

    // Claude Code's status-line surface needs a second hook, on a second
    // event, and nothing else here has one. Every event in the file must be
    // one this host declares -- a hook on an event the host does not fire is
    // indistinguishable from no hook at all.
    for (const extra of host.extraEvents) {
      const entries = ourEntries(config, extra.event);
      assert.equal(
        entries.length,
        1,
        `${host.label}: expected exactly one entry under ${extra.event}`,
      );
      assert.equal(entries[0].timeout, extra.timeout, `${host.label}: wrong ${extra.event} timeout`);
      assert.equal(entries[0].matcher, extra.matcher, `${host.label}: wrong ${extra.event} matcher`);
      assert.ok(
        entries[0].command.includes(extra.hook),
        `${host.label}: ${extra.event} does not run ${extra.hook}`,
      );
    }
    const declared = [host.event, ...host.extraEvents.map((e) => e.event)].sort();
    const written = Object.keys(config.hooks ?? {}).sort();
    assert.deepEqual(written, declared, `${host.label}: unexpected events ${written}`);
  }

  // Amp is a copied plugin file, not a hook entry.
  const amp = path.join(box.home, ...AMP_PLUGIN);
  assert.ok(fs.existsSync(amp), 'Amp plugin not copied');
  assert.ok(
    fs.readFileSync(amp, 'utf8').includes('agent.end'),
    'Amp plugin does not subscribe to agent.end',
  );
});

test('the recorded command is executable by this platform', async () => {
  // The single most valuable assertion in this file. An install that writes a
  // path the host cannot resolve — an MSYS path on Windows, an unquoted space
  // anywhere — produces a config that looks perfect and never runs.
  const box = sandbox();
  await install(box, ['--agents', ALL_AGENTS, '--dir', box.dirArg]);

  for (const host of HOSTS) {
    const config = readJSON(hostConfigPath(box, host));
    for (const { event } of [{ event: host.event }, ...host.extraEvents]) {
      const [entry] = ourEntries(config, event);
      const res = await runRecorded(entry.command, {
        env: smokeEnv(box.home),
        stdin: JSON.stringify({ hook_event_name: event, prompt: 'anything at all' }),
      });
      // No API key is configured, so the correct behaviour is fail-open silence.
      assert.equal(res.code, 0, `${host.label} ${event}: exited ${res.code}: ${res.stderr}`);
      assert.equal(res.stdout, '', `${host.label} ${event}: printed to stdout`);
      assert.equal(res.stderr, '', `${host.label} ${event}: printed to stderr`);
    }
  }
});

// --- the status line --------------------------------------------------------
//
// The second ad surface, and the only one that has to share its real estate
// with something the user already built. Claude Code only: nothing else here
// has a footer that renders while the model is working.

/** The Claude Code row, which is the only one with a status line. */
const CLAUDE = HOSTS.find((h) => h.agent === 'claude');

/** A stand-in for the status line somebody already had, as a runnable command. */
function priorStatusLine(box, text) {
  const file = path.join(box.home, 'their-statusline.mjs');
  fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(text)});\n`);
  return `"${process.execPath}" "${shellPath(file)}"`;
}

test('the status line is wired up for Claude Code and for nobody else', async () => {
  const box = sandbox();
  await install(box, ['--agents', ALL_AGENTS, '--dir', box.dirArg]);

  const claude = readJSON(hostConfigPath(box, CLAUDE));
  assert.equal(claude.statusLine?.type, 'command', 'no statusLine was recorded');
  assert.ok(
    claude.statusLine.command.includes(CLAUDE.statusLine),
    `statusLine does not run ${CLAUDE.statusLine}: ${claude.statusLine.command}`,
  );

  for (const host of HOSTS.filter((h) => !h.statusLine)) {
    const config = readJSON(hostConfigPath(box, host));
    assert.equal(config.statusLine, undefined, `${host.label} has no status line to wire up`);
  }
});

test('the recorded status-line command runs and prints one line', async () => {
  const box = sandbox();
  await install(box, ['--agents', 'claude', '--dir', box.dirArg]);
  const { command } = readJSON(hostConfigPath(box, CLAUDE)).statusLine;

  const res = await runRecorded(command, {
    env: smokeEnv(box.home),
    stdin: JSON.stringify({ session_id: 'smoke-session', model: { display_name: 'Opus' } }),
  });
  // No slot is parked, so the honest output is nothing at all.
  assert.equal(res.code, 0, `status line exited ${res.code}: ${res.stderr}`);
  assert.equal(res.stderr, '', 'the status line wrote to stderr');
  assert.equal(res.stdout, '', 'the status line invented output with no ad to show');
});

test("an existing status line is wrapped, not replaced", async () => {
  // Silently replacing a status line somebody built is the fastest possible
  // way to be uninstalled, and the user would be right.
  const box = sandbox();
  const file = hostConfigPath(box, CLAUDE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const theirs = priorStatusLine(box, 'my-repo (main) 41% left');
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: theirs } }));

  const res = await install(box, ['--agents', 'claude', '--dir', box.dirArg]);
  assert.equal(res.code, 0, res.stderr);

  const state = readJSON(path.join(box.home, ...STATUSLINE_STATE));
  assert.equal(state.wrapped, theirs, 'their command was not recorded');

  const { command } = readJSON(file).statusLine;
  const ran = await runRecorded(command, {
    env: smokeEnv(box.home),
    stdin: JSON.stringify({ session_id: 'smoke-session' }),
  });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(
    ran.stdout.trimEnd(),
    'my-repo (main) 41% left',
    'their status line stopped being rendered',
  );
});

test('re-running the installer never wraps our own command', async () => {
  // The second run sees OUR command sitting in statusLine. Recording that as
  // "the thing to wrap" would fork a copy of the renderer on every render.
  const box = sandbox();
  const file = hostConfigPath(box, CLAUDE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const theirs = priorStatusLine(box, 'my-repo (main)');
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: theirs } }));

  for (let i = 0; i < 3; i++) {
    const res = await install(box, ['--agents', 'claude', '--dir', box.dirArg]);
    assert.equal(res.code, 0, res.stderr);
  }

  const state = readJSON(path.join(box.home, ...STATUSLINE_STATE));
  assert.equal(state.wrapped, theirs, `three runs recorded: ${state.wrapped}`);
  assert.ok(
    !state.wrapped.includes(CLAUDE.statusLine),
    'the installer recorded our own command as the one to wrap',
  );
});

test('uninstall gives the status line back', async () => {
  const box = sandbox();
  const file = hostConfigPath(box, CLAUDE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const theirs = priorStatusLine(box, 'my-repo (main)');
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: theirs } }));

  await install(box, ['--agents', 'claude', '--dir', box.dirArg]);
  const res = await install(box, ['--uninstall', '--dir', box.dirArg]);
  assert.equal(res.code, 0, res.stderr);

  const after = readJSON(file);
  assert.equal(after.statusLine?.command, theirs, 'their status line was not restored');
  assert.equal(after.model, 'opus', 'the rest of the config was lost');
  assert.equal(ourEntries(after, 'UserPromptSubmit').length, 0, 'the prompt hook survived uninstall');
});

test('uninstall removes a status line we added where there was none', async () => {
  const box = sandbox();
  await install(box, ['--agents', 'claude', '--dir', box.dirArg]);
  const file = hostConfigPath(box, CLAUDE);
  assert.ok(readJSON(file).statusLine, 'nothing was installed to remove');

  await install(box, ['--uninstall', '--dir', box.dirArg]);
  assert.equal(
    readJSON(file).statusLine,
    undefined,
    'a status line the user never had was left behind',
  );
});

test('installing into a path containing a space still produces a runnable command', async () => {
  const box = sandbox();
  const spaced = path.join(box.home, 'Application Support', 'try prompt');
  await install(box, ['--agents', 'claude', '--dir', shellPath(spaced)]);

  const [entry] = ourEntries(readJSON(hostConfigPath(box, HOSTS[0])), 'Stop');
  const res = await runRecorded(entry.command, { env: smokeEnv(box.home) });
  assert.equal(
    res.code,
    0,
    `a space in the install path broke the recorded command: ${entry.command}\n${res.stderr}`,
  );
});

test('re-running upgrades in place without stacking duplicates', async () => {
  const box = sandbox();
  await install(box, ['--agents', ALL_AGENTS, '--dir', box.dirArg]);
  const second = await install(box, ['--agents', ALL_AGENTS, '--dir', box.dirArg]);
  assert.equal(second.code, 0, second.stderr);
  const third = await install(box, ['--agents', ALL_AGENTS, '--dir', box.dirArg]);
  assert.equal(third.code, 0, third.stderr);

  for (const host of HOSTS) {
    const config = readJSON(hostConfigPath(box, host));
    assert.equal(
      ourEntries(config, host.event).length,
      1,
      `${host.label}: three runs produced ${ourEntries(config, host.event).length} entries`,
    );
    // Empty matcher groups left behind by the de-duplication would make the
    // config grow without bound even though the entry count stays at one.
    const groups = config.hooks[host.event];
    assert.ok(groups.length <= 1, `${host.label}: ${groups.length} hook groups accumulated`);
  }
});

test('a config that was already there survives, backup and all', async () => {
  const box = sandbox();
  const file = hostConfigPath(box, HOSTS[0]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = {
    model: 'opus',
    env: { FOO: 'bar' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo my-own-stop-hook' }] }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(before, null, 2));

  const res = await install(box, ['--agents', 'claude', '--dir', box.dirArg]);
  assert.equal(res.code, 0, res.stderr);

  const after = readJSON(file);
  assert.equal(after.model, 'opus', 'unrelated top-level settings were dropped');
  assert.deepEqual(after.env, { FOO: 'bar' }, 'unrelated env block was dropped');
  assert.equal(
    entriesFor(after, 'PreToolUse').length,
    1,
    "someone else's PreToolUse hook was removed",
  );
  const stop = entriesFor(after, 'Stop');
  assert.ok(
    stop.some((h) => h.command === 'echo my-own-stop-hook'),
    "someone else's Stop hook was removed",
  );
  assert.equal(ourEntries(after, 'Stop').length, 1);

  const backup = `${file}.bak`;
  assert.ok(fs.existsSync(backup), 'no .bak was written before the first modification');
  assert.deepEqual(readJSON(backup), before, 'the .bak is not the original file');
});

test('a config written with a UTF-8 BOM is still merged into', async () => {
  // Windows tooling writes BOMs and JSON.parse rejects them, so a BOM used to
  // route the config down the "unparseable, leave it alone" path -- the install
  // reported success and wired up nothing. install.ps1 did this to its own
  // freshly created file, so a fresh Windows install configured no agent at all.
  const box = sandbox();
  const file = hostConfigPath(box, HOSTS[0]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `\uFEFF${JSON.stringify({ model: 'opus' })}`);

  const res = await install(box, ['--agents', 'claude', '--dir', box.dirArg]);
  assert.equal(res.code, 0, res.stderr);

  const after = fs.readFileSync(file, 'utf8');
  assert.ok(!after.startsWith('\uFEFF'), 'the BOM was written back out');
  const config = JSON.parse(after);
  assert.equal(config.model, 'opus', 'the rest of the config was lost');
  assert.equal(ourEntries(config, 'Stop').length, 1, 'the hook was not merged in');
});

test('both installers embed the same JSON-merge program, character for character', () => {
  // install.ps1 delegates every config edit to the same Node programs
  // install.sh uses, so the one step that can corrupt somebody's agent config
  // is written once rather than twice. Nothing enforced that, and they drifted
  // twice in a single afternoon -- once over quoting, once over how the program
  // reads its inputs. Each drift produced a Windows install that reported
  // success and wired up nothing.
  const sh = fs.readFileSync(path.join(PLUGIN_DIR, 'install.sh'), 'utf8');
  const ps = fs.readFileSync(path.join(PLUGIN_DIR, 'install.ps1'), 'utf8');

  /** The body of a `node -e '<program>'` in install.sh. */
  const fromSh = (after) => {
    const start = sh.indexOf("\"$NODE_BIN\" -e '", sh.indexOf(after));
    assert.notEqual(start, -1, `install.sh: no node -e program after ${after}`);
    const open = sh.indexOf('\n', start) + 1;
    const close = sh.indexOf("\n", sh.indexOf("'", open));
    return sh.slice(open, sh.lastIndexOf("'", close));
  };

  /** The body of a `$Name = @' ... '@` here-string in install.ps1. */
  const fromPs = (name) => {
    const open = ps.indexOf("\n", ps.indexOf(`$${name} = @'`)) + 1;
    const close = ps.indexOf("\n'@", open);
    assert.ok(open > 0 && close > open, `install.ps1: no here-string for $${name}`);
    return ps.slice(open, close + 1);
  };

  // install.sh indents its programs inside a shell function; strip that.
  const normalise = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

  assert.equal(
    normalise(fromPs('MergeJs')),
    normalise(fromSh('merge_hook()')),
    'the merge programs have drifted',
  );
  assert.equal(
    normalise(fromPs('CleanJs')),
    normalise(fromSh('Removing prmpt')),
    'the uninstall programs have drifted',
  );
});

test('a config that is not valid JSON is left completely alone', async () => {
  const box = sandbox();
  const file = hostConfigPath(box, HOSTS[0]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const garbage = '{ this is not json, and it is the user\'s only copy\n';
  fs.writeFileSync(file, garbage);

  await install(box, ['--agents', 'claude,codex', '--dir', box.dirArg]);

  assert.equal(fs.readFileSync(file, 'utf8'), garbage, 'an unparseable config was overwritten');
  // The rest of the install must still have happened.
  assert.equal(ourEntries(readJSON(hostConfigPath(box, HOSTS[1])), 'Stop').length, 1);
});

test('--project writes beside the project and never touches HOME', async () => {
  const box = sandbox();
  const project = path.join(box.home, 'project');
  fs.mkdirSync(project, { recursive: true });

  const res = await install(box, ['--agents', ALL_AGENTS, '--dir', box.dirArg, '--project'], {
    cwd: project,
  });
  assert.equal(res.code, 0, res.stderr);

  for (const host of HOSTS) {
    assert.ok(
      fs.existsSync(path.join(project, ...host.projectConfig)),
      `${host.label}: project config not written`,
    );
    assert.ok(
      !fs.existsSync(hostConfigPath(box, host)),
      `${host.label}: --project still wrote into HOME`,
    );
  }
});

test('--uninstall removes our entries, keeps everyone else\'s, and keeps the token', async () => {
  const box = sandbox();
  const file = hostConfigPath(box, HOSTS[0]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo my-own-stop-hook' }] }] },
  }));

  await install(box, ['--agents', ALL_AGENTS, '--dir', box.dirArg]);

  // Pretend the user had linked: the token must outlive an uninstall.
  const configDir = path.join(box.home, '.config', 'prmpt');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ token: 'keep_me' }));

  const res = await install(box, ['--uninstall', '--dir', box.dirArg]);
  assert.equal(res.code, 0, res.stderr);

  for (const host of HOSTS) {
    const after = readJSON(hostConfigPath(box, host));
    assert.equal(ourEntries(after, host.event).length, 0, `${host.label}: entry survived uninstall`);
  }
  assert.ok(
    entriesFor(readJSON(file), 'Stop').some((h) => h.command === 'echo my-own-stop-hook'),
    "uninstall removed someone else's Stop hook",
  );
  assert.ok(!fs.existsSync(path.join(box.home, ...AMP_PLUGIN)), 'Amp plugin survived uninstall');
  assert.ok(!fs.existsSync(box.dir), 'install dir survived uninstall');
  assert.ok(
    fs.existsSync(path.join(configDir, 'config.json')),
    'uninstall deleted the token, which it documents that it does not',
  );
});

test('a default install contacts nothing and creates no credentials', async () => {
  // The guard rail for this whole suite. smokeEnv sets PRMPT_NO_LOGIN=1; if that
  // ever stops being honoured, this fails here instead of silently creating a
  // publisher account on production from five matrix jobs and a weekly cron.
  const box = sandbox();
  const res = await install(box, ['--agents', ALL_AGENTS, '--dir', box.dirArg]);
  assert.equal(res.code, 0, res.stderr);

  const configDir = path.join(box.home, '.config', 'prmpt');
  assert.equal(fs.existsSync(path.join(configDir, 'wallet.json')), false,
    'installing must not create a wallet');
  assert.equal(fs.existsSync(path.join(configDir, 'config.json')), false,
    'installing must not store a token');
  // And it should say why it stayed silent, rather than looking linked.
  assert.ok(/no-login|stay silent/i.test(res.stdout + res.stderr), res.stdout + res.stderr);
});

test('with no agents selected and none present, the installer says so and fails', async () => {
  const box = sandbox();
  // Autodetect with an empty HOME and a PATH that has node but no agent.
  const res = await install(box, ['--dir', box.dirArg], { env: { PATH: agentFreePath() } });
  assert.notEqual(res.code, 0, 'configuring nothing should not report success');
  assert.ok(/no agents were configured/.test(res.stderr), res.stderr);
});
