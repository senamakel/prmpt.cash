// The status-line slot, and the pending-impression log.
//
// Two files under ~/.config/prmpt, both written 0600, and the rules that make
// them safe to touch from the render path:
//
//   slot.json       one decision, waiting to be rendered, from either filler
//   pending.jsonl   requestIds that HAVE been rendered and are owed a
//                   confirmImpressions call
//
// Billing hangs off the second one, so "written exactly once per requestId, and
// only for a decision that owes an impression" is the assertion that matters
// most in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FILLER_PROMPT,
  FILLER_TURN_END,
  MAX_PENDING,
  appendPending,
  claimImpression,
  clearSlot,
  dropPending,
  readPending,
  readSlot,
  slotPath,
  writeSlot,
} from '../hooks/lib/slot.mjs';

/** Point XDG_CONFIG_HOME at a throwaway directory for the duration of a test. */
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-slot-'));
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  t.after(() => {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const AD = {
  requestId: 'req_slot_1',
  headline: 'Ship faster with Widget CI',
  body: 'Parallel test sharding.',
  clickUrl: 'https://ads.example/c/req_slot_1',
};

// --- the slot ---------------------------------------------------------------

test('a slot round-trips through the file', (t) => {
  sandbox(t);
  writeSlot(AD, { sessionId: 'sess-a' });
  const slot = readSlot({ sessionId: 'sess-a' });
  assert.equal(slot.requestId, AD.requestId);
  assert.equal(slot.headline, AD.headline);
  assert.equal(slot.clickUrl, AD.clickUrl);
});

test('the slot file is 0600 inside a 0700 directory', { skip: process.platform === 'win32' && 'POSIX modes' }, (t) => {
  const dir = sandbox(t);
  writeSlot(AD, { sessionId: 'sess-a' });
  assert.equal(fs.statSync(slotPath()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'prmpt')).mode & 0o777, 0o700);
});

test('a slot from another session is not served', (t) => {
  sandbox(t);
  writeSlot(AD, { sessionId: 'sess-a' });
  assert.equal(readSlot({ sessionId: 'sess-b' }), null);
  assert.equal(readSlot({ sessionId: 'sess-a' }).requestId, AD.requestId);
  // A host that gives us no session id gets whatever is current, which is the
  // best available answer rather than nothing.
  assert.equal(readSlot({}).requestId, AD.requestId);
});

test('the fresher filler takes the slot, and a miss leaves the parked ad alone', (t) => {
  sandbox(t);
  writeSlot(AD, { sessionId: 'sess-a', filler: FILLER_TURN_END });
  writeSlot({ ...AD, requestId: 'req_fresh', headline: 'Fresher' }, {
    sessionId: 'sess-a',
    filler: FILLER_PROMPT,
  });
  assert.equal(readSlot({ sessionId: 'sess-a' }).requestId, 'req_fresh');

  // A fetch that matched nothing writes nothing at all, which is exactly the
  // fallback: whatever is parked keeps rendering.
  writeSlot(null, { sessionId: 'sess-a', filler: FILLER_PROMPT });
  assert.equal(readSlot({ sessionId: 'sess-a' }).requestId, 'req_fresh');
});

test('an entry written before fillers existed reads as a parked turn-end ad', (t) => {
  sandbox(t);
  writeSlot(AD, { sessionId: 'sess-a' });
  const raw = JSON.parse(fs.readFileSync(slotPath(), 'utf8'));
  delete raw.filler;
  fs.writeFileSync(slotPath(), JSON.stringify(raw));
  assert.equal(readSlot({ sessionId: 'sess-a' }).filler, FILLER_TURN_END);
});

test('a missing, empty or corrupt slot reads as null rather than throwing', (t) => {
  sandbox(t);
  assert.equal(readSlot({}), null);
  writeSlot(AD, { sessionId: 'sess-a' });
  fs.writeFileSync(slotPath(), '{ not json');
  assert.equal(readSlot({}), null);
});

test('a stale slot is not served', (t) => {
  sandbox(t);
  writeSlot(AD, { sessionId: 'sess-old' });
  const now = Date.now() + 60 * 60 * 1000;
  assert.equal(readSlot({ sessionId: 'sess-old', now }), null, 'an hour-old slot was still served');
});

test('clearSlot forgets the parked decision', (t) => {
  sandbox(t);
  writeSlot(AD, { sessionId: 'sess-a' });
  clearSlot();
  assert.equal(readSlot({}), null);
});

// --- the impression claim ---------------------------------------------------

test('the first render claims the impression and the second does not', (t) => {
  sandbox(t);
  writeSlot(AD, { sessionId: 'sess-a', filler: FILLER_PROMPT });
  assert.equal(claimImpression(AD.requestId, { sessionId: 'sess-a' }), true, 'first render did not claim');
  assert.equal(claimImpression(AD.requestId, { sessionId: 'sess-a' }), false, 'second render claimed again');
  assert.equal(claimImpression(AD.requestId, { sessionId: 'sess-a' }), false, 'third render claimed again');
  assert.deepEqual(readPending(), [AD.requestId]);
});

test('claiming an impression for a requestId the slot does not hold is refused', (t) => {
  sandbox(t);
  writeSlot(AD, { sessionId: 'sess-a', filler: FILLER_PROMPT });
  assert.equal(claimImpression('req_somebody_else', { sessionId: 'sess-a' }), false);
  assert.deepEqual(readPending(), []);
});

// --- the pending log --------------------------------------------------------

test('pending markers append and read back in order', (t) => {
  sandbox(t);
  appendPending('req_1');
  appendPending('req_2');
  assert.deepEqual(readPending(), ['req_1', 'req_2']);
});

test('the pending log is 0600', { skip: process.platform === 'win32' && 'POSIX modes' }, (t) => {
  const dir = sandbox(t);
  appendPending('req_1');
  assert.equal(fs.statSync(path.join(dir, 'prmpt', 'pending.jsonl')).mode & 0o777, 0o600);
});

test('flushed ids are dropped and the rest survive', (t) => {
  sandbox(t);
  for (const id of ['req_1', 'req_2', 'req_3']) appendPending(id);
  dropPending(['req_1', 'req_3']);
  assert.deepEqual(readPending(), ['req_2']);
});

test('dropping everything leaves no file behind', (t) => {
  const dir = sandbox(t);
  appendPending('req_1');
  dropPending(['req_1']);
  assert.deepEqual(readPending(), []);
  assert.ok(!fs.existsSync(path.join(dir, 'prmpt', 'pending.jsonl')));
});

test('a long-offline install cannot grow the log without bound', (t) => {
  sandbox(t);
  for (let i = 0; i < MAX_PENDING * 3; i++) appendPending(`req_${i}`);
  const pending = readPending();
  assert.ok(pending.length <= MAX_PENDING, `log grew to ${pending.length}`);
  // The NEWEST are the ones kept: an old impression the backend never heard
  // about is worth less than a recent one, and dropping the tail would keep
  // retrying the same dead batch forever.
  assert.equal(pending.at(-1), `req_${MAX_PENDING * 3 - 1}`);
});

test('a corrupt line is skipped, not fatal', (t) => {
  const dir = sandbox(t);
  appendPending('req_good');
  const file = path.join(dir, 'prmpt', 'pending.jsonl');
  fs.appendFileSync(file, 'this is not json\n');
  appendPending('req_also_good');
  assert.deepEqual(readPending(), ['req_good', 'req_also_good']);
});

test('reading a pending log that was never written is empty, not an error', (t) => {
  sandbox(t);
  assert.deepEqual(readPending(), []);
  dropPending(['req_nothing']);
});
