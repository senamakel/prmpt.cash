// prmpt -- self-update.
//
// The stub serves a real, real-tarball release over HTTP: the API JSON, the
// .tar.gz and a genuine SHA256SUMS. So these exercise the actual download,
// checksum, extract and swap path, not a mocked version of it.
//
// The properties that matter are all about what happens when it goes wrong.
// An update that works is worth one test; an update that fails must leave the
// install exactly as it was, and that is worth most of this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { parseVersion, compareVersions, isNewer, currentVersion } from '../hooks/lib/version.mjs';
import { digestFor, latestRelease, releaseByTag } from '../hooks/lib/release.mjs';
import { planUpdate, applyUpdate, updateBlocker } from '../hooks/lib/update.mjs';

const scratch = [];
process.on('exit', () => {
  for (const d of scratch) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});
function tmp(prefix = 'prmpt-upd-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(d);
  return d;
}

/** A minimal but structurally valid plugin tree at `version`. */
function makePlugin(dir, version, marker = '') {
  fs.mkdirSync(path.join(dir, 'hooks', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'prmpt', version }, null, 2));
  fs.writeFileSync(path.join(dir, 'hooks', 'turn-end.mjs'), `// turn-end ${version} ${marker}\n`);
  fs.writeFileSync(path.join(dir, 'hooks', 'lib', 'config.mjs'), `// config ${version}\n`);
  fs.writeFileSync(path.join(dir, 'bin', 'prmpt.mjs'), `// cli ${version}\n`);
  return dir;
}

/** Roll a flat release tarball of a plugin tree, as release.yml does. */
function makeTarball(version, { marker = '', wrapped = false, broken = false } = {}) {
  const stage = tmp('prmpt-stage-');
  const inner = wrapped ? path.join(stage, `prmpt-${version}`) : stage;
  if (broken) {
    // Structurally a tarball, but not a plugin.
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'README.md'), 'nothing useful here\n');
  } else {
    makePlugin(inner, version, marker);
  }
  const out = path.join(tmp('prmpt-tar-'), `prmpt-${version}.tar.gz`);
  execFileSync('tar', ['czf', out, '-C', wrapped ? stage : inner, '.'], { stdio: 'pipe' });
  return out;
}

/**
 * A stub GitHub: /repos/:owner/:repo/releases/latest and /tags/:tag, plus the
 * asset downloads. `corrupt` serves a tarball whose bytes do not match the sum.
 */
async function startGitHub({ version = '0.2.0', tag, assets = true, sums = true, corrupt = false, tarball } = {}) {
  const tarPath = tarball ?? makeTarball(version);
  const body = fs.readFileSync(tarPath);
  const served = corrupt ? Buffer.concat([body, Buffer.from('tampered')]) : body;
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const name = `prmpt-${version}.tar.gz`;
  const hits = [];

  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url.includes('/releases/')) {
      const list = [];
      if (assets) list.push({ name, browser_download_url: `${base}/dl/${name}` });
      if (sums) list.push({ name: 'SHA256SUMS', browser_download_url: `${base}/dl/SHA256SUMS` });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        tag_name: tag ?? `v${version}`,
        prerelease: false,
        published_at: '2026-08-25T00:00:00Z',
        html_url: 'https://example.test/releases',
        assets: list,
      }));
    }
    if (req.url.endsWith('/SHA256SUMS')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`${digest}  ${name}\n`);
    }
    if (req.url.endsWith(name)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(served);
    }
    res.writeHead(404);
    res.end('no');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

// --- version comparison -----------------------------------------------------

test('parseVersion accepts releases and refuses junk', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: null });
  assert.equal(parseVersion('1.2.3-rc.1').prerelease, 'rc.1');
  for (const bad of ['latest', '2026-08', 'v1.2', '', null]) {
    assert.equal(parseVersion(bad), null, `${bad} should not parse`);
  }
});

test('a prerelease sorts before its release', () => {
  // Someone on an rc must be moved onto the final, and never back again.
  assert.equal(compareVersions('0.2.0', '0.2.0-rc.1'), 1);
  assert.equal(isNewer('0.2.0', '0.2.0-rc.1'), true);
  assert.equal(isNewer('0.2.0-rc.1', '0.2.0'), false);
});

test('isNewer is false rather than throwing on junk', () => {
  // An unparseable version must never be a reason to replace working code.
  assert.equal(isNewer('latest', '0.1.0'), false);
  assert.equal(isNewer('0.2.0', 'nonsense'), false);
});

test('digestFor reads sha256sum output, and refuses a missing entry', () => {
  const sums = `${'a'.repeat(64)}  prmpt-0.2.0.tar.gz\n${'b'.repeat(64)} *other.tgz\n`;
  assert.equal(digestFor(sums, 'prmpt-0.2.0.tar.gz'), 'a'.repeat(64));
  assert.equal(digestFor(sums, 'other.tgz'), 'b'.repeat(64));
  assert.equal(digestFor(sums, 'absent.tgz'), null);
});

test('a repo with no releases is "nothing to update to", not an error', async () => {
  // The state this project is in until the first tag is cut. It must not look
  // like a failure, or every install spawns a daily child that reports one.
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await latestRelease({ apiBase }), null);
    const dir = makePlugin(tmp(), '0.1.0');
    const plan = await planUpdate({ root: dir, apiBase });
    assert.equal(plan.action, 'none');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a named tag that does not exist is reported as such', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(releaseByTag('v9.9.9', { apiBase }), /no release tagged v9\.9\.9/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a rate-limited or broken API still throws', async () => {
  // Only 404 is benign. A 403 (rate limit) or 500 must not be mistaken for
  // "you are up to date", which would hide a stuck updater forever.
  const server = http.createServer((_req, res) => { res.writeHead(403); res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(latestRelease({ apiBase }), /GitHub API 403/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- refusals ---------------------------------------------------------------

test('a git checkout is never replaced', () => {
  const dir = makePlugin(tmp(), '0.1.0');
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: elsewhere\n');
  assert.match(updateBlocker(dir), /git checkout/);
});

test('applyUpdate refuses a checkout even when a newer release exists', async () => {
  const gh = await startGitHub({ version: '0.2.0' });
  try {
    const dir = makePlugin(tmp(), '0.1.0');
    fs.mkdirSync(path.join(dir, '.git'));
    await assert.rejects(
      applyUpdate({ root: dir, apiBase: gh.apiBase }),
      /refusing to update/,
    );
    // Not one request was made: it refused before asking.
    assert.equal(gh.hits.length, 0);
  } finally {
    await gh.close();
  }
});

// --- the happy path ---------------------------------------------------------

test('a newer release is downloaded, verified and swapped in', async () => {
  const gh = await startGitHub({ version: '0.2.0' });
  try {
    const dir = makePlugin(tmp(), '0.1.0', 'OLD');
    const result = await applyUpdate({ root: dir, apiBase: gh.apiBase });

    assert.equal(result.updated, true);
    assert.equal(result.from, '0.1.0');
    assert.equal(result.to, '0.2.0');
    assert.equal(currentVersion(dir), '0.2.0');
    assert.match(fs.readFileSync(path.join(dir, 'hooks', 'turn-end.mjs'), 'utf8'), /0\.2\.0/);

    // No debris beside the install.
    const siblings = fs.readdirSync(path.dirname(dir));
    assert.equal(siblings.filter((n) => n.includes('.old-') || n.includes('.new-')).length, 0);
  } finally {
    await gh.close();
  }
});

test('a tarball with a wrapping directory is handled too', async () => {
  const gh = await startGitHub({ version: '0.2.0', tarball: makeTarball('0.2.0', { wrapped: true }) });
  try {
    const dir = makePlugin(tmp(), '0.1.0');
    assert.equal((await applyUpdate({ root: dir, apiBase: gh.apiBase })).updated, true);
    assert.equal(currentVersion(dir), '0.2.0');
  } finally {
    await gh.close();
  }
});

test('an install already current does nothing at all', async () => {
  const gh = await startGitHub({ version: '0.2.0' });
  try {
    const dir = makePlugin(tmp(), '0.2.0');
    const result = await applyUpdate({ root: dir, apiBase: gh.apiBase });
    assert.equal(result.updated, false);
    assert.match(result.reason, /up to date/);
    // And it never downloaded the asset.
    assert.equal(gh.hits.some((u) => u.includes('.tar.gz')), false);
  } finally {
    await gh.close();
  }
});

test('a newer install is not downgraded by the automatic path', async () => {
  const gh = await startGitHub({ version: '0.2.0' });
  try {
    const dir = makePlugin(tmp(), '0.9.0');
    assert.equal((await applyUpdate({ root: dir, apiBase: gh.apiBase })).updated, false);
    assert.equal(currentVersion(dir), '0.9.0');
  } finally {
    await gh.close();
  }
});

test('an explicit --version tag may pin backwards', async () => {
  const gh = await startGitHub({ version: '0.1.0' });
  try {
    const dir = makePlugin(tmp(), '0.9.0');
    const plan = await planUpdate({ root: dir, tag: 'v0.1.0', apiBase: gh.apiBase });
    assert.equal(plan.action, 'pin');
    const result = await applyUpdate({ root: dir, tag: 'v0.1.0', apiBase: gh.apiBase });
    assert.equal(result.updated, true);
    assert.equal(currentVersion(dir), '0.1.0');
  } finally {
    await gh.close();
  }
});

// --- failure must not damage the install ------------------------------------

test('a checksum mismatch aborts and leaves the install untouched', async () => {
  const gh = await startGitHub({ version: '0.2.0', corrupt: true });
  try {
    const dir = makePlugin(tmp(), '0.1.0', 'ORIGINAL');
    await assert.rejects(
      applyUpdate({ root: dir, apiBase: gh.apiBase }),
      /checksum mismatch/,
    );
    assert.equal(currentVersion(dir), '0.1.0');
    assert.match(fs.readFileSync(path.join(dir, 'hooks', 'turn-end.mjs'), 'utf8'), /ORIGINAL/);
  } finally {
    await gh.close();
  }
});

test('a release with no SHA256SUMS is refused outright', async () => {
  const gh = await startGitHub({ version: '0.2.0', sums: false });
  try {
    const dir = makePlugin(tmp(), '0.1.0');
    await assert.rejects(
      applyUpdate({ root: dir, apiBase: gh.apiBase }),
      /publishes no SHA256SUMS|no release with an installable tarball/,
    );
    assert.equal(currentVersion(dir), '0.1.0');
  } finally {
    await gh.close();
  }
});

test('a tarball that is not a plugin is refused, install intact', async () => {
  const gh = await startGitHub({ version: '0.2.0', tarball: makeTarball('0.2.0', { broken: true }) });
  try {
    const dir = makePlugin(tmp(), '0.1.0', 'ORIGINAL');
    await assert.rejects(
      applyUpdate({ root: dir, apiBase: gh.apiBase }),
      /does not contain a plugin/,
    );
    assert.equal(currentVersion(dir), '0.1.0');
    assert.match(fs.readFileSync(path.join(dir, 'hooks', 'turn-end.mjs'), 'utf8'), /ORIGINAL/);
  } finally {
    await gh.close();
  }
});

test('a release with no tarball asset is treated as no release', async () => {
  const gh = await startGitHub({ version: '0.2.0', assets: false });
  try {
    const dir = makePlugin(tmp(), '0.1.0');
    const plan = await planUpdate({ root: dir, apiBase: gh.apiBase });
    assert.equal(plan.action, 'none');
    assert.equal(plan.release, null);
  } finally {
    await gh.close();
  }
});

test('an unreachable API fails without harming the install', async () => {
  const dir = makePlugin(tmp(), '0.1.0');
  await assert.rejects(applyUpdate({ root: dir, apiBase: 'http://127.0.0.1:1' }));
  assert.equal(currentVersion(dir), '0.1.0');
});

// --- the credential boundary ------------------------------------------------

test('updating never touches ~/.config/prmpt', async () => {
  // The whole justification for updating in place is that the key is not in
  // the directory being replaced. Prove it.
  const gh = await startGitHub({ version: '0.2.0' });
  const home = tmp('prmpt-home-');
  const configDir = path.join(home, 'prmpt');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'wallet.json'), '{"secretKey":"IRREPLACEABLE"}');
  fs.writeFileSync(path.join(configDir, 'config.json'), '{"token":"KEEP ME"}');

  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  try {
    const dir = makePlugin(tmp(), '0.1.0');
    assert.equal((await applyUpdate({ root: dir, apiBase: gh.apiBase })).updated, true);
    assert.match(fs.readFileSync(path.join(configDir, 'wallet.json'), 'utf8'), /IRREPLACEABLE/);
    assert.match(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'), /KEEP ME/);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await gh.close();
  }
});
