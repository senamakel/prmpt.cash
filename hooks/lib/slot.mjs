// prmpt -- the status-line slot and the pending-impression log.
//
// The status-line surface splits one ad into two processes that never talk to
// each other:
//
//   hooks/prompt-start.mjs  fetches a decision in a detached child and leaves
//                           it in slot-<session>.json
//   hooks/status-line.mjs   reads that file and renders it, many times a second,
//                           with NO network access of any kind
//
// So the file is the whole interface, and every rule about it exists to keep
// the render path cheap and the billing honest.
//
// Two invariants are worth stating out loud:
//
//   - A slot expires. The decision was fetched for the turn that is running
//     now; showing it an hour later would be an impression the advertiser did
//     not buy and a line the user did not earn.
//   - An impression is claimed EXACTLY once. Claude Code re-renders the status
//     line continuously while the model works, so the naive "append on render"
//     would bill one decision hundreds of times. `claimImpression` is a
//     compare-and-set through an atomic rename, and it is the only thing
//     allowed to append to the pending log.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { configDir } from './config.mjs';

/** How long a fetched decision stays renderable. */
const SLOT_TTL_MS = 15 * 60 * 1000;

/**
 * How many un-confirmed impressions we are willing to hold.
 *
 * An install that is offline for a week must not turn this into an unbounded
 * file. The newest are kept: a stale impression is worth less than a fresh
 * one, and trimming the head would mean forever retrying the same dead batch.
 */
export const MAX_PENDING = 500;

/** Above this many bytes the log is rewritten on append rather than extended. */
const TRIM_AFTER_BYTES = 128 * 1024;

function pendingPath() {
  return path.join(configDir(), 'pending.jsonl');
}

/**
 * A session id, made safe to use as a filename.
 *
 * The id comes from the host, so it is untrusted input that we are about to
 * paste into a path. Anything that is not plainly a filename is replaced by a
 * hash of itself, which is both safe and still one-to-one.
 */
function slotKey(sessionId) {
  const s = typeof sessionId === 'string' ? sessionId : '';
  if (/^[A-Za-z0-9._-]{1,64}$/.test(s) && s !== '.' && s !== '..') return s;
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

export function slotPath(sessionId) {
  return path.join(configDir(), `slot-${slotKey(sessionId)}.json`);
}

/** Write JSON at 0600 by rename, so a reader never sees a half-written file. */
function writeAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Park a decision for this session's status line to pick up. */
export function writeSlot(sessionId, ad) {
  try {
    writeAtomic(slotPath(sessionId), {
      requestId: ad.requestId,
      headline: ad.headline,
      body: ad.body ?? '',
      clickUrl: ad.clickUrl,
      createdAt: new Date().toISOString(),
    });
    return true;
  } catch {
    // A read-only home means no status-line ad. Not worth failing a turn over.
    return false;
  }
}

/**
 * The decision waiting for this session, or null.
 *
 * Null covers every failure there is -- absent, unreadable, corrupt, expired --
 * because the caller renders a status line and has no way to report any of them.
 */
export function readSlot(sessionId) {
  const file = slotPath(sessionId);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > SLOT_TTL_MS) return null;
    const slot = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!slot || typeof slot !== 'object') return null;
    if (typeof slot.requestId !== 'string' || !slot.requestId) return null;
    if (typeof slot.headline !== 'string' || !slot.headline) return null;
    return slot;
  } catch {
    return null;
  }
}

/**
 * Claim the single billable impression for this requestId.
 *
 * Returns true exactly once per decision: the first caller records the claim in
 * the slot file and appends to the pending log; every later caller gets false.
 *
 * The claim is written by rename, which is atomic, so two renders racing each
 * other cannot both observe an unclaimed slot AND both leave it claimed with
 * two pending lines -- the second rename overwrites the first, and the append
 * happens only on the path that observed `impressedAt` absent.
 */
export function claimImpression(sessionId, requestId) {
  const slot = readSlot(sessionId);
  if (!slot || slot.requestId !== requestId) return false;
  if (slot.impressedAt) return false;
  try {
    writeAtomic(slotPath(sessionId), { ...slot, impressedAt: new Date().toISOString() });
  } catch {
    // If the claim cannot be recorded, do NOT bill: a claim we cannot remember
    // making is one we would make again on the very next render.
    return false;
  }
  appendPending(requestId);
  return true;
}

// --- the pending log --------------------------------------------------------

/** Record that `requestId` was rendered and is owed a confirmImpressions call. */
export function appendPending(requestId) {
  const file = pendingPath();
  const line = `${JSON.stringify({ requestId, at: new Date().toISOString() })}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* first write */ }
    if (size > TRIM_AFTER_BYTES) {
      // Only pay for a rewrite once the file is genuinely large. Every other
      // append is O(1) and stays off the render path's critical section.
      const kept = readPending().slice(-(MAX_PENDING - 1));
      writePending([...kept, requestId]);
      return true;
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Every requestId still awaiting confirmation, oldest first. */
export function readPending() {
  let raw;
  try {
    raw = fs.readFileSync(pendingPath(), 'utf8');
  } catch {
    return [];
  }
  const ids = [];
  const seen = new Set();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn or hand-edited line is skipped, never fatal
    }
    const id = entry?.requestId;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.slice(-MAX_PENDING);
}

function writePending(ids) {
  const file = pendingPath();
  const at = new Date().toISOString();
  if (ids.length === 0) {
    try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    return;
  }
  const body = ids.map((requestId) => `${JSON.stringify({ requestId, at })}\n`).join('');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Forget the ids the backend has now confirmed. Anything else is kept. */
export function dropPending(requestIds) {
  const done = new Set(requestIds);
  try {
    const kept = readPending().filter((id) => !done.has(id));
    writePending(kept);
    return true;
  } catch {
    return false;
  }
}
