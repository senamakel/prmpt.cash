// prmpt -- keeping itself current, in the background.
//
// The plugin auto-applies releases by default. That is a real decision about
// somebody else's machine, so the constraints it works under are worth stating:
//
//   - never on the turn's clock. Same reasoning as self-enrolment: a download
//     is orders of magnitude over the 1.5s budget, and under Gemini CLI that
//     time is charged to the user's turn. It detaches and returns.
//   - never more than once a day, tracked on disk, because every turn is a
//     fresh process with no memory of the last one.
//   - never in a git checkout. update.mjs refuses, but the check is cheap here
//     too and saves spawning a child that can only fail.
//   - never silently in the failure direction: the child either swaps in a
//     verified tarball or leaves the install exactly as it was.
//
// PRMPT_NO_AUTO_UPDATE=1 opts out entirely; PRMPT_DISABLED=1 already does.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { configDir } from './config.mjs';
import { pluginRoot } from './version.mjs';

/** One check a day. Releases are not frequent enough to warrant more. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function markerPath() {
  return path.join(configDir(), '.update-check');
}

/** Has a day passed since the last attempt? */
function due() {
  try {
    return Date.now() - fs.statSync(markerPath()).mtimeMs > CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

function mark() {
  try {
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPath(), `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // Read-only home: we simply re-check next turn rather than never.
  }
}

/**
 * Detach a child that updates this install, if one is due.
 *
 * Returns true when a child was spawned. The caller must not await anything:
 * the whole point is that the turn continues while this happens.
 */
export function autoUpdateInBackground({ root = pluginRoot(), env = process.env } = {}) {
  if (env.PRMPT_NO_AUTO_UPDATE === '1') return false;
  // A checkout is somebody's working tree. Never.
  if (fs.existsSync(path.join(root, '.git'))) return false;
  if (!due()) return false;
  mark();

  try {
    const cli = path.join(root, 'bin', 'prmpt.mjs');
    if (!fs.existsSync(cli)) return false;
    const child = spawn(process.execPath, [cli, 'update', '--quiet'], {
      detached: true,
      stdio: 'ignore',
      // Not inside the directory about to be renamed.
      cwd: os.tmpdir(),
      env: { ...env },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
