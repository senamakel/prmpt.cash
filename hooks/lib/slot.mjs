// prmpt -- the status-line slot, and the pending-impression log.
//
// One file, ~/.config/prmpt/slot.json, holds at most one decision waiting to be
// drawn. It has TWO fillers, which is the whole shape of this module:
//
//   hooks/turn-end.mjs    parks the ad it has ALREADY served and billed at the
//                         end of a turn. Costs nothing extra, sends nothing
//                         extra, and is the fallback whenever the other filler
//                         has not produced anything.
//   hooks/slot-fetch.mjs  parks a decision fetched for THIS surface, from
//                         keywords derived from the prompt the user just typed.
//                         Fresher, and it is a real impression of its own.
//
// Whichever wrote last is what renders: a prompt-fetched decision lands after
// the parked one and takes its place, and a fetch that misses or times out
// writes nothing at all, so the parked ad is still there to fall back to.
//
// The reader is hooks/statusline.mjs, which is called on every redraw and makes
// NO network call of any kind. Reading a small JSON file does not blow the
// frequency caps, does not put a round trip inside a redraw, and does not get
// the user's whole footer flagged as unhealthy. That is why the file exists.
//
// Two invariants are worth stating out loud:
//
//   - A slot expires. The decision was matched against one particular turn; an
//     hour later the session has moved on and showing it is just a banner.
//   - An impression is claimed EXACTLY once, and only for the filler that owes
//     one. `claimImpression` is a compare-and-set through an atomic rename, and
//     it is the only thing allowed to append to the pending log.

import fs from 'node:fs';
import path from 'node:path';

import { configDir } from './config.mjs';

/**
 * How long a parked decision may still be shown.
 *
 * This is a relevance bound, not a cache bound. Thirty minutes covers reading a
 * long answer and thinking about the next prompt, and expires well inside the
 * backend's own decision cache. vscode/src/slot.ts mirrors this constant; the
 * two are not to be tuned independently.
 */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Which of the two fillers put this decision in the slot. */
export const FILLER_TURN_END = 'turn-end';
export const FILLER_PROMPT = 'prompt';

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

export function slotPath() {
  return path.join(configDir(), 'slot.json');
}

function pendingPath() {
  return path.join(configDir(), 'pending.jsonl');
}

function ttlMs() {
  const raw = Number.parseInt(process.env.PRMPT_SLOT_TTL_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * Write JSON at 0600 by rename, so a reader never sees a half-written file.
 *
 * The renderer reads this on every redraw and the editor extension watches the
 * directory for changes, so a torn read is not a theoretical concern.
 */
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * Park a decision for the status line to pick up.
 *
 * Never throws. Both callers are on somebody's critical path -- one inside the
 * turn hook, one in a detached worker -- and a read-only home or a full disk
 * must cost the status line its ad, not the user their turn.
 */
export function writeSlot(ad, { sessionId = '', harness = '', filler = FILLER_TURN_END } = {}) {
  if (!ad || typeof ad !== 'object') return false;
  try {
    writeAtomic(slotPath(), {
      requestId: ad.requestId,
      headline: ad.headline,
      body: ad.body || '',
      clickUrl: ad.clickUrl,
      sessionId,
      harness,
      filler,
      ts: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The parked decision, or null when there is none, it is malformed, or it has
 * aged past the TTL.
 *
 * `sessionId`, when given, additionally scopes the slot to one session: a
 * status line in a second terminal must not display the ad matched for a turn
 * the user took somewhere else. Hosts that give us no session id (Codex) pass
 * nothing and get whatever is current, which is the best available answer.
 */
export function readSlot({ sessionId = '', now = Date.now() } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(slotPath(), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.headline !== 'string' || !parsed.headline.trim()) return null;
  if (typeof parsed.clickUrl !== 'string' || !parsed.clickUrl.trim()) return null;
  if (typeof parsed.ts !== 'number' || now - parsed.ts > ttlMs()) return null;
  if (sessionId && parsed.sessionId && parsed.sessionId !== sessionId) return null;

  return {
    requestId: typeof parsed.requestId === 'string' ? parsed.requestId : '',
    headline: parsed.headline.trim(),
    body: typeof parsed.body === 'string' ? parsed.body.trim() : '',
    clickUrl: parsed.clickUrl.trim(),
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
    harness: typeof parsed.harness === 'string' ? parsed.harness : '',
    // An entry written before this field existed is a parked turn-end ad: that
    // was the only filler there was.
    filler: typeof parsed.filler === 'string' && parsed.filler ? parsed.filler : FILLER_TURN_END,
    impressedAt: typeof parsed.impressedAt === 'string' ? parsed.impressedAt : '',
    ts: parsed.ts,
  };
}

/** Forget the parked decision. Used by `prmpt statusline uninstall`. */
export function clearSlot() {
  try {
    fs.rmSync(slotPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

// --- the impression claim ---------------------------------------------------

/**
 * Claim the single billable impression for this requestId.
 *
 * Returns true exactly once per decision: the first caller records the claim in
 * the slot file and appends to the pending log; every later caller gets false.
 * Claude Code re-renders the status line continuously while the model works, so
 * the naive "append on render" would bill one decision hundreds of times.
 *
 * The claim is written by rename, which is atomic, so two renders racing each
 * other cannot both observe an unclaimed slot AND both leave it claimed with
 * two pending lines -- the second rename overwrites the first, and the append
 * happens only on the path that observed `impressedAt` absent.
 */
export function claimImpression(requestId, { sessionId = '' } = {}) {
  const slot = readSlot({ sessionId });
  if (!slot || !requestId || slot.requestId !== requestId) return false;
  if (slot.impressedAt) return false;
  try {
    writeAtomic(slotPath(), {
      requestId: slot.requestId,
      headline: slot.headline,
      body: slot.body,
      clickUrl: slot.clickUrl,
      sessionId: slot.sessionId,
      harness: slot.harness,
      filler: slot.filler,
      ts: slot.ts,
      impressedAt: new Date().toISOString(),
    });
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
