#!/usr/bin/env node
// adengine -- the end-of-turn hook.
//
// Wired to Claude Code's `Stop` event, which fires when Claude finishes
// responding. It reads the turn's final assistant text, asks the backend
// whether any campaign matches it, and on a hit renders a single labelled
// sponsored block.
//
// The governing rule is fail-open and silent. Every path that is not "the
// backend returned a real decision inside the deadline" ends in exit 0 with
// nothing written to stdout or stderr. A hook that interrupts, slows, or
// breaks a coding session is worse than a hook that never earns anything.

import fs from 'node:fs';
import process from 'node:process';

import { loadConfig, detectRepo } from './lib/config.mjs';
import { serveAd } from './lib/api.mjs';

/** Below this many characters a turn carries no usable signal. */
const MIN_TURN_CHARS = 80;
/** The backend only looks at the tail of the turn; don't ship more than that. */
const MAX_TURN_CHARS = 4000;
/** Tail of the transcript to parse, in bytes. Bounded work on a huge session. */
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/** Exit cleanly with no output whatsoever. */
function quiet() {
  process.exit(0);
}

/** Read all of stdin, with a ceiling so a pathological payload can't hang us. */
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
    const t = setTimeout(finish, 1000);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** Concatenate the `text` blocks of one transcript message. */
function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Pull the final assistant text out of the transcript JSONL.
 *
 * Claude Code appends one JSON object per line and may split a single reply
 * across several assistant lines (text, thinking and tool_use blocks each get
 * their own entry). So: walk backwards, gather assistant text blocks, and stop
 * at the first user/tool entry, which marks the start of this turn.
 */
function finalAssistantText(transcriptPath) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    // A partial first line from mid-file slicing is dropped below by JSON.parse.
    const lines = buf.toString('utf8').split('\n');

    const parts = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const role = entry?.message?.role ?? entry?.role;
      if (role === 'user' || entry?.type === 'user') break;
      if (role !== 'assistant') continue;
      const text = textOfMessage(entry.message ?? entry);
      if (text) parts.push(text);
    }
    return parts.reverse().join('\n').trim();
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Collapse to a single line and clip to `max` characters. */
function oneLine(s, max) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The rendered block: a Sponsored marker + headline, one line of body, the
 * click URL. Never more than three lines, and never dressed up to look like
 * something the agent said.
 */
function renderLines(ad) {
  const lines = [`Sponsored · ${oneLine(ad.headline, 90)}`];
  if (ad.body) lines.push(oneLine(ad.body, 100));
  lines.push(ad.clickUrl);
  return lines;
}

function main() {
  readStdin().then(async (stdinRaw) => {
    // Claude Code pipes the payload on stdin. Codex's `notify` program instead
    // passes it as a single JSON argv. Accept whichever showed up.
    const argvRaw = process.argv[2];
    const raw = (stdinRaw && stdinRaw.trim()) || (typeof argvRaw === 'string' ? argvRaw : '');

    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return quiet();
    }
    if (!payload || typeof payload !== 'object') return quiet();

    // Codex fires `notify` for several event types; only the end of a turn is
    // ours. Claude Code's Stop payload has no `type`, so an absent one passes.
    if (typeof payload.type === 'string' && payload.type !== 'agent-turn-complete') {
      return quiet();
    }

    const config = loadConfig(payload);

    // No key or an explicit opt-out: do nothing, say nothing.
    if (config.disabled || !config.apiKey) return quiet();

    // Some hosts hand us the text directly; Claude Code's Stop payload does
    // not, so fall back to the transcript it points at.
    let turnText = '';
    const directCandidates = [
      payload['last-assistant-message'], // Codex notify, agent-turn-complete
      payload.last_assistant_message,
      payload.assistant_message,
      payload.turnText,
    ];
    for (const direct of directCandidates) {
      if (typeof direct === 'string' && direct.trim()) {
        turnText = direct.trim();
        break;
      }
    }
    if (!turnText && typeof payload.transcript_path === 'string' && payload.transcript_path) {
      turnText = finalAssistantText(payload.transcript_path);
    }
    if (turnText.length < MIN_TURN_CHARS) return quiet();
    if (turnText.length > MAX_TURN_CHARS) turnText = turnText.slice(-MAX_TURN_CHARS);

    const { repoLanguage, fileTypes } = detectRepo(config.cwd);

    const ad = await serveAd(config, {
      installId: config.installId,
      sessionId: config.sessionId,
      turnText,
      repoLanguage,
      fileTypes,
    });
    if (!ad) return quiet();

    const lines = renderLines(ad);

    // How the block reaches a human depends on the host.
    //
    // Under Claude Code stdout is a pipe and, for a Stop hook, plain stdout is
    // not surfaced to the user -- `systemMessage` in the documented JSON
    // envelope is. Under a terminal (Codex, a manual run) stdout *is* the
    // display, so write the text straight out. ADENGINE_OUTPUT forces either.
    const mode = process.env.ADENGINE_OUTPUT || 'auto';
    const asText = mode === 'text' || (mode !== 'json' && process.stdout.isTTY);

    if (asText) {
      const dim = process.stdout.isTTY && !process.env.NO_COLOR;
      const out = lines.map((l) => (dim ? `\x1b[2m${l}\x1b[0m` : l)).join('\n');
      process.stdout.write(`${out}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ systemMessage: lines.join('\n') })}\n`);
    }
    process.exit(0);
  }).catch(quiet);
}

// A late throw or rejection must still be silent.
process.on('uncaughtException', quiet);
process.on('unhandledRejection', quiet);

main();
