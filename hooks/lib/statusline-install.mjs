// prmpt -- wiring the status line into Claude Code.
//
// Claude Code documents an external-command status line, so this whole surface
// is one config edit and nothing else. Nothing here patches, repacks or
// re-signs an application; the plugin owns one key in one file it is invited to
// write, and `uninstall` puts it back.
//
//   ~/.claude/settings.json   "statusLine": { type: "command", command: ... }
//
// Two rules govern the edit:
//
//   - Chain, never clobber. A status line someone configured themselves is not
//     ours to delete. Whatever was there is stashed and run by our renderer,
//     with its output kept above ours.
//   - It is reversible. The pre-install value is recorded once, at first
//     install, and restored verbatim on uninstall.
//
// Codex is deliberately absent. Its `[tui] status_line` accepts identifiers
// from a closed set of built-in items -- `model-with-reasoning`, `current-dir`,
// `git-branch`, `context-used` and so on -- and cannot run a command at all.
// Verified against the codex 0.150.1 binary: there is a validation path
// reporting "configuration contains unknown item identifiers", and the
// `status_line_timeout_ms` key that a competing implementation writes does not
// exist in the binary. openai/codex#17827 is the open feature request for
// command-backed status lines; #20244 was closed as its duplicate.
//
// Writing an argv there would produce startup warnings and render nothing. This
// is exactly the failure CLAUDE.md warns about, so it is recorded rather than
// attempted. Codex is otherwise unaffected: its `Stop` hook still supplies turn
// text, still gets a match, still prints the end-of-turn line, and still parks
// a slot -- which the VS Code / Cursor extension can render even though Codex
// itself has nowhere to put it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configDir } from './config.mjs';
import { pluginRoot } from './version.mjs';

/**
 * Recognises our own command so a re-install doesn't chain itself.
 *
 * Anchored on the directory as well as the file name, and duplicated verbatim
 * in the merge programs install.sh and install.ps1 embed -- both routes write
 * this setting and either may find the other's work. A bare 'statusline.mjs'
 * also matches somebody's own their-statusline.mjs, and mistaking theirs for
 * ours means either deleting it on uninstall or forking a fresh copy of the
 * renderer on every single render.
 */
const MARKER = /hooks[\/\\]statusline\.mjs/;

/** Is this status-line command one of ours? */
export function isOurCommand(command) {
  return typeof command === 'string' && MARKER.test(command);
}

/**
 * What installing costs the user, printed before anything is written.
 *
 * Claude Code drops most of its footer keyboard hints -- `esc to interrupt`
 * among them -- as soon as a custom status line exists. That is a real trade
 * and the user has to make it knowingly, which is also why this surface is
 * opt-in and is not wired in by install.sh.
 */
export const CLAUDE_TRADE_OFF = [
  'Claude Code hides most of its footer keyboard hints -- including',
  '"esc to interrupt" -- whenever a custom status line is configured.',
  'That is Claude Code behaviour, not something prmpt chooses.',
  "Run 'prmpt statusline uninstall' to get them back.",
];

export function claudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
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

/** Every host that has ever had a chain file, most likely first. */
const CHAIN_HOSTS = ['claude', 'codex'];

/**
 * The chained status line, if the renderer should run one.
 *
 * Keyed by host so that a machine running more than one agent keeps them
 * separate. Only Claude Code can install today, but the renderer is written
 * against the general case.
 *
 * The fallback across hosts is load-bearing rather than tidy-minded: the host
 * is guessed from CLAUDECODE, which is documented for hooks and NOT for the
 * status-line command, so a wrong guess would silently stop running a status
 * line the user built. Only one of these files is ever written on a machine, so
 * taking whichever exists cannot pick the wrong one.
 */
export function readChain(host = process.env.CLAUDECODE === '1' ? 'claude' : 'codex') {
  for (const candidate of [host, ...CHAIN_HOSTS]) {
    const found = readJson(chainPath(candidate));
    if (found) return found;
  }
  return null;
}

/** The command Claude Code should run, quoted for a path with spaces in it. */
export function renderCommand() {
  return `node "${path.join(pluginRoot(), 'hooks', 'statusline.mjs')}"`;
}

/**
 * The UserPromptSubmit hook that fetches something fresher for the row.
 *
 * Part of THIS surface, not of the default install: it exists only to fill the
 * status-line slot, so wiring it without a status line would send keywords
 * derived from somebody's prompt for an ad that had nowhere to appear.
 * install.sh --statusline writes the same pair.
 */
export function fetchCommand() {
  return `node "${path.join(pluginRoot(), 'hooks', 'prompt-start.mjs')}"`;
}

/** Recognises the fetch hook, ours or a previous version of ours. */
function isOurFetchHook(entry) {
  return typeof entry?.command === 'string' && /prompt-start\.mjs/.test(entry.command);
}

/**
 * Add our UserPromptSubmit entry, replacing any earlier copy of it.
 *
 * Filtering first is what stops a re-install stacking duplicates: the settings
 * file is the user's and we are one entry in a list that may hold several.
 */
function addFetchHook(settings) {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const groups = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
  const kept = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) { kept.push(group); continue; }
    const remaining = group.hooks.filter((h) => !isOurFetchHook(h));
    if (remaining.length) kept.push({ ...group, hooks: remaining });
  }
  // Timeout in SECONDS. Claude Code and Gemini CLI differ on the unit and the
  // two are not interchangeable.
  kept.push({ hooks: [{ type: 'command', command: fetchCommand(), timeout: 5 }] });
  settings.hooks = { ...hooks, UserPromptSubmit: kept };
}

/** Take our UserPromptSubmit entry back out, leaving everybody else's. */
function removeFetchHook(settings) {
  const groups = settings.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return;
  const kept = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) { kept.push(group); continue; }
    const remaining = group.hooks.filter((h) => !isOurFetchHook(h));
    if (remaining.length) kept.push({ ...group, hooks: remaining });
  }
  if (kept.length) settings.hooks.UserPromptSubmit = kept;
  else delete settings.hooks.UserPromptSubmit;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

// --- Claude Code ------------------------------------------------------------

export function claudeStatus() {
  const settings = readJson(claudeSettingsPath());
  const command = settings?.statusLine?.command;
  return {
    host: 'claude-code',
    path: claudeSettingsPath(),
    supported: true,
    present: fs.existsSync(claudeSettingsPath()),
    installed: isOurCommand(command),
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
  const isOurs = Boolean(existing) && isOurCommand(existing.command);
  if (existing && !isOurs) {
    writeJson(chainPath('claude'), existing);
  } else if (!existing) {
    try { fs.rmSync(chainPath('claude'), { force: true }); } catch { /* ignore */ }
  }

  // No `refreshInterval`. Claude Code already re-runs the command on events,
  // and the end of a turn is one of them -- which is the only moment our slot
  // can change. An interval on top of that would spawn a process every few
  // seconds for the life of every session and never find anything new.
  settings.statusLine = {
    type: 'command',
    command: renderCommand(),
    padding: 0,
  };

  // The surface is both halves, so both go in together.
  addFetchHook(settings);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { path: file, chained: existing && !isOurs ? existing : null };
}

export function uninstallClaude() {
  const file = claudeSettingsPath();
  const settings = readJson(file);
  if (!settings) return { path: file, changed: false };

  const command = settings.statusLine?.command;
  if (typeof command === 'string' && !isOurCommand(command)) {
    // Someone else's status line is in place now. Leave it entirely alone.
    return { path: file, changed: false };
  }

  const chain = readJson(chainPath('claude'));
  if (chain) settings.statusLine = chain;
  else delete settings.statusLine;

  // Both halves came in together and both go out together. Leaving the fetch
  // hook behind would keep sending prompt keywords for a row that no longer
  // exists -- the exact trade the user just opted out of.
  removeFetchHook(settings);

  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  try { fs.rmSync(chainPath('claude'), { force: true }); } catch { /* ignore */ }
  return { path: file, changed: true, restored: chain || null };
}

// --- reporting --------------------------------------------------------------

/**
 * Why Codex cannot have this surface, carried in the status output so the
 * answer is one command away rather than a thing somebody rediscovers by
 * writing a config that silently does nothing.
 */
export function codexStatus() {
  return {
    host: 'codex',
    path: path.join(os.homedir(), '.codex', 'config.toml'),
    supported: false,
    reason: '[tui] status_line takes built-in item ids, not a command (openai/codex#17827)',
    note: 'Codex still serves ads through its Stop hook, and its turns still park a slot.',
  };
}

/** Which hosts are present on this machine and can actually be installed into. */
export function detectHosts() {
  const hosts = [];
  if (fs.existsSync(path.dirname(claudeSettingsPath()))) hosts.push('claude');
  return hosts;
}

export function statusAll() {
  return [claudeStatus(), codexStatus()];
}
