// adengine -- configuration, identity and cheap repo fingerprinting.
//
// Everything here is best-effort. A throw from this module would surface in the
// user's session, so every filesystem touch is wrapped and every failure
// degrades to a safe default.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_ENDPOINT = 'http://localhost:8080/graphql';

/** ~/.config/adengine, honouring XDG_CONFIG_HOME. */
export function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'adengine');
}

export function configPath() {
  return path.join(configDir(), 'config.json');
}

function readConfigFile() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A stable per-machine install id.
 *
 * Preference order: the id already persisted in config.json, then a
 * deterministic hash of machine-id + hostname + home dir. The derived value is
 * reproducible on its own, so nothing has to be written for it to stay stable.
 */
export function resolveInstallId(cfg = readConfigFile()) {
  if (typeof cfg.installId === 'string' && cfg.installId.length > 0) {
    return cfg.installId;
  }
  let machine = '';
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      machine = fs.readFileSync(p, 'utf8').trim();
      if (machine) break;
    } catch { /* not present on this platform */ }
  }
  const seed = [machine, os.hostname(), os.homedir(), os.platform(), os.arch()].join(' ');
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

/**
 * The session id.
 *
 * Claude Code's Stop payload carries `session_id`; use it verbatim so backend
 * frequency caps line up with what the user experiences as one session. When
 * the host gives us nothing (Codex, a bare pipe), fall back to a hash of cwd
 * plus this machine's boot time, which is stable for the life of the box but
 * changes across reboots.
 */
export function resolveSessionId(payload = {}, cwd = process.cwd()) {
  const direct = payload.session_id ?? payload.sessionId ?? payload['thread-id'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const bootMs = Math.floor(Date.now() - os.uptime() * 1000);
  // Round to the nearest minute: os.uptime() has sub-second jitter that would
  // otherwise hand out a different id on every single turn.
  const bootBucket = Math.round(bootMs / 60000);
  return crypto.createHash('sha256')
    .update(cwd + ' ' + bootBucket)
    .digest('hex')
    .slice(0, 32);
}

/** Merge env over the on-disk config. Env always wins. */
export function loadConfig(payload = {}) {
  const cfg = readConfigFile();
  const cwd = (typeof payload.cwd === 'string' && payload.cwd) || process.cwd();

  const envKey = process.env.ADENGINE_API_KEY;
  const apiKey = (envKey && envKey.trim()) || (typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '');

  const envEndpoint = process.env.ADENGINE_ENDPOINT;
  const endpoint =
    (envEndpoint && envEndpoint.trim()) ||
    (typeof cfg.endpoint === 'string' && cfg.endpoint.trim()) ||
    DEFAULT_ENDPOINT;

  const timeoutMs = Number.parseInt(process.env.ADENGINE_TIMEOUT_MS ?? '', 10);

  return {
    apiKey,
    endpoint,
    cwd,
    installId: resolveInstallId(cfg),
    sessionId: resolveSessionId(payload, cwd),
    disabled: process.env.ADENGINE_DISABLED === '1',
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1500,
  };
}

/** Write config.json at 0600, creating the directory at 0700. */
export function writeConfig(next) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath();
  const merged = { ...readConfigFile(), ...next };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode only applies on create; force it for an existing file.
  fs.chmodSync(file, 0o600);
  return file;
}

// --- repo fingerprint -------------------------------------------------------

// Marker file -> language. Ordered: the first hit wins as `repoLanguage`.
const MARKERS = [
  ['go.mod', 'go'],
  ['Cargo.toml', 'rust'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['Pipfile', 'python'],
  ['setup.py', 'python'],
  ['tsconfig.json', 'typescript'],
  ['package.json', 'javascript'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['build.gradle.kts', 'kotlin'],
  ['Gemfile', 'ruby'],
  ['composer.json', 'php'],
  ['mix.exs', 'elixir'],
  ['pubspec.yaml', 'dart'],
  ['Package.swift', 'swift'],
  ['CMakeLists.txt', 'cpp'],
  ['*.csproj', 'csharp'],
];

const EXT_BY_LANG = {
  go: ['.go'],
  rust: ['.rs'],
  python: ['.py'],
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.mjs', '.jsx'],
  java: ['.java'],
  kotlin: ['.kt'],
  ruby: ['.rb'],
  php: ['.php'],
  elixir: ['.ex'],
  dart: ['.dart'],
  swift: ['.swift'],
  cpp: ['.cpp', '.hpp', '.cc'],
  csharp: ['.cs'],
};

/**
 * Detect the repo's language and a handful of file extensions from marker
 * files in cwd. Deliberately one shallow readdir: no recursion, no file
 * contents, and nothing that could stall the turn.
 */
export function detectRepo(cwd) {
  let names;
  try {
    names = fs.readdirSync(cwd);
  } catch {
    return { repoLanguage: null, fileTypes: [] };
  }
  const present = new Set(names);
  const langs = [];
  for (const [marker, lang] of MARKERS) {
    const hit = marker.startsWith('*.')
      ? names.some((n) => n.endsWith(marker.slice(1)))
      : present.has(marker);
    if (hit && !langs.includes(lang)) langs.push(lang);
  }

  // package.json alone means JS; a tsconfig.json alongside it means TS.
  if (langs.includes('typescript')) {
    const i = langs.indexOf('javascript');
    if (i !== -1) langs.splice(i, 1);
  }

  const fileTypes = [];
  for (const lang of langs) {
    for (const ext of EXT_BY_LANG[lang] ?? []) {
      if (!fileTypes.includes(ext)) fileTypes.push(ext);
    }
  }
  return { repoLanguage: langs[0] ?? null, fileTypes: fileTypes.slice(0, 8) };
}
