#!/usr/bin/env node
// prmpt -- the prompt-start hook.
//
// Wired to Claude Code's `UserPromptSubmit`, which fires the instant the user
// presses enter. It derives a handful of keywords from the prompt, hands them
// to a detached child to match against, and exits. The child parks whatever
// comes back in ~/.config/prmpt/slot.json, where hooks/statusline.mjs picks it
// up and renders it in the footer while the model works. That file has a second
// filler -- the ad hooks/turn-end.mjs parks -- so a fetch that misses leaves the
// last turn's ad on screen rather than blanking the row.
//
// Two rules govern this file, and both are absolute:
//
//   THE PROMPT NEVER LEAVES THE MACHINE. What goes over the wire is the output
//   of hooks/lib/tokens.mjs -- a sorted, de-duplicated bag of keywords with
//   code, paths, URLs and addresses stripped out first. README.md promises
//   users that their prompts are not sent, and that promise stays literally
//   true. There is a test that asserts a phrase from the prompt is nowhere in
//   the request body.
//
//   NOTHING BLOCKS. UserPromptSubmit sits between the user's keystroke and
//   their agent starting work, so every millisecond here is one they watch.
//   The network call happens in a detached child, exactly the way enrolment
//   and auto-update already do it.
//
// Like every other hook here: exit 0, write nothing, whatever happens.

import process from 'node:process';

import { loadConfig, detectRepo } from './lib/config.mjs';
import { signalTokens } from './lib/tokens.mjs';
import { fetchSlotInBackground, flushImpressionsInBackground } from './lib/background.mjs';

/** Exit cleanly with no output whatsoever. */
function quiet() {
  process.exit(0);
}

/**
 * Read all of stdin, with a ceiling so a pathological payload can't hang us.
 *
 * The deadline is tighter than the end-of-turn hook's because this one is
 * charged directly to the user's keystroke rather than to the tail of a turn.
 */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let out = '';
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(out);
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      out += chunk;
      if (out.length > 4 * 1024 * 1024) finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    const t = setTimeout(finish, 150);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Which host is running us, if it is one with a status line.
 *
 * Only Claude Code has this surface. Codex and Gemini CLI have no equivalent
 * footer at all, so fetching a decision under them would spend a request on an
 * ad that could never be displayed. CLAUDECODE=1 is set only by Claude Code;
 * PRMPT_HARNESS overrides for anyone running a fork that does have one.
 */
function statusLineHarness() {
  const forced = (process.env.PRMPT_HARNESS || '').trim();
  if (forced) return forced;
  return process.env.CLAUDECODE === '1' ? 'claude-code' : '';
}

/** The user's prompt, wherever this host put it. Never transmitted. */
function promptText(payload) {
  for (const candidate of [payload.prompt, payload.user_prompt, payload.message]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return '';
}

function main() {
  readStdin().then((raw) => {
    let payload = {};
    try {
      payload = raw && raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return quiet();
    }
    if (!payload || typeof payload !== 'object') return quiet();

    const config = loadConfig(payload);
    if (config.disabled) return quiet();

    // No token means no serving and no enrolment from here. Enrolment belongs
    // to the end-of-turn hook, which runs on the same turn: doing it in both
    // would race two `prmpt login` children against each other on first run.
    if (!config.token) return quiet();

    const harness = statusLineHarness();
    // A prompt of pure stopwords carries no signal. Asking anyway would spend a
    // request, and an embedding, on nothing.
    const tokens = harness ? signalTokens(promptText(payload)) : [];

    if (!harness || tokens.length === 0) {
      // Nothing to fetch, but anything already rendered is still owed to the
      // user, so report it on its own.
      flushImpressionsInBackground();
      return quiet();
    }

    const { repoLanguage, fileTypes } = detectRepo(config.cwd);

    // One child, not two: the fetch worker flushes the pending impressions as
    // well. Spawning a separate flush here would double the process cost of a
    // prompt and race two confirmations of the same batch against each other.
    fetchSlotInBackground(config, {
      installId: config.installId,
      sessionId: config.sessionId,
      surface: 'STATUS_LINE',
      signalTokens: tokens,
      repoLanguage,
      fileTypes,
      harness,
    });
    process.exit(0);
  }).catch(quiet);
}

// A late throw or rejection must still be silent.
process.on('uncaughtException', quiet);
process.on('unhandledRejection', quiet);

main();
