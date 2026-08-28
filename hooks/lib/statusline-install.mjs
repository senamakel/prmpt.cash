// prmpt -- wiring the status line into Claude Code and Codex.
//
// Both hosts document an external-command status line, so this whole surface is
// two config edits and nothing else. Nothing here patches, repacks or re-signs
// an application; the plugin owns two keys in two files it is invited to write,
// and `uninstall` puts both back.
//
//   Claude Code  ~/.claude/settings.json   "statusLine": { type, command, ... }
//   Codex        ~/.codex/config.toml      [tui] status_line = [argv...]
//
// Two rules govern the edits:
//
//   - Chain, never clobber. A status line someone configured themselves is not
//     ours to delete. Whatever was there is stashed and run by our renderer,
//     with its output kept above ours.
//   - Every write is reversible. The pre-install value of each key we touch is
//     recorded once, at first install, and restored verbatim on uninstall.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configDir } from './config.mjs';
import { pluginRoot } from './version.mjs';

/** Recognises our own command so a re-install doesn't chain itself. */
const MARKER = 'prmpt';

export function claudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export function codexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function backupDir() {
  return path.join(configDir(), 'statusline-backup');
}

function chainPath(host) {
  return path.join(configDir(), `statusline-chain-${host}.json`);
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

/**
 * The chained status line, if the renderer should run one.
 *
 * A single file for both hosts would be wrong: someone can run Claude Code and
 * Codex on the same machine with different status lines configured, and the
 * renderer must run the one belonging to the host that invoked it. The host is
 * identified the same way the turn hook identifies it -- CLAUDECODE=1 is set
 * only by Claude Code.
 */
export function readChain(host = process.env.CLAUDECODE === '1' ? 'claude' : 'codex') {
  return readJson(chainPath(host));
}

/** The command Claude Code should run, quoted for a path with spaces in it. */
export function renderCommand() {
  return `node "${path.join(pluginRoot(), 'hooks', 'statusline.mjs')}"`;
}

/** The argv Codex should run. Codex takes an array, so no quoting is needed. */
export function renderArgv() {
  return ['node', path.join(pluginRoot(), 'hooks', 'statusline.mjs'), '--line'];
}

// --- Claude Code ------------------------------------------------------------

export function claudeStatus() {
  const settings = readJson(claudeSettingsPath());
  const command = settings?.statusLine?.command;
  return {
    host: 'claude-code',
    path: claudeSettingsPath(),
    present: fs.existsSync(claudeSettingsPath()),
    installed: typeof command === 'string' && command.includes(MARKER),
    chained: readJson(chainPath('claude')) !== null,
  };
}

export function installClaude() {
  const file = claudeSettingsPath();
  const settings = readJson(file) || {};

  // One pristine backup, taken before the first edit and never overwritten --
  // a second install after an uninstall must not record our own value as the
  // thing to restore to.
  const backup = path.join(backupDir(), 'claude.settings.json');
  if (!fs.existsSync(backup)) writeJson(backup, settings);

  const existing = settings.statusLine;
  const isOurs =
    existing && typeof existing.command === 'string' && existing.command.includes(MARKER);
  if (existing && !isOurs) {
    writeJson(chainPath('claude'), existing);
  } else if (!existing) {
    try { fs.rmSync(chainPath('claude'), { force: true }); } catch { /* ignore */ }
  }

  settings.statusLine = {
    type: 'command',
    command: renderCommand(),
    // The slot only changes at the end of a turn, so there is nothing to gain
    // from a tighter refresh -- and every refresh is a process spawn.
    refreshInterval: 5,
    padding: 0,
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { path: file, chained: existing && !isOurs ? existing : null };
}

export function uninstallClaude() {
  const file = claudeSettingsPath();
  const settings = readJson(file);
  if (!settings) return { path: file, changed: false };

  const command = settings.statusLine?.command;
  if (typeof command === 'string' && !command.includes(MARKER)) {
    // Someone else's status line is in place now. Leave it entirely alone.
    return { path: file, changed: false };
  }

  const chain = readJson(chainPath('claude'));
  if (chain) settings.statusLine = chain;
  else delete settings.statusLine;

  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  try { fs.rmSync(chainPath('claude'), { force: true }); } catch { /* ignore */ }
  return { path: file, changed: true, restored: chain || null };
}

// --- Codex ------------------------------------------------------------------

// Codex's config is TOML and the plugin has no dependencies, so the edit is
// textual. It is scoped to the [tui] table rather than done with a global
// regex: `status_line` is a plausible key name under another table, and a
// file-wide substitution would silently rewrite somebody else's setting.

const TUI_HEADER_RE = /^[ \t]*\[tui\][ \t]*$/m;
const ANY_HEADER_RE = /^[ \t]*\[[^\]]+\][ \t]*$/m;

/** Byte range of the [tui] table's body, or null when there is no [tui] table. */
function tuiRange(text) {
  const header = TUI_HEADER_RE.exec(text);
  if (!header) return null;
  const start = header.index + header[0].length;
  const rest = text.slice(start);
  const next = ANY_HEADER_RE.exec(rest);
  return { start, end: next ? start + next.index : text.length };
}

function findKeyLine(body, key) {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm');
  const m = re.exec(body);
  return m ? { raw: m[0], index: m.index, length: m[0].length } : null;
}

/** Replace the [tui] body with `next`, returning the whole file. */
function spliceTui(text, range, next) {
  return text.slice(0, range.start) + next + text.slice(range.end);
}

/** Parse the argv array out of `status_line = [ ... ]`, or null. */
function parseArgv(raw) {
  const m = /=\s*(\[[\s\S]*\])/.exec(raw || '');
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Is this status_line value a command we can chain, rather than Codex's
 * built-in list of status items? Only the former is runnable.
 */
function looksRunnable(argv) {
  if (!Array.isArray(argv) || !argv.length) return false;
  const first = String(argv[0]);
  return first.includes('/') || first.includes('\\') || fs.existsSync(first);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function codexStatus() {
  const file = codexConfigPath();
  const text = readText(file);
  const range = tuiRange(text);
  const line = range ? findKeyLine(text.slice(range.start, range.end), 'status_line') : null;
  return {
    host: 'codex',
    path: file,
    present: fs.existsSync(file),
    installed: Boolean(line && line.raw.includes(MARKER)),
    chained: readJson(chainPath('codex')) !== null,
  };
}

export function installCodex() {
  const file = codexConfigPath();
  let text = readText(file);
  let range = tuiRange(text);

  if (!range) {
    text = `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}[tui]\n`;
    range = tuiRange(text);
  }

  let body = text.slice(range.start, range.end);
  const existing = findKeyLine(body, 'status_line');
  const existingTimeout = findKeyLine(body, 'status_line_timeout_ms');

  const backup = path.join(backupDir(), 'codex.status_line.json');
  if (!fs.existsSync(backup)) {
    writeJson(backup, {
      hadFile: fs.existsSync(file),
      statusLine: existing ? existing.raw : null,
      timeout: existingTimeout ? existingTimeout.raw : null,
    });
  }

  const isOurs = existing && existing.raw.includes(MARKER);
  if (existing && !isOurs) {
    const argv = parseArgv(existing.raw);
    if (looksRunnable(argv)) writeJson(chainPath('codex'), { argv });
    else {
      // A built-in item list is not a command, so it cannot be chained -- and
      // Codex gives us one row. Refuse rather than silently replace it.
      throw new Error(
        `prmpt: ${file} already sets a built-in [tui] status_line. Remove it first, or run with --force.`,
      );
    }
  } else if (!existing) {
    try { fs.rmSync(chainPath('codex'), { force: true }); } catch { /* ignore */ }
  }

  // Strip only the two keys we manage, inside [tui] only, so a re-install never
  // leaves a duplicate.
  for (const key of ['status_line', 'status_line_timeout_ms']) {
    const found = findKeyLine(body, key);
    if (found) {
      body = body.slice(0, found.index) + body.slice(found.index + found.length);
    }
  }

  const block = [
    `status_line = ${JSON.stringify(renderArgv())} # ${MARKER}`,
    // The renderer reads one small file and may spawn a chained command; 1500ms
    // is the same budget the turn hook works to.
    'status_line_timeout_ms = 1500',
  ].join('\n');

  body = `\n${block}\n${body.replace(/^\n+/, '')}`;
  let out = spliceTui(text, range, body).replace(/\n{3,}/g, '\n\n');
  if (!out.endsWith('\n')) out += '\n';

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return { path: file, chained: existing && !isOurs ? existing.raw : null };
}

export function uninstallCodex() {
  const file = codexConfigPath();
  let text = readText(file);
  if (!text) return { path: file, changed: false };
  const range = tuiRange(text);
  if (!range) return { path: file, changed: false };

  let body = text.slice(range.start, range.end);
  const existing = findKeyLine(body, 'status_line');
  if (existing && !existing.raw.includes(MARKER)) {
    // Replaced by something else since we installed. Not ours to remove.
    return { path: file, changed: false };
  }

  for (const key of ['status_line', 'status_line_timeout_ms']) {
    const found = findKeyLine(body, key);
    if (found) body = body.slice(0, found.index) + body.slice(found.index + found.length);
  }

  const restore = readJson(path.join(backupDir(), 'codex.status_line.json'));
  const lines = [restore?.statusLine, restore?.timeout].filter(Boolean);
  if (lines.length) body = `\n${lines.join('\n')}\n${body.replace(/^\n+/, '')}`;

  let out = spliceTui(text, range, body).replace(/\n{3,}/g, '\n\n');
  if (!out.endsWith('\n')) out += '\n';
  fs.writeFileSync(file, out);
  try { fs.rmSync(chainPath('codex'), { force: true }); } catch { /* ignore */ }
  return { path: file, changed: true, restored: restore?.statusLine || null };
}

// --- both -------------------------------------------------------------------

/** Which hosts are actually present on this machine. */
export function detectHosts() {
  const hosts = [];
  if (fs.existsSync(path.dirname(claudeSettingsPath()))) hosts.push('claude');
  if (fs.existsSync(path.dirname(codexConfigPath()))) hosts.push('codex');
  return hosts;
}

export function statusAll() {
  return [claudeStatus(), codexStatus()];
}
