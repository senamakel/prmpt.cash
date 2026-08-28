#!/usr/bin/env node
// prmpt -- the detached worker behind the status-line surface.
//
// Never run by a host. hooks/lib/background.mjs spawns it, detached and with
// its stdio thrown away, from hooks/prompt-start.mjs and hooks/turn-end.mjs.
// Both of those are on somebody's critical path; this is not, which is the
// whole point of it existing.
//
// It does at most two things:
//
//   1. asks for a STATUS_LINE decision and parks it in the session's slot;
//   2. reports the impressions the renderer has already drawn.
//
// It has no output. Nothing it can do is worth a line in a user's terminal,
// and by the time it runs there is no terminal to write to anyway.

import process from 'node:process';

import { loadConfig } from './lib/config.mjs';
import { confirmImpressions, serveAd } from './lib/api.mjs';
import { FILLER_PROMPT, dropPending, readPending, writeSlot } from './lib/slot.mjs';

function quiet() {
  process.exit(0);
}

/**
 * Hand the backend everything this install has rendered but not yet reported.
 *
 * The ids are dropped only on a confirmed success. A failed flush leaves them
 * on disk to be retried by the next turn, and the log is capped, so an install
 * that is offline for a week loses the oldest rather than growing forever.
 */
async function flush(config) {
  const pending = readPending();
  if (pending.length === 0) return;
  const accepted = await confirmImpressions(config, pending);
  if (accepted === null) return; // the backend never agreed; keep them
  dropPending(pending);
}

async function main() {
  let job = {};
  try {
    job = JSON.parse(process.env.PRMPT_SLOT_JOB || '{}');
  } catch {
    return quiet();
  }
  if (!job || typeof job !== 'object') return quiet();

  const config = loadConfig({});
  if (config.disabled || !config.token) return quiet();

  // A cold serve is 5-15s. Nothing is waiting on this, so let it finish rather
  // than abandoning it at the inline hook's 1.5s budget.
  if (typeof job.timeoutMs === 'number' && job.timeoutMs > 0) config.timeoutMs = job.timeoutMs;

  if (job.input && typeof job.input === 'object') {
    const ad = await serveAd(config, job.input);
    // A no-match writes nothing, which is also the fallback: whatever the last
    // turn parked stays in the slot and keeps rendering. Overwriting it with an
    // empty file would trade a slightly stale ad for no ad at all.
    //
    // Tagged as the prompt filler, because THIS is the one that owes an
    // impression: it was fetched for the status line and has not been billed
    // anywhere else.
    if (ad) {
      writeSlot(ad, {
        sessionId: job.sessionId ?? job.input.sessionId ?? '',
        harness: job.input.harness ?? '',
        filler: FILLER_PROMPT,
      });
    }
  }

  // Deliberately after the serve: the slot is time-sensitive and the flush is
  // not, and the flush must still happen on a job that carries no input at all.
  await flush(config);
  process.exit(0);
}

process.on('uncaughtException', quiet);
process.on('unhandledRejection', quiet);

main().catch(quiet);
