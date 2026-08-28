#!/usr/bin/env node
// prmpt -- the status-line renderer.
//
// Wired to Claude Code's `statusLine` setting and Codex's `[tui] status_line`.
// Both call an external command on every redraw and use its stdout, so the
// entire job here is: read a small JSON file, print one line, exit.
//
// There is deliberately NO network call on this path. A status line is
// re-rendered every few seconds for as long as the session is open; putting a
// request in it would hammer the backend, blow the frequency caps and put
// latency inside a redraw. The ad shown is the one the end-of-turn hook already
// matched for this session and parked in the slot.
//
// Same fail-open contract as the turn hook, and for a sharper reason: whatever
// this writes to stdout IS the user's status line. A stack trace here would be
// pinned above their prompt for the rest of the session. Every failure path
// ends in exit 0 having printed the chained status line, or nothing.

import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import { claimImpression, readSlot } from './lib/slot.mjs';
import { isOurCommand, readChain } from './lib/statusline-install.mjs';
import { composeStatusLineParts } from './lib/statusline-render.mjs';

/** How long a chained status-line command may take before we give up on it. */
const CHAIN_TIMEOUT_MS = 1200;

/** Read stdin without blocking: the host has already written and closed it. */
function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Run the status line that was configured before ours and return its stdout.
 *
 * Chaining rather than replacing is the difference between a plugin that adds a
 * row and one that silently deletes whatever the user had configured. It gets
 * the same stdin we did, because that is the contract its author wrote against.
 */
function runChain(chain, stdin) {
  try {
    // Refuse our own script. A re-install that recorded us as the thing to
    // chain would otherwise fork a new copy of this process on every single
    // render, forever, which is a fork bomb wearing a status line.
    if (chain && isOurCommand(chain.command)) return '';
    if (chain && Array.isArray(chain.argv) && chain.argv.length) {
      const r = spawnSync(chain.argv[0], chain.argv.slice(1), {
        input: stdin,
        timeout: CHAIN_TIMEOUT_MS,
        encoding: 'utf8',
      });
      return (r.stdout || '').replace(/\s+$/, '');
    }
    if (chain && typeof chain.command === 'string' && chain.command.trim()) {
      const r = spawnSync(chain.command, {
        shell: true,
        input: stdin,
        timeout: CHAIN_TIMEOUT_MS,
        encoding: 'utf8',
      });
      return (r.stdout || '').replace(/\s+$/, '');
    }
  } catch {
    // A chained command that is broken or missing is the user's problem to
    // notice, not a reason for our line to disappear too.
  }
  return '';
}

/**
 * Terminal width.
 *
 * Claude Code and Codex both run the status-line command with stdout piped, so
 * process.stdout.columns is undefined here and COLUMNS is usually unset. 80 is
 * the safe floor: budgeting for a narrower line than the terminal has costs a
 * few characters of copy, while budgeting for a wider one wraps the prompt.
 */
function columns() {
  const env = Number.parseInt(process.env.COLUMNS ?? '', 10);
  if (Number.isFinite(env) && env > 20) return env;
  if (Number.isFinite(process.stdout.columns) && process.stdout.columns > 20) {
    return process.stdout.columns;
  }
  return 80;
}

function main() {
  if (process.env.PRMPT_DISABLED === '1') {
    // Still honour the chain: opting out of ads is not opting out of the status
    // line the user configured themselves.
    const stdin = readStdin();
    const chained = runChain(readChain(), stdin);
    if (chained) process.stdout.write(`${chained}\n`);
    return process.exit(0);
  }

  const stdin = readStdin();

  let sessionId = '';
  try {
    const payload = JSON.parse(stdin);
    if (payload && typeof payload === 'object') {
      const direct = payload.session_id ?? payload.sessionId;
      if (typeof direct === 'string') sessionId = direct;
    }
  } catch {
    // Codex passes nothing at all on stdin. Not an error.
  }

  // Codex renders only the first line of the command's output, so it gets the
  // 'line' mode where a chained status line takes the single row it has.
  const mode = process.env.PRMPT_STATUSLINE_MODE
    || (process.argv.includes('--line') ? 'line' : 'card');

  const ad = readSlot({ sessionId });
  const chained = runChain(readChain(), stdin);

  const { text, adRendered } = composeStatusLineParts({
    ad,
    chained,
    mode,
    columns: columns(),
    color: !process.env.NO_COLOR,
  });

  if (text) process.stdout.write(`${text}\n`);

  // Only once the ad is genuinely going out, and only after it has been
  // written: claiming is a compare-and-set on the slot file, and it is what
  // appends to the pending log the next hook flushes to the backend.
  if (adRendered && ad) claimImpression(ad.requestId, { sessionId });

  process.exit(0);
}

// A status line must never print a stack trace above someone's prompt.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

main();
