// prmpt -- the status-line slot.
//
// The end-of-turn hook already does the expensive thing: it ships the turn's
// text to the backend, which matches it and returns one ad. That decision is
// good for longer than the single line it prints, so this module parks it on
// disk and lets a second, much cheaper surface -- the host's status line --
// render it while the user reads the answer and types the next prompt.
//
// The point of routing the status line through a cache rather than through a
// request is that a status line is re-rendered constantly (Claude Code every
// few seconds, Codex on every redraw). Serving each of those would be a request
// storm against the backend, would blow the frequency caps, and would put a
// network round trip inside a redraw. Reading a small JSON file does not.
//
// It also keeps the matching contextual, which is the whole product: the ad on
// screen is the one chosen for the turn the user is looking at, not the next
// entry in a rotation.

import fs from 'node:fs';
import path from 'node:path';

import { configDir } from './config.mjs';

/**
 * How long a parked decision may still be shown.
 *
 * This is a relevance bound, not a cache bound. The ad was matched against one
 * particular turn; an hour later the session has moved on and showing it is
 * just a banner. Thirty minutes covers reading a long answer and thinking about
 * the next prompt, and expires well inside the backend's own decision cache.
 */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function slotPath() {
  return path.join(configDir(), 'slot.json');
}

function ttlMs() {
  const raw = Number.parseInt(process.env.PRMPT_SLOT_TTL_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * Park a decision for the status line to pick up.
 *
 * Never throws. This runs inside the turn hook, whose contract is that it
 * cannot disturb the session -- a read-only home or a full disk must cost the
 * status line its ad, not the user their turn.
 */
export function writeSlot(ad, { sessionId = '', harness = '' } = {}) {
  if (!ad || typeof ad !== 'object') return false;
  try {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = slotPath();
    const payload = {
      requestId: ad.requestId,
      headline: ad.headline,
      body: ad.body || '',
      clickUrl: ad.clickUrl,
      sessionId,
      harness,
      ts: Date.now(),
    };
    fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    // writeFileSync's mode only applies on create; force it for an existing file.
    fs.chmodSync(file, 0o600);
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
