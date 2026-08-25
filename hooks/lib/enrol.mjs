// prmpt -- background self-enrolment.
//
// The hook has a 1.5s budget and, under Gemini CLI, runs synchronously inside
// the agent loop. Signing in costs two round trips against a cold backend, so
// it can never happen on the turn's own clock. Instead the first unauthenticated
// turn detaches a child that logs in and exits; the turn itself serves nothing,
// and every turn after it finds a token on disk.
//
// Everything here is best effort and silent, exactly like the hook it serves.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { configDir } from './config.mjs';

/** How long before a failed or crashed attempt is retried. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** Marker recording the last attempt, so a persistent failure retries slowly. */
function attemptMarkerPath() {
  return path.join(configDir(), '.enrol-attempt');
}

/**
 * May we try to enrol right now?
 *
 * Rate limited by a marker file rather than by anything in memory: each turn is
 * a fresh process, so without this an offline machine would spawn a child on
 * every single turn forever.
 */
function shouldAttempt() {
  // An explicit opt-out for anyone who does not want a key generated for them.
  if (process.env.PRMPT_NO_AUTO_ENROL === '1') return false;
  try {
    const stat = fs.statSync(attemptMarkerPath());
    return Date.now() - stat.mtimeMs > RETRY_AFTER_MS;
  } catch {
    return true;
  }
}

function markAttempt() {
  try {
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(attemptMarkerPath(), `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // A read-only home means we simply retry next turn. Not worth failing over.
  }
}

/**
 * Detach a child that runs `prmpt login`, and return immediately.
 *
 * `unref` plus detached plus 'ignore' stdio is what makes this genuinely
 * fire-and-forget: the hook can exit while the child is still mid-handshake,
 * and nothing the child writes can reach the user's session.
 */
export function enrolInBackground(endpoint) {
  if (!shouldAttempt()) return false;
  markAttempt();

  try {
    // fileURLToPath, not URL.pathname: on Windows the latter yields /C:/... and
    // percent-encodes spaces, neither of which is a path spawn can use.
    const here = path.dirname(fileURLToPath(import.meta.url));       // hooks/lib
    const cli = path.resolve(here, '..', '..', 'bin', 'prmpt.mjs');  // <root>/bin
    if (!fs.existsSync(cli)) return false;
    const child = spawn(process.execPath, [cli, 'login'], {
      detached: true,
      stdio: 'ignore',
      cwd: os.tmpdir(),
      env: { ...process.env, PRMPT_ENDPOINT: endpoint },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
