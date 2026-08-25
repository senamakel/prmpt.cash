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
export const INSTALL_PS1 = path.join(PLUGIN_DIR, 'install.ps1');
export const IS_WINDOWS = process.platform === 'win32';

/**
 * A well-formed install code: ten characters of the backend's alphabet, which
 * omits everything that gets misread off a screen (no I, L, O, U, 0 or 1).
 */
export const TEST_CODE = 'K3H9F2QPRS';

/** The token a stub backend hands back. Nothing may ever print it. */
export const TEST_TOKEN = 'eyJ.smoke.SECRET_TOKEN_MUST_NEVER_BE_PRINTED';

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
export function sandbox(prefix = 'prmpt-smoke-') {
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
    // powershell.exe and cmd.exe both need a little more than PATH to start.
    // HOMEDRIVE/HOMEPATH are deliberately NOT inherited: they would point
    // PowerShell's $HOME at the real user profile and the sandbox would leak.
    env.PSModulePath = process.env.PSModulePath;
    env.windir = process.env.windir;
    env.PROCESSOR_ARCHITECTURE = process.env.PROCESSOR_ARCHITECTURE;
    env.NUMBER_OF_PROCESSORS = process.env.NUMBER_OF_PROCESSORS;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

/**
 * Spawn anything and collect exit code and both streams.
 *
 * The deadline is enforced here rather than by spawn's own `timeout`, and it
 * settles the promise itself rather than waiting to be told the child is gone.
 * Both parts are load-bearing on Windows:
 *
 *   - with `shell: true`, Node's timeout kills the shell, not the program the
 *     shell started, so the real process survives;
 *   - `close` fires only once every stdio stream is closed, and a surviving
 *     grandchild holds those pipes open forever.
 *
 * `claude doctor` hit exactly that and hung two CI jobs for the full twenty
 * minutes. So: kill the process TREE, abandon the pipes, and resolve with
 * `timedOut: true` so the caller can say what hung instead of disappearing.
 */
export function exec(command, args, { env, cwd = PLUGIN_DIR, stdin, timeout = 180_000, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (timedOut) stderr += `\n[smoke] killed after ${timeout}ms: ${command}`;
      resolve({ code: timedOut ? (code ?? 124) : code, signal, stdout, stderr, timedOut });
    };

    const killer = setTimeout(() => {
      timedOut = true;
      if (IS_WINDOWS && child.pid) {
        // /T for the tree: the shell's children are what actually need killing.
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch { /* already gone */ }
      }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      // Give the kill a moment to produce a real exit, then stop waiting for
      // one. Abandoning the pipes also lets this process exit afterwards.
      const giveUp = setTimeout(() => {
        for (const s of [child.stdin, child.stdout, child.stderr]) {
          try { s.destroy(); } catch { /* already closed */ }
        }
        try { child.unref(); } catch { /* already gone */ }
        settle(124, 'SIGKILL');
      }, 2000);
      if (typeof giveUp.unref === 'function') giveUp.unref();
    }, timeout);
    if (typeof killer.unref === 'function') killer.unref();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    // A child that never reads stdin (`sh -n`, `--help`) may exit first; the
    // resulting EPIPE is not a test failure.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');

    child.on('error', (err) => { clearTimeout(killer); if (!settled) { settled = true; reject(err); } });
    child.on('close', settle);
  });
}

/** Run install.ps1 under PowerShell with the given sandbox HOME. Windows only. */
export function installPs1(box, args = [], { env = {}, cwd = PLUGIN_DIR } = {}) {
  return exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', INSTALL_PS1, ...args,
  ], { env: smokeEnv(box.home, { APPDATA: path.join(box.home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(box.home, 'AppData', 'Local'), ...env }), cwd });
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
 *
 * `shell: true` rather than spawning cmd.exe with the command as an argv entry.
 * Node escapes argv for cmd unless told the arguments are verbatim, so
 * `node "C:/a b/hook.mjs"` reached node as `node \"C:/a b/hook.mjs\"` and node
 * tried to open a file whose name included the quote characters. That looked
 * exactly like an installer bug and was not one.
 */
export function runRecorded(command, { env, stdin = '' } = {}) {
  return exec(command, undefined, { env, stdin, shell: true });
}

/**
 * Run an agent CLI by name.
 *
 * On Windows an npm global is a `.cmd` shim, which CreateProcess cannot
 * execute -- `spawn('claude', ...)` fails with ENOENT even though the agent is
 * installed and first on PATH. That made every agent look absent, which turned
 * this suite's skips into a green Windows build that had tested nothing. The
 * shell resolves the shim, so Windows goes through it, quoting each argument on
 * the way, because a shell command line is one string and paths have spaces.
 */
export function execTool(bin, args = [], opts = {}) {
  if (!IS_WINDOWS) return exec(bin, args, opts);
  const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  return exec([bin, ...quoted].join(' '), undefined, { ...opts, shell: true });
}

/**
 * This machine's PATH with every directory that holds an agent CLI removed.
 *
 * The autodetection test needs a machine with no agents on it. Reducing PATH to
 * node's own directory does not achieve that: on CI the agent CLIs are npm
 * globals and land in exactly that directory, so the "no agents present" test
 * would quietly assert the opposite of what it says. Dropping only the
 * directories that actually contain one keeps bash, tar and mktemp, which the
 * installer needs to get far enough to reach the detection it is being tested on.
 */
export function agentFreePath() {
  const sep = IS_WINDOWS ? ';' : ':';
  const names = ['claude', 'codex', 'gemini', 'amp'];
  const exts = IS_WINDOWS ? ['', '.exe', '.cmd', '.bat', '.ps1'] : [''];
  return (process.env.PATH || '')
    .split(sep)
    .filter((dir) => {
      if (!dir) return false;
      return !names.some((n) => exts.some((e) => fs.existsSync(path.join(dir, n + e))));
    })
    .join(sep);
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

/**
 * Amp is a copied TypeScript plugin, not a hook entry, so it gets its own row.
 * install.sh puts it under XDG config even on Windows, because that is where
 * Git Bash resolves $HOME/.config to; install.ps1 uses %APPDATA%.
 */
export const AMP_PLUGIN = ['.config', 'amp', 'plugins', 'prmpt.ts'];

export function hostConfigPath(box, host) {
  return path.join(box.home, ...host.userConfig);
}
