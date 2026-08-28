// Which status-line ads are billed, and how many times.
//
// The slot has two fillers and only one of them owes an impression:
//
//   turn-end  the ad the end-of-turn request already served AND already
//             billed. Re-displayed from disk, costing nothing and earning
//             nothing. Billing it here would charge the advertiser twice for
//             one decision -- silently, and visible only as inflated spend.
//   prompt    a decision fetched for THIS surface by hooks/slot-fetch.mjs. It
//             has been billed nowhere, so the first render owes exactly one
//             impression and every render after it owes none.
//
// Claude Code re-runs the status-line command continuously while the model
// works, so "exactly once" is not a formality: the naive version bills one
// decision hundreds of times in a single turn.
//
// The renderer cannot report anything itself -- it may not touch the network --
// so what it does is append to pending.jsonl. That file IS the bill, and it is
// what these tests read.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { baseEnv, configDirOf, runStatusLine, tmpDir } from './helpers.mjs';

const SESSION = 'sess-billing';

const AD = {
  requestId: 'req_bill_1',
  headline: 'Quarantine flaky tests automatically',
  body: 'Detects flakes from CI history.',
  clickUrl: 'https://ads.example/c/req_bill_1',
};

/** A sandbox HOME with one slot parked by the named filler. */
function parked(filler, over = {}) {
  const home = tmpDir('prmpt-bill-home-');
  const dir = configDirOf(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, 'slot.json'),
    `${JSON.stringify({ ...AD, sessionId: SESSION, harness: 'claude-code', filler, ts: Date.now(), ...over })}\n`,
    { mode: 0o600 },
  );
  return { home, pending: path.join(dir, 'pending.jsonl') };
}

/** Draw the status line the way Claude Code does, `times` over. */
async function draw(home, times = 1) {
  const rendered = [];
  for (let i = 0; i < times; i++) {
    const res = await runStatusLine({
      stdin: JSON.stringify({ session_id: SESSION, model: { display_name: 'Opus' } }),
      env: baseEnv({ HOME: home, CLAUDECODE: '1' }),
    });
    assert.equal(res.code, 0, `render ${i} exited ${res.code}: ${res.stderr}`);
    assert.equal(res.stderr, '', `render ${i} wrote to stderr`);
    rendered.push(res.stdout);
  }
  return rendered;
}

/** Every requestId the renderer has queued for confirmImpressions. */
function billed(pending) {
  if (!fs.existsSync(pending)) return [];
  return fs
    .readFileSync(pending, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).requestId);
}

test('a parked turn-end ad is rendered but never billed as a status-line impression', async () => {
  // The whole point of the parked filler: it costs nothing and it is free. The
  // end-of-turn request already paid for this decision.
  const { home, pending } = parked('turn-end');

  const rendered = await draw(home, 5);
  for (const [i, out] of rendered.entries()) {
    assert.ok(out.includes('Sponsored'), `render ${i} drew nothing -- the fallback must still show`);
  }

  assert.deepEqual(
    billed(pending),
    [],
    'a parked ad was billed a second time on the status line',
  );
});

test('a prompt-fetched ad is billed exactly once, however many times it is drawn', async () => {
  const { home, pending } = parked('prompt');

  const rendered = await draw(home, 5);
  for (const [i, out] of rendered.entries()) {
    assert.ok(out.includes('Sponsored'), `render ${i} drew nothing`);
  }

  assert.deepEqual(
    billed(pending),
    [AD.requestId],
    'five renders of one decision did not bill exactly one impression',
  );
});

test('a slot with no filler recorded is treated as parked, and is not billed', async () => {
  // Every slot.json written before this field existed was a turn-end park --
  // that was the only filler there was. Guessing the other way would bill an
  // upgrade for ads it had already been paid for.
  const { home, pending } = parked('turn-end');
  const file = path.join(configDirOf(home), 'slot.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.filler;
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });

  const [out] = await draw(home);
  assert.ok(out.includes('Sponsored'), 'an older slot stopped rendering');
  assert.deepEqual(billed(pending), [], 'a slot from before fillers existed was billed');
});

test('a prompt-fetched ad that was not drawn is not billed', async () => {
  // Single-row mode with a status line of the user's own: theirs wins and ours
  // is never drawn. An advertiser must not pay for a row nobody saw.
  const { home, pending } = parked('prompt');
  const chain = path.join(home, 'mine.mjs');
  fs.writeFileSync(chain, "process.stdout.write('my own status line');\n");
  fs.writeFileSync(
    path.join(configDirOf(home), 'statusline-chain-claude.json'),
    JSON.stringify({ type: 'command', command: `"${process.execPath}" "${chain}"` }),
  );

  const res = await runStatusLine({
    args: ['--line'],
    stdin: JSON.stringify({ session_id: SESSION }),
    env: baseEnv({ HOME: home, CLAUDECODE: '1' }),
  });
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trimEnd(), 'my own status line');
  assert.deepEqual(billed(pending), [], 'an ad that was never drawn was billed');
});

test('a fresher prompt fetch replaces a parked ad and brings its own bill', async () => {
  // The two fillers write the same file, so this is the ordinary sequence: a
  // turn ends and parks, the user types, the fetch lands and takes the slot.
  // Only the second one is owed.
  const { home, pending } = parked('turn-end');
  await draw(home, 2);
  assert.deepEqual(billed(pending), [], 'the parked ad was billed before the fetch even landed');

  const file = path.join(configDirOf(home), 'slot.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...AD,
      requestId: 'req_bill_fresh',
      headline: 'Fresher, matched to the prompt',
      clickUrl: 'https://ads.example/c/req_bill_fresh',
      sessionId: SESSION,
      filler: 'prompt',
      ts: Date.now(),
    }),
    { mode: 0o600 },
  );

  await draw(home, 3);
  assert.deepEqual(billed(pending), ['req_bill_fresh'], 'the wrong set of ads was billed');
});
