// prmpt -- replacing this install with a newer release.
//
// This is the only code in the plugin that overwrites the plugin, so it is
// written to fail safe at every step rather than to be short:
//
//   1. refuse outright in situations where updating is wrong (a git checkout,
//      a read-only directory, a version that is not actually newer)
//   2. download and verify the tarball BEFORE anything on disk is touched
//   3. unpack to a staging directory beside the install and sanity-check it
//   4. swap by rename, keeping the old tree until the new one is in place
//   5. roll back on any failure, and leave the old tree if rollback itself fails
//
// The user's credentials are NOT in the install directory -- the token and the
// wallet key live in ~/.config/prmpt -- so a swap, a rollback, or a botched
// half-swap can never destroy the one irreplaceable thing. That separation is
// what makes updating in place acceptable at all, and there is a test for it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { currentVersion, pluginRoot, isNewer } from './version.mjs';
import { latestRelease, releaseByTag, download, verifyTarball } from './release.mjs';

/** Files that must exist for a directory to be a plausible plugin. */
const REQUIRED = ['hooks/turn-end.mjs', 'hooks/lib/config.mjs', 'bin/prmpt.mjs', 'package.json'];

/**
 * Reasons to refuse before touching anything.
 *
 * A git checkout is the important one. Somebody developing the plugin has their
 * work in that tree, and an auto-update that blew it away over a release would
 * be unforgivable -- and would look exactly like data loss with no cause.
 */
export function updateBlocker(root = pluginRoot()) {
  if (fs.existsSync(path.join(root, '.git'))) {
    return 'this is a git checkout -- update it with git, not by replacing it';
  }
  try {
    fs.accessSync(path.dirname(root), fs.constants.W_OK);
    fs.accessSync(root, fs.constants.W_OK);
  } catch {
    return `${root} is not writable`;
  }
  return null;
}

/** Does `dir` look like an unpacked plugin? */
function looksLikePlugin(dir) {
  return REQUIRED.every((rel) => fs.existsSync(path.join(dir, rel)));
}

/**
 * Find the plugin root inside an extracted tarball.
 *
 * The release tarball has no wrapping directory, but a GitHub source tarball
 * (the fallback path, and what someone might hand us by URL) has exactly one.
 * Accept both rather than depending on how the archive happened to be rolled.
 */
function findRoot(dir) {
  if (looksLikePlugin(dir)) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 1) {
    const inner = path.join(dir, entries[0].name);
    if (looksLikePlugin(inner)) return inner;
  }
  return null;
}

/** Extract a .tar.gz. Uses system tar, which every supported platform now has. */
function extract(tarball, into) {
  fs.mkdirSync(into, { recursive: true });
  // -o drops the archive's ownership, which matters when a release is rolled by
  // a CI runner whose uid means nothing on this machine.
  execFileSync('tar', ['xzf', tarball, '-C', into, '-o'], { stdio: 'pipe' });
}

/**
 * Work out what an update would do, without doing any of it.
 *
 * Shared by `prmpt update --check`, the auto-updater and the real update, so
 * all three agree on what "behind" means.
 */
export async function planUpdate({ root = pluginRoot(), tag, repo, token, apiBase } = {}) {
  const current = currentVersion(root);
  const release = tag
    ? await releaseByTag(tag, { repo, token, apiBase })
    : await latestRelease({ repo, token, apiBase });

  if (!release) {
    return { current, release: null, action: 'none', reason: 'no release with an installable tarball' };
  }
  // An explicit tag is an instruction, not a suggestion: pinning to an older
  // version is a legitimate thing to ask for, so only the automatic path
  // requires the release to be newer.
  if (!tag && !isNewer(release.version, current)) {
    return { current, release, action: 'none', reason: 'already up to date' };
  }
  return {
    current,
    release,
    action: tag && !isNewer(release.version, current) ? 'pin' : 'update',
    reason: null,
  };
}

/**
 * Download, verify and swap in a release.
 *
 * Returns a summary. Throws with a legible message on any failure, having left
 * the existing install in place.
 */
export async function applyUpdate({ root = pluginRoot(), tag, repo, token, plan, apiBase } = {}) {
  const blocker = updateBlocker(root);
  if (blocker) throw new Error(`prmpt: refusing to update -- ${blocker}`);

  const resolved = plan ?? (await planUpdate({ root, tag, repo, token, apiBase }));
  if (resolved.action === 'none') {
    return { updated: false, from: resolved.current, to: resolved.current, reason: resolved.reason };
  }
  const release = resolved.release;

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-update-'));
  const backup = `${root}.old-${process.pid}`;
  let swapped = false;

  try {
    const tarball = path.join(staging, release.tarballName);
    await download(release.tarballUrl, tarball);
    // Verified before a single byte is unpacked over the install.
    await verifyTarball(release, tarball, { repo, token, apiBase });

    const unpacked = path.join(staging, 'unpacked');
    extract(tarball, unpacked);

    const incoming = findRoot(unpacked);
    if (!incoming) {
      throw new Error(`prmpt: ${release.tarballName} does not contain a plugin (missing ${REQUIRED.join(', ')})`);
    }

    // Stage the new tree next to the install, on the same filesystem, so the
    // swap below is a rename and not a copy that can half-finish.
    const staged = `${root}.new-${process.pid}`;
    fs.rmSync(staged, { recursive: true, force: true });
    fs.cpSync(incoming, staged, { recursive: true });
    ensureExecutable(staged);

    fs.renameSync(root, backup);
    swapped = true;
    try {
      fs.renameSync(staged, root);
    } catch (err) {
      // The install directory does not exist right now. Putting it back is more
      // important than reporting why the second rename failed.
      fs.renameSync(backup, root);
      swapped = false;
      throw err;
    }

    fs.rmSync(backup, { recursive: true, force: true });
    return {
      updated: true,
      from: resolved.current,
      to: release.version,
      tag: release.tag,
      notesUrl: release.notesUrl,
    };
  } catch (err) {
    if (swapped && !fs.existsSync(root) && fs.existsSync(backup)) {
      try { fs.renameSync(backup, root); } catch { /* leave the backup for a human */ }
    }
    throw err;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(`${root}.new-${process.pid}`, { recursive: true, force: true });
  }
}

/**
 * Restore the executable bit on the entry points.
 *
 * `tar` preserves modes, but `fs.cpSync` is what actually lands the tree here
 * and a umask can still take the bit off. The hook is invoked as `node <path>`
 * by every host, so this is belt and braces rather than load-bearing -- except
 * for anyone running `prmpt` directly off the install dir.
 */
function ensureExecutable(root) {
  for (const rel of ['bin/prmpt.mjs', 'hooks/turn-end.mjs', 'install.sh']) {
    const file = path.join(root, rel);
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
    } catch { /* best effort */ }
  }
}
