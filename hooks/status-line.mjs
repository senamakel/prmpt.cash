#!/usr/bin/env node
// prmpt -- the status-line command.
//
// Wired to Claude Code's `statusLine` setting, which is the footer that renders
// continuously underneath the conversation, including while the model is
// working. It is the second of the plugin's two ad surfaces; the first is
// hooks/turn-end.mjs, which prints once when a turn finishes.
//
// Claude Code re-runs this command constantly and watches it for slowness, so
// the rules here are stricter than anywhere else in the plugin:
//
//   NO NETWORK. Not a request, not a DNS lookup, not a token read. The decision
//   was fetched by hooks/prompt-start.mjs in a detached child and left in
//   ~/.config/prmpt/slot-<session>.json; all this does is read that file. A
//   status-line command that touches the network gets the user's whole footer
//   flagged as unhealthy, and deservedly so.
//
//   NEVER EAT SOMEBODY'S STATUS LINE. Most people who will install this already
//   have one. The installer records theirs and this runs it, keeps its output
//   as the prefix, and appends a segment after it. If there is no room for our
//   segment, theirs wins and we print nothing -- silently replacing a status
//   line somebody built is the fastest way to be uninstalled.
//
// The impression is billed HERE, on the first render, because that is the first
// moment the ad has actually been shown to anybody. It is recorded to
// pending.jsonl and reported later by a detached child; nothing on this path
// waits for anything.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { configDir } from './lib/config.mjs';
import { claimImpression, readSlot } from './lib/slot.mjs';

/**
 * The most characters our segment may occupy.
 *
 * The footer is rendered dimmed and truncated, so a long segment does not wrap
 * -- it disappears off the right-hand edge, taking the link with it. Sixty is
 * the ceiling; the useful range is more like thirty to forty, which is what the
 * backend is asked to write to.
 */
const MAX_AD_CHARS = 60;

/** Below this there is no room for a legible ad, so we yield the line. */
const MIN_AD_CHARS = 24;

/** What separates the user's status line from ours. */
const SEPARATOR = '  ';

/** How long the wrapped command may take before we give up on it. */
const DEFAULT_WRAP_MS = 2000;

function quiet() {
  process.exit(0);
}

/** Read all of stdin, with a short ceiling: this runs on the render path. */
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
      if (out.length > 1024 * 1024) finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    const t = setTimeout(finish, 150);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** What a human actually sees, with the escape sequences taken out. */
function visibleLength(s) {
  return s
    .replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .length;
}

/** Collapse to one line and clip to `max` characters on a word boundary. */
function clip(s, max) {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Strip anything that could steer the terminal rather than print in it.
 *
 * The headline is written by a model, server-side, and lands unescaped in the
 * user's footer. An escape sequence in it would be able to move the cursor,
 * repaint the screen or hide what it did. Text only.
 */
function plainText(s) {
  return s.replace(/[\x00-\x1f\x7f]/g, ' ');
}

/**
 * Is this a URL we are willing to hand a terminal as a hyperlink target?
 *
 * Same reasoning as above, one step further: the URL goes inside an OSC 8
 * escape, so a control character in it would terminate the sequence early and
 * write whatever followed straight to the screen.
 */
function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\/[^\s\x00-\x1f\x7f]+$/.test(url);
}

/** The command the installer displaced, if there was one. */
function wrappedCommand() {
  try {
    const raw = fs.readFileSync(path.join(configDir(), 'statusline.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const command = parsed?.wrapped;
    if (typeof command !== 'string' || !command.trim()) return '';
    // Refuse our own script. A re-install that recorded us as the thing to wrap
    // would otherwise fork a new copy of this process on every single render,
    // forever, which is a fork bomb wearing a status line.
    if (command.includes('status-line.mjs')) return '';
    return command;
  } catch {
    return '';
  }
}

/**
 * Run the user's own status-line command and take its stdout.
 *
 * Synchronous on purpose: this process exists only to print one line, and the
 * async version buys nothing but a chance to get the ordering wrong. Their
 * stderr is discarded rather than forwarded -- their command failing is not a
 * reason for Claude Code to see errors from ours.
 */
function runWrapped(command, stdin) {
  const budget = Number.parseInt(process.env.PRMPT_STATUSLINE_WRAP_MS ?? '', 10);
  try {
    const res = spawnSync(command, {
      shell: true,
      input: stdin,
      encoding: 'utf8',
      timeout: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_WRAP_MS,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    // Whatever arrived before a non-zero exit or a kill is still the best
    // version of their status line we have, so it is used either way.
    return typeof res.stdout === 'string' ? res.stdout : '';
  } catch {
    return '';
  }
}

/** `Sponsored · headline`, clipped, styled, and wrapped in an OSC 8 link. */
function renderAd(slot, max, { color }) {
  const label = 'Sponsored · ';
  const text = `${label}${clip(plainText(slot.headline), max - label.length)}`;
  const body = color ? `\x1b[2m${text}\x1b[0m` : text;
  // The URL is the link target and is never also printed: the footer has no
  // room for it, and a terminal that does support OSC 8 would show it twice.
  // NO_COLOR deliberately does NOT remove this. A hyperlink is not colour, and
  // it is the only way the user ever gets paid for the line.
  if (!safeUrl(slot.clickUrl)) return body;
  return `\x1b]8;;${slot.clickUrl}\x1b\\${body}\x1b]8;;\x1b\\`;
}

function main() {
  readStdin().then((raw) => {
    let payload = {};
    try {
      payload = raw && raw.trim() ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }
    if (!payload || typeof payload !== 'object') payload = {};

    // Their status line runs whatever happens -- including when prmpt is
    // switched off entirely. Disabling an ad plugin must not cost somebody the
    // footer they wrote.
    const command = wrappedCommand();
    const prefix = command ? runWrapped(command, raw).replace(/[\r\x00]/g, '').replace(/\n+$/, '') : '';
    const lines = prefix ? prefix.split('\n') : [];
    const tail = lines.length ? lines.pop() : '';

    let segment = '';
    if (process.env.PRMPT_DISABLED !== '1') {
      const sessionId = payload.session_id ?? payload.sessionId ?? '';
      const slot = sessionId ? readSlot(sessionId) : null;
      if (slot) {
        // Only as much room as the terminal actually has. COLUMNS is the only
        // width available here -- stdout is a pipe, so there is no tty to ask.
        const columns = Number.parseInt(process.env.COLUMNS ?? '', 10);
        let budget = MAX_AD_CHARS;
        if (Number.isFinite(columns) && columns > 0) {
          const used = tail ? visibleLength(tail) + SEPARATOR.length : 0;
          budget = Math.min(MAX_AD_CHARS, columns - used);
        }
        if (budget >= MIN_AD_CHARS) {
          segment = renderAd(slot, budget, { color: !process.env.NO_COLOR });
          // The impression is claimed only once the ad is genuinely going out,
          // and claiming is what appends to pending.jsonl. An ad that did not
          // fit was not shown and is not billed.
          claimImpression(sessionId, slot.requestId);
        }
      }
    }

    const last = segment ? (tail ? `${tail}${SEPARATOR}${segment}` : segment) : tail;
    const out = [...lines, last].filter((l) => l !== '').join('\n');
    if (out) process.stdout.write(`${out}\n`);
    process.exit(0);
  }).catch(quiet);
}

// A late throw or rejection must still be silent.
process.on('uncaughtException', quiet);
process.on('unhandledRejection', quiet);

main();
