// Agent smoke: install the plugin next to the real coding agents.
//
// The installer suite proves install.sh writes the config it means to. This one
// proves the same thing against the actual CLIs — Claude Code, Codex and Gemini
// CLI, installed from npm in CI — because the parts that break are the parts
// that only exist once the agent is really there: autodetection, the plugin
// manifest Claude Code parses, and the command string a host has to execute.
//
// Every test skips when its agent is absent, so this file is useful locally
// with only the agents you happen to have. CI installs all three, and the
// workflow asserts they were installed, so a skip there is a red build rather
// than a quiet pass.
//
// What this cannot cover, and does not pretend to: none of these agents will
// run a turn without credentials, so no test here observes a hook firing from
// inside a live session. The closest honest substitute is running the exact
// command string the installer recorded, with the exact payload that host
// documents — which is what the last test does.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { stubServer } from '../helpers.mjs';
import {
  HOSTS,
  PLUGIN_DIR,
  TEST_TOKEN,
  execTool,
  hostConfigPath,
  install,
  ourEntries,
  readJSON,
  runRecorded,
  sandbox,
  smokeEnv,
} from './lib.mjs';

/** A turn well over the hook's 80 character minimum, and plausibly developer-y. */
const TURN =
  'I moved the flaky integration tests behind a retry budget and pinned the ' +
  'Postgres container to 16, so the suite stops failing on a cold CI runner.';

/** Resolve an agent CLI's version, or null if it is not installed here. */
async function version(bin) {
  try {
    const res = await execTool(bin, ['--version'], { env: process.env, timeout: 60_000 });
    return res.code === 0 ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}

const CLAUDE = await version('claude');
const CODEX = await version('codex');
const GEMINI = await version('gemini');

const PRESENT = new Map([
  ['claude', CLAUDE],
  ['codex', CODEX],
  ['gemini', GEMINI],
]);

/**
 * In CI a skip is a failure.
 *
 * Locally this file is meant to run with whatever agents you happen to have, so
 * each test skips when its agent is missing. That is exactly the behaviour that
 * turns a broken `npm i -g` step into a green build, so the workflow sets
 * PRMPT_SMOKE_REQUIRE_AGENTS=1 and the check below makes the absence explicit.
 */
const REQUIRE_AGENTS = process.env.PRMPT_SMOKE_REQUIRE_AGENTS === '1';

test('every agent this suite covers is installed', { skip: !REQUIRE_AGENTS && 'only enforced in CI' }, () => {
  for (const [name, v] of PRESENT) {
    assert.ok(v, `${name} is not installed, so its smoke tests would have skipped silently`);
  }
});

test('the agent CLIs under test report a version', () => {
  // Not an assertion so much as a record: the versions land in the CI log, so a
  // smoke failure six weeks from now can be pinned to a host release.
  for (const [name, v] of PRESENT) {
    console.log(`  ${name}: ${v ?? 'not installed'}`);
  }
});

test('Claude Code accepts the plugin manifest', { skip: !CLAUDE && 'claude not installed' }, async () => {
  // --strict fails on unrecognised fields and missing metadata, which the
  // runtime tolerates silently. A manifest that only "mostly" validates is how
  // a plugin ends up installed and inert.
  const res = await execTool('claude', ['plugin', 'validate', '--strict', PLUGIN_DIR], {
    env: process.env,
  });
  assert.equal(res.code, 0, `claude plugin validate --strict failed:\n${res.stdout}\n${res.stderr}`);
});

test('the plugin manifest and the installer agree on every hook', () => {
  // The manifest route (claude plugin install) and the installer route both
  // have to end at the same events with the same timeouts. They are written in
  // two different files and have drifted before.
  const manifest = readJSON(path.join(PLUGIN_DIR, 'hooks', 'hooks.json'));
  const claude = HOSTS.find((h) => h.agent === 'claude');

  for (const { event, timeout, hook } of [
    { event: claude.event, timeout: claude.timeout, hook: claude.hook },
    ...claude.extraEvents,
  ]) {
    const groups = manifest.hooks[event];
    assert.ok(Array.isArray(groups), `hooks.json declares no ${event}`);
    const entries = groups.flatMap((g) => g.hooks);
    assert.equal(entries.length, 1, `hooks.json: expected one entry under ${event}`);
    assert.equal(entries[0].timeout, timeout, `hooks.json: wrong ${event} timeout`);
    assert.ok(entries[0].command.includes(hook), `hooks.json: ${event} does not run ${hook}`);
  }

  assert.deepEqual(
    Object.keys(manifest.hooks).sort(),
    [claude.event, ...claude.extraEvents.map((e) => e.event)].sort(),
    'hooks.json and the installer declare different events',
  );
});

test('the plugin manifest cannot carry the status line, and says so', () => {
  // A Claude Code plugin declares hooks and nothing else -- statusLine is a
  // settings key, not a hook -- so the /plugin install route gets the
  // end-of-turn line and the fetch hook but no footer. Better to state that
  // here than to have somebody discover it as a missing feature.
  const manifest = readJSON(path.join(PLUGIN_DIR, 'hooks', 'hooks.json'));
  assert.equal(manifest.statusLine, undefined);
  assert.ok(
    /statusLine/.test(fs.readFileSync(path.join(PLUGIN_DIR, 'README.md'), 'utf8')),
    'README.md must explain that the status line needs the installer',
  );
});

test('autodetection wires up exactly the agents that are installed', async () => {
  const box = sandbox();
  // No --agents: the installer decides for itself, from PATH and from the
  // dotted directories in HOME. HOME here is empty, so PATH is what decides.
  const res = await install(box, ['--dir', box.dirArg], { env: { PATH: process.env.PATH } });

  const installed = [...PRESENT.values()].filter(Boolean).length;
  if (installed === 0) {
    assert.notEqual(res.code, 0, 'nothing installed, so the installer should have failed');
    return;
  }
  assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);

  for (const host of HOSTS) {
    const file = hostConfigPath(box, host);
    if (PRESENT.get(host.agent)) {
      assert.ok(fs.existsSync(file), `${host.label} is on PATH but was not wired up`);
      assert.equal(ourEntries(readJSON(file), host.event).length, 1);
    } else {
      assert.ok(!fs.existsSync(file), `${host.label} is not installed but was wired up anyway`);
    }
  }
});

test('Claude Code reads the settings file we wrote without complaining', { skip: !CLAUDE && 'claude not installed' }, async (t) => {
  const box = sandbox();
  const project = path.join(box.home, 'project');
  fs.mkdirSync(project, { recursive: true });
  await install(box, ['--agents', 'claude', '--dir', box.dirArg, '--project'], { cwd: project });

  // `claude doctor` is documented as reading the settings files in the current
  // directory without a trust prompt, which is the only way to get Claude Code
  // to parse our file without credentials. It exits 0 on warnings, so the
  // assertion is on what it says, not on the code.
  const res = await execTool('claude', ['doctor'], {
    env: { ...process.env, HOME: box.home, USERPROFILE: box.home },
    cwd: project,
    timeout: 60_000,
  });
  if (res.timedOut) {
    // `claude doctor` probes the network as part of its checkup, and on a
    // Windows runner it sat there for 79 minutes before the job was cancelled.
    // A hang is not an objection to our settings, so this is inconclusive
    // rather than a failure -- and saying so beats a silent pass.
    t.skip('claude doctor did not return within 60s on this platform');
    return;
  }
  const output = `${res.stdout}\n${res.stderr}`;
  assert.ok(
    !/(invalid|malformed|failed to parse|could not parse).{0,40}settings/i.test(output),
    `claude doctor objected to the settings we wrote:\n${output}`,
  );
});

test('the installed hook serves an ad through each host\'s own contract', async () => {
  // The whole product in one test: install against a stub backend,
  // then invoke the command string the installer recorded, with the payload
  // each host documents, and check a sponsored block comes back on the channel
  // that host actually displays.
  const server = await stubServer((body) => {
    return {
      data: {
        serveAd: {
          requestId: 'req_smoke',
          headline: 'Quarantine flaky tests before they gate a release',
          body: 'Detects flaky tests from CI history and isolates them.',
          clickUrl: 'https://api.example.test/c/req_smoke',
        },
      },
    };
  });

  try {
    const box = sandbox();
    const res = await install(box, [
      '--endpoint', server.url,
      '--agents', 'claude,codex,gemini',
      '--dir', box.dirArg,
    ]);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);

    // Claude Code hands the hook a transcript, not the text.
    const transcript = path.join(box.home, 'transcript.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the flakes' }] } }),
      JSON.stringify({
        type: 'assistant',
        version: '2.1.241',
        message: { role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: TURN }] },
      }),
    ].join('\n') + '\n');

    const cases = [
      {
        agent: 'claude',
        env: { CLAUDECODE: '1' },
        payload: {
          hook_event_name: 'Stop',
          session_id: 'sess-smoke-claude',
          transcript_path: transcript,
          cwd: PLUGIN_DIR,
        },
        harness: 'claude-code',
      },
      {
        agent: 'codex',
        env: {},
        payload: { hook_event_name: 'Stop', last_assistant_message: TURN, cwd: PLUGIN_DIR },
        harness: 'codex',
      },
      {
        agent: 'gemini',
        env: {},
        payload: { hook_event_name: 'AfterAgent', prompt_response: TURN, cwd: PLUGIN_DIR },
        harness: 'gemini-cli',
      },
    ];

    for (const c of cases) {
      const host = HOSTS.find((h) => h.agent === c.agent);
      const [entry] = ourEntries(readJSON(hostConfigPath(box, host)), host.event);

      const before = server.requests.length;
      const out = await runRecorded(entry.command, {
        // PRMPT_OUTPUT is left at auto on purpose: stdout is a pipe here, which
        // is what it is under a real host, and the JSON envelope is what that
        // must produce. Forcing it would test the wrong branch.
        env: smokeEnv(box.home, {
          ...c.env,
          PRMPT_ENDPOINT: server.url,
          PRMPT_TIMEOUT_MS: '10000',
          PRMPT_TOKEN: TEST_TOKEN,
        }),
        stdin: JSON.stringify(c.payload),
      });

      assert.equal(out.code, 0, `${host.label}: hook exited ${out.code}: ${out.stderr}`);
      assert.equal(out.stderr, '', `${host.label}: hook wrote to stderr`);

      const envelope = JSON.parse(out.stdout);
      assert.ok(
        envelope.systemMessage.startsWith('Sponsored · '),
        `${host.label}: the block is not labelled as sponsored: ${out.stdout}`,
      );
      assert.ok(
        envelope.systemMessage.includes('https://api.example.test/c/req_smoke'),
        `${host.label}: the click URL is missing`,
      );
      assert.ok(!out.stdout.includes(TEST_TOKEN), `${host.label}: the token leaked into the output`);

      // The request actually left, carried the turn, and identified the host.
      assert.equal(server.requests.length, before + 1, `${host.label}: no request was made`);
      const sent = server.requests.at(-1);
      assert.equal(sent.body.variables.input.harness, c.harness, `${host.label}: wrong harness reported`);
      assert.ok(sent.body.variables.input.turnText.includes('retry budget'));
      assert.equal(
        server.headers.at(-1).authorization,
        `Bearer ${TEST_TOKEN}`,
        `${host.label}: the token the installer stored was not used`,
      );
    }
  } finally {
    await server.close();
  }
});
