// prmpt -- handing the status line's network work to a detached child.
//
// Neither of the two hooks that touch the status-line surface may wait on the
// network. `UserPromptSubmit` blocks the user at the instant they press enter,
// and the status-line command itself is polled continuously by Claude Code,
// which watches it for slowness and flags a command that misbehaves. So both
// of them do exactly what self-enrolment and auto-update already do: spawn,
// unref, return.
//
// This is the same pattern as hooks/lib/enrol.mjs, and for the same reason.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readPending } from './slot.mjs';

/**
 * Off the turn's clock, a cold serve can be waited out.
 *
 * The 1.5s budget exists because the end-of-turn hook is inline. This one is
 * not, so it can afford the 5-15s a genuinely cold serve costs -- which is the
 * case the end-of-turn surface has always had to abandon.
 */
const DEFAULT_TIMEOUT_MS = 15000;

function workerPath() {
  // fileURLToPath, not URL.pathname: on Windows the latter yields /C:/... and
  // percent-encodes spaces, neither of which is a path spawn can use.
  const here = path.dirname(fileURLToPath(import.meta.url)); // hooks/lib
  return path.resolve(here, '..', 'slot-fetch.mjs');         // hooks/
}

/**
 * Start the worker with a job, and return immediately.
 *
 * The job travels in the ENVIRONMENT rather than in argv. Argv is world-readable
 * through `ps` on a shared machine, and the job carries keywords derived from
 * what the user just typed; /proc/<pid>/environ is readable only by the owner.
 * It is not stdin either: a detached parent that exits straight away cannot
 * guarantee a pipe write was ever flushed, and losing the job silently is worse
 * than the alternative.
 */
function startWorker(job) {
  try {
    const worker = workerPath();
    if (!fs.existsSync(worker)) return false;
    const child = spawn(process.execPath, [worker], {
      detached: true,
      stdio: 'ignore',
      cwd: os.tmpdir(),
      env: { ...process.env, PRMPT_SLOT_JOB: JSON.stringify(job) },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Fetch a status-line decision for this session, in the background. */
export function fetchSlotInBackground(config, input) {
  const timeoutMs = Number.parseInt(process.env.PRMPT_SLOT_TIMEOUT_MS ?? '', 10);
  return startWorker({
    input,
    sessionId: input.sessionId,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  });
}

/**
 * Report rendered impressions, in the background.
 *
 * Gated on there being something to report: this runs on every single turn, and
 * spawning a process to discover an empty file would be a cost paid forever by
 * the overwhelming majority of installs, which never see a status-line ad.
 */
export function flushImpressionsInBackground() {
  if (readPending().length === 0) return false;
  return startWorker({});
}
