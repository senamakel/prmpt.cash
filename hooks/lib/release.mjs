// prmpt -- the GitHub Releases client.
//
// Releases are the distribution channel: a tag builds a tarball and a
// SHA256SUMS file, and both the installer and `prmpt update` pull from there.
// This module only *reads* the release; swapping code on disk is update.mjs.
//
// On what the checksum does and does not prove: SHA256SUMS is published as an
// asset of the same release as the tarball, so verifying against it detects a
// truncated or corrupted download, and a CDN or proxy serving the wrong bytes.
// It does NOT prove the release is genuine -- anyone who can publish a release
// can publish a matching sum. That trust is anchored in GitHub and in whoever
// holds the repository's release permission, and no amount of hashing changes
// it. Detached signing (minisign/cosign) is what would, and is not done here.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The repository releases are published from. */
export const RELEASE_REPO = 'senamakel/prmpt.click';

const API_BASE = 'https://api.github.com';

/**
 * The API root, overridable ONLY by an explicit argument.
 *
 * Deliberately not read from the environment. Auto-update is on by default and
 * unpacks whatever this host serves, so an env var here would be a one-line
 * remote code execution against anybody whose environment an attacker can
 * influence -- a CI config, a dotfile, a poisoned direnv. Tests pass `apiBase`
 * directly, which needs the ability to call this function, and anyone who has
 * that already runs code in this process.
 */
function apiBase(opts) {
  return opts?.apiBase ?? API_BASE;
}

/** Ten seconds: an update is background work, but it must not hang forever. */
const DEFAULT_TIMEOUT_MS = 10000;

/** A GitHub API request with a hard deadline. Returns parsed JSON. */
async function api(url, { timeoutMs = DEFAULT_TIMEOUT_MS, token } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'prmpt-plugin',
      'x-github-api-version': '2022-11-28',
    };
    // Unauthenticated is 60 requests per hour per IP. That is ample for a daily
    // check, but CI runners share an IP with everything else on the host, so a
    // token is honoured when one happens to be in the environment.
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      await res.text().catch(() => {});
      const err = new Error(`prmpt: GitHub API ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The asset names a release is expected to carry. */
function tarballName(version) {
  return `prmpt-${String(version).replace(/^v/i, '')}.tar.gz`;
}

/**
 * Normalise a GitHub release object into just what the updater needs.
 *
 * A release with no tarball asset is treated as absent rather than as an error:
 * that is what a source-only release looks like, and there is nothing to
 * install from it.
 */
function normalize(release) {
  if (!release || typeof release !== 'object') return null;
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  if (!tag) return null;

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const find = (name) => assets.find((a) => a && a.name === name);
  const tarball = find(tarballName(tag));
  const sums = find('SHA256SUMS');
  if (!tarball || !tarball.browser_download_url) return null;

  return {
    tag,
    version: tag.replace(/^v/i, ''),
    tarballName: tarball.name,
    tarballUrl: tarball.browser_download_url,
    sumsUrl: sums?.browser_download_url ?? null,
    prerelease: release.prerelease === true,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    notesUrl: typeof release.html_url === 'string' ? release.html_url : null,
  };
}

/**
 * The newest published release.
 *
 * `/releases/latest` deliberately excludes prereleases and drafts, which is the
 * behaviour we want: an rc must never be picked up by an install that did not
 * ask for it by tag.
 */
export async function latestRelease(opts = {}) {
  const repo = opts.repo ?? RELEASE_REPO;
  try {
    return normalize(await api(`${apiBase(opts)}/repos/${repo}/releases/latest`, opts));
  } catch (err) {
    // A repository with no releases yet answers 404, and so does one whose
    // releases are all prereleases or drafts. That is a legitimate state, not a
    // failure -- there is simply nothing to update to. Anything else (rate
    // limiting, a network error, a 5xx) is a real problem and still throws.
    if (err?.status === 404) return null;
    throw err;
  }
}

/** One specific release by tag, prereleases included. */
export async function releaseByTag(tag, opts = {}) {
  const repo = opts.repo ?? RELEASE_REPO;
  const encoded = encodeURIComponent(String(tag).trim());
  try {
    return normalize(await api(`${apiBase(opts)}/repos/${repo}/releases/tags/${encoded}`, opts));
  } catch (err) {
    // Unlike `latest`, a 404 here means the caller named a tag that does not
    // exist. That is worth saying plainly rather than reporting as "no update".
    if (err?.status === 404) {
      throw new Error(`prmpt: no release tagged ${tag} in ${repo}`);
    }
    throw err;
  }
}

/** Download a URL to `dest`, following redirects, with a deadline. */
export async function download(url, dest, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'prmpt-plugin', accept: 'application/octet-stream' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`prmpt: download failed, HTTP ${res.status} for ${url}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0) throw new Error(`prmpt: download was empty: ${url}`);
    fs.writeFileSync(dest, body);
    return body.length;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a SHA256SUMS body as text. */
export async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'prmpt-plugin' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`prmpt: HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** sha256 of a file, lowercase hex. */
export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Pull one file's expected digest out of a `sha256sum` style listing.
 *
 * The format is `<hex>  <name>`, two spaces by convention but any run of
 * whitespace in practice, and the name may carry a `*` binary marker. Returns
 * null when the file is not listed, which the caller must treat as a refusal to
 * install -- not as "no checksum required".
 */
export function digestFor(sumsText, name) {
  for (const line of String(sumsText ?? '').split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m && path.basename(m[2]) === name) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Verify a downloaded tarball against the release's SHA256SUMS.
 *
 * Throws on mismatch, on a missing entry, and when the release published no
 * sums at all. Every one of those is "we cannot show this is the file the
 * release meant", and unverified bytes must not be unpacked over an install.
 */
export async function verifyTarball(release, file, opts = {}) {
  if (!release.sumsUrl) {
    throw new Error(`prmpt: release ${release.tag} publishes no SHA256SUMS; refusing to install it`);
  }
  const sums = await fetchText(release.sumsUrl, opts);
  const expected = digestFor(sums, release.tarballName);
  if (!expected) {
    throw new Error(`prmpt: ${release.tarballName} is not listed in SHA256SUMS for ${release.tag}`);
  }
  const actual = sha256File(file);
  if (actual !== expected) {
    throw new Error(
      `prmpt: checksum mismatch for ${release.tarballName}\n  expected ${expected}\n  got      ${actual}`,
    );
  }
  return expected;
}
