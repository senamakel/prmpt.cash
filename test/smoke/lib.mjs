// Shared machinery for the installation smoke suite.
//
// The unit suite in test/*.test.mjs proves the hook behaves. This suite proves
// something different and much dumber: that `install.sh` puts a working hook
// into a real agent's real config file, on Linux, macOS and Windows, and that
// the command string it recorded there can actually be executed by that
// platform. Every assertion goes through a process boundary and a filesystem,
// because that is where installation breaks.
//
// Two rules make it portable:
//
//   1. The installer is always invoked as `bash install.sh`. On Windows that is
//      Git Bash, which is how a Windows user installs a POSIX shell script and
//      the only way this file has ever been run there.
//   2. Paths handed to bash use forward slashes even on Windows (`C:/Users/...`).
//      MSYS accepts that form and so does Windows Node, so one string works on
//      both sides of the boundary. A backslash path does not survive bash.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PLUGIN_DIR = path.resolve(here, '..', '..');
export const INSTALL_SH = path.join(PLUGIN_DIR, 'install.sh');
export const IS_WINDOWS = process.platform === 'win32';

/** A valid-looking Solana address (base58, 44 chars) for registration tests. */
export const TEST_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

/** Matches what test/helpers.mjs uses, so one grep proves the key never leaks. */
export const TEST_API_KEY = 'ak_test_SECRET_KEY_MUST_NEVER_BE_PRINTED';

// ---------------------------------------------------------------- scratch dirs

const scratch = [];
process.on('exit', () => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * A sandbox HOME plus the install dir under it.
 *
 * `home`/`dir` are native paths for Node to assert against; `homeArg`/`dirArg`
 * are the same paths in the form bash and the agents both accept.
 */
export function sandbox(prefix = 'adengine-smoke-') {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  scratch.push(home);
  const dir = path.join(home, 'app');
  return { home, dir, homeArg: shellPath(home), dirArg: shellPath(dir) };
}

/** A path both Git Bash and native Windows tooling will resolve. */
export function shellPath(p) {
  return IS_WINDOWS ? p.replace(/\\/g, '/') : p;
}

// ------------------------------------------------------------------ processes

/**
 * A minimal environment.
 *
 * Built up rather than inherited: this suite may itself be running inside
 * Claude Code or Codex, and an inherited CLAUDECODE would decide the
 * harness-detection assertions for us. Windows needs a few variables back or
 * child processes cannot start at all.
 */
export function smokeEnv(home, extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    NO_COLOR: '1',
  };
  if (IS_WINDOWS) {
    env.USERPROFILE = home;
    env.SystemRoot = process.env.SystemRoot;
    env.SYSTEMROOT = process.env.SYSTEMROOT;
    env.ComSpec = process.env.ComSpec;
    env.TEMP = process.env.TEMP;
    env.TMP = process.env.TMP;
    env.PATHEXT = process.env.PATHEXT;
    // Git Bash resolves /tmp against this; without it mktemp -d fails.
    env.MSYS = process.env.MSYS;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

/** Spawn anything and collect exit code and both streams. */
export function exec(command, args, { env, cwd = PLUGIN_DIR, stdin, timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    // A child that never reads stdin (`sh -n`, `--help`) may exit first; the
    // resulting EPIPE is not a test failure.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** Run install.sh under bash with the given sandbox HOME. */
export function install(box, args = [], { env = {}, cwd = PLUGIN_DIR } = {}) {
  return exec('bash', [shellPath(INSTALL_SH), ...args], {
    env: smokeEnv(box.home, env),
    cwd,
  });
}

/**
 * Run the command string the installer recorded in an agent's config, the way
 * that agent's host would: handed to the platform shell, verbatim.
 *
 * This is the assertion the rest of the suite exists for. A hook whose recorded
 * path is an MSYS path, or is missing a quote, fails here and nowhere else.
 */
export function runRecorded(command, { env, stdin = '' } = {}) {
  return IS_WINDOWS
    ? exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { env, stdin })
    : exec('/bin/sh', ['-c', command], { env, stdin });
}

/**
 * A PATH containing node and nothing else.
 *
 * Autodetection tests need a machine with no agents on it. Pointing PATH at
 * node's own directory is not enough: on CI the agent CLIs are npm globals and
 * land in exactly that directory, so the "no agents present" test would quietly
 * assert the opposite of what it says.
 */
export function nodeOnlyPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adengine-bin-'));
  scratch.push(dir);
  // A /bin/sh shim rather than a symlink or a .cmd: the only thing that ever
  // resolves `node` from this PATH is install.sh, which is bash on every
  // platform including Windows, and a shim works there where a symlink does not.
  const shim = path.join(dir, 'node');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${shellPath(process.execPath)}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return dir;
}

// -------------------------------------------------------------- config access

export function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Every hook entry registered under `event`, flattened across matcher groups. */
export function entriesFor(config, event) {
  const groups = config?.hooks?.[event];
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g) => (Array.isArray(g.hooks) ? g.hooks.map((h) => ({ ...h, matcher: g.matcher })) : []));
}

/** Only our own entries — the ones whose command runs turn-end.mjs. */
export function ourEntries(config, event) {
  return entriesFor(config, event).filter(
    (h) => typeof h.command === 'string' && h.command.includes('turn-end.mjs'),
  );
}

/**
 * Where each supported host keeps its config, which event it fires, and what
 * unit its timeout is in.
 *
 * These four rows are the whole product surface of the installer. They are not
 * interchangeable: Gemini's timeout is milliseconds and Claude Code's is
 * seconds, and swapping them yields a hook that is either useless or a 5000
 * second stall. The table is duplicated from install.sh on purpose — a test
 * that imported the value under test would agree with any bug.
 */
export const HOSTS = [
  {
    agent: 'claude',
    label: 'Claude Code',
    userConfig: ['.claude', 'settings.json'],
    projectConfig: ['.claude', 'settings.json'],
    event: 'Stop',
    timeout: 5,
    matcher: undefined,
  },
  {
    agent: 'codex',
    label: 'Codex',
    userConfig: ['.codex', 'hooks.json'],
    projectConfig: ['.codex', 'hooks.json'],
    event: 'Stop',
    timeout: 5,
    matcher: undefined,
  },
  {
    agent: 'gemini',
    label: 'Gemini CLI',
    userConfig: ['.gemini', 'settings.json'],
    projectConfig: ['.gemini', 'settings.json'],
    event: 'AfterAgent',
    timeout: 5000,
    matcher: '*',
  },
];

/** Amp is a copied TypeScript plugin, not a hook entry, so it gets its own row. */
export const AMP_PLUGIN = ['.config', 'amp', 'plugins', 'adengine.ts'];

export function hostConfigPath(box, host) {
  return path.join(box.home, ...host.userConfig);
}
