// prmpt -- version reading and comparison.
//
// Small on purpose, and separate from everything that does I/O, because the
// comparison is the part that decides whether a machine replaces its own code.
// Getting it wrong in the "newer" direction means an install downgrades itself
// on a loop; getting it wrong in the "older" direction means a security fix
// never lands.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The plugin root: the directory holding hooks/, bin/ and package.json. */
export function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** This install's version, or '0.0.0' when package.json cannot be read. */
export function currentVersion(root = pluginRoot()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Strip a leading `v` and any build metadata, then split into parts.
 *
 * Returns null for anything that is not major.minor.patch, so callers can
 * refuse to act rather than guess. A release tagged `latest` or `2026-08` is a
 * mistake we should notice, not silently treat as version zero.
 */
export function parseVersion(raw) {
  const text = String(raw ?? '').trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/**
 * -1, 0 or 1, comparing a against b. Throws on unparseable input.
 *
 * A prerelease sorts BEFORE its release (0.2.0-rc.1 < 0.2.0), per semver. That
 * matters here in one specific way: someone running an rc must be moved onto
 * the final release, and must never be "updated" from the final back to the rc.
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`prmpt: cannot compare versions ${JSON.stringify(a)} and ${JSON.stringify(b)}`);

  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (x.prerelease === y.prerelease) return 0;
  // Absent prerelease is the higher of the two.
  if (x.prerelease === null) return 1;
  if (y.prerelease === null) return -1;
  return x.prerelease < y.prerelease ? -1 : 1;
}

/** True when `candidate` is strictly newer than `current`. False if either is junk. */
export function isNewer(candidate, current) {
  try {
    return compareVersions(candidate, current) > 0;
  } catch {
    // An unparseable version is not a reason to replace working code.
    return false;
  }
}
