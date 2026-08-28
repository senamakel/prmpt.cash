#!/usr/bin/env node
// prmpt -- the end-of-turn hook.
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
import { enrolInBackground } from './lib/enrol.mjs';
import { linkEvmInBackground } from './lib/link-evm.mjs';
import { autoUpdateInBackground } from './lib/autoupdate.mjs';

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
    // Kept short deliberately: this timer and the request deadline are
    // consecutive, so a host that opens stdin and never closes it would
    // otherwise push the worst case to 1000 + 1500 = 2.5s. Gemini CLI runs
    // hooks synchronously inside the agent loop, so the ceiling is user-visible.
    const t = setTimeout(finish, 250);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Is this user-role entry a real prompt, rather than a tool result?
 *
 * Claude Code records tool results as user-role entries whose content blocks
 * are `tool_result`. Only an entry carrying actual text is the human speaking.
 */
function isUserPrompt(entry) {
  const content = entry?.message?.content ?? entry?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim(),
  );
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
  // Also yields the harness version and model, which ride along on the same
  // transcript entries we are already parsing -- so identifying the harness
  // costs no extra file reads and no subprocess.
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
    let version = '';
    let model = '';
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

      // Stop at the user's PROMPT, which is what starts the turn. Tool results
      // are also recorded as user-role entries, so breaking on any user entry
      // ended the walk at the first tool result and returned nothing — a turn
      // that used tools then answered would silently serve no ad at all.
      if (role === 'user' || entry?.type === 'user') {
        if (isUserPrompt(entry)) break;
        continue;
      }
      if (role !== 'assistant') continue;

      // Only take the version/model actually reported by an assistant entry of
      // this turn, so a neighbouring record cannot contribute them.
      if (!version && typeof entry?.version === 'string') version = entry.version;
      if (!model && typeof entry?.message?.model === 'string') model = entry.message.model;

      const text = textOfMessage(entry.message ?? entry);
      if (text) parts.push(text);
    }
    return { text: parts.reverse().join('\n').trim(), version, model };
  } catch {
    return { text: '', version: '', model: '' };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Which coding agent is running us.
 *
 * Claude Code sets CLAUDECODE=1 and delivers a hook payload with
 * `hook_event_name`; Codex's `notify` passes a JSON argv whose `type` is
 * `agent-turn-complete`. Anything else stays `unknown` -- the backend buckets
 * unrecognised values rather than trusting whatever a client sends.
 */
function detectHarness(payload) {
  // An explicit override always wins -- several hosts are indistinguishable
  // from their payload alone, and guessing wrong only skews the dashboard.
  const forced = (process.env.PRMPT_HARNESS || '').trim();
  if (forced) return forced;

  const event = payload?.hook_event_name;

  // Codex's older `notify` program: the event arrives as a JSON argv.
  if (typeof payload?.type === 'string' && payload.type.startsWith('agent-turn')) return 'codex';

  // Gemini CLI fires AfterAgent and exports its own project/session vars.
  if (event === 'AfterAgent' || process.env.GEMINI_SESSION_ID || process.env.GEMINI_PROJECT_DIR) {
    return 'gemini-cli';
  }

  // Claude Code and Codex BOTH name their end-of-turn event `Stop`, so the
  // payload cannot separate them. CLAUDECODE=1 is only set by Claude Code.
  if (process.env.CLAUDECODE === '1') return 'claude-code';
  if (event === 'Stop') return 'codex';

  // Cursor names its event afterAgentResponse; the env vars are a fallback for
  // hosts that do not forward the event name.
  if (event === 'afterAgentResponse') return 'cursor';
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_SESSION_ID) return 'cursor';
  return 'unknown';
}

/**
 * Collapse to a single line and clip to `max` characters, breaking on a word
 * boundary so a clipped line never ends mid-word.
 */
function oneLine(s, max) {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  // Only honour the word boundary if it isn't so early that we lose the line.
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The rendered block: a Sponsored marker + headline, one line of body, the
 * click URL. Never more than three lines, and never dressed up to look like
 * something the agent said.
 */
function renderLines(ad) {
  // These limits mirror what the backend asks the model for -- a 70 char
  // headline and a 140 char body -- so well-formed copy is never clipped.
  const lines = [`Sponsored · ${oneLine(ad.headline, 90)}`];
  if (ad.body) lines.push(oneLine(ad.body, 140));
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

    // An explicit opt-out ends it here, before anything is created on disk.
    if (config.disabled) return quiet();

    // Keep this install current. Detached and at most daily, so the cost to
    // this turn is a stat() and a spawn -- never a download. Deliberately
    // before the token check: an install that has drifted far enough behind to
    // be broken still needs to be able to fix itself.
    autoUpdateInBackground();

    // No token. Rather than staying mute forever waiting for someone to visit
    // the dashboard, hand off to a detached child that creates a wallet and
    // signs in. It cannot happen inline: two round trips against a cold backend
    // is many times the 1.5s budget, and under Gemini CLI that time is charged
    // straight to the user's turn. This turn serves nothing; the next one has
    // a token. PRMPT_NO_AUTO_ENROL=1 turns it off.
    if (!config.token) {
      enrolInBackground(config.endpoint);
      return quiet();
    }

    // An install created before payouts settled on two chains has proven only
    // its Solana address, so anything owed in an ERC-20 -- including USDC, the
    // default -- parks unsendable. Enrolment above cannot fix it: that fires
    // only when there is no token, and these installs have one.
    //
    // Detached and fire-and-forget for the same reason enrolment is, and it
    // does NOT block this turn: serving continues below either way. Worst case
    // the address is linked a turn later than it might have been.
    linkEvmInBackground(config);

    // Some hosts hand us the text directly; Claude Code's Stop payload does
    // not, so fall back to the transcript it points at.
    let turnText = '';
    const directCandidates = [
      payload['last-assistant-message'], // Codex notify, agent-turn-complete
      payload.last_assistant_message, // Codex Stop hook
      payload.prompt_response, // Gemini CLI AfterAgent
      payload.text, // Cursor afterAgentResponse
      payload.assistant_message,
      payload.turnText,
    ];
    for (const direct of directCandidates) {
      if (typeof direct === 'string' && direct.trim()) {
        turnText = direct.trim();
        break;
      }
    }
    let harnessVersion = '';
    let model = '';
    if (typeof payload.transcript_path === 'string' && payload.transcript_path) {
      const parsed = finalAssistantText(payload.transcript_path);
      harnessVersion = parsed.version;
      model = parsed.model;
      if (!turnText) turnText = parsed.text;
    }
    if (turnText.length < MIN_TURN_CHARS) return quiet();
    if (turnText.length > MAX_TURN_CHARS) turnText = turnText.slice(-MAX_TURN_CHARS);

    const { repoLanguage, fileTypes } = detectRepo(config.cwd);

    const ad = await serveAd(config, {
      installId: config.installId,
      sessionId: config.sessionId,
      // Which of the two places an ad can appear this is. The other one is the
      // Claude Code status line, which renders mid-turn and has no turn text.
      surface: 'TURN_END',
      turnText,
      repoLanguage,
      fileTypes,
      harness: detectHarness(payload),
      harnessVersion: harnessVersion || undefined,
      model: model || undefined,
    });
    if (!ad) return quiet();

    const lines = renderLines(ad);

    // How the block reaches a human depends on the host.
    //
    // Under Claude Code stdout is a pipe and, for a Stop hook, plain stdout is
    // not surfaced to the user -- `systemMessage` in the documented JSON
    // envelope is. Under a terminal (Codex, a manual run) stdout *is* the
    // display, so write the text straight out. PRMPT_OUTPUT forces either.
    const mode = process.env.PRMPT_OUTPUT || 'auto';
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
