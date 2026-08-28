// The plugin -> web handoff.
//
// `prmpt login` ends by opening a page on the site, and `prmpt onboard` is how
// a user gets a fresh link when the two-minute code from that one has expired.
// The URL construction is the part worth pinning: it is the only place a
// destination is attached to a session code, and getting the encoding wrong
// truncates the path silently rather than failing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { webSessionURL } from '../bin/prmpt.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/prmpt.mjs', import.meta.url));

async function prmpt(args, home, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function scratchHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-onboard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('webSessionURL leaves a bare session link alone', () => {
  assert.equal(
    webSessionURL('https://prmpt.cash/s/abc', ''),
    'https://prmpt.cash/s/abc',
  );
});

test('webSessionURL appends an encoded next path', () => {
  assert.equal(
    webSessionURL('https://prmpt.cash/s/abc', '/onboarding'),
    'https://prmpt.cash/s/abc?next=%2Fonboarding',
  );
});

test('webSessionURL encodes a next path that has a query of its own', () => {
  // Unencoded, the inner `?` would end this query string and `tab` would
  // become a parameter of the sign-in page rather than part of the
  // destination -- so the redirect would silently drop it.
  const url = webSessionURL('https://prmpt.cash/s/abc', '/onboarding?tab=accounts');
  assert.equal(url, 'https://prmpt.cash/s/abc?next=%2Fonboarding%3Ftab%3Daccounts');
  assert.equal(new URL(url).searchParams.get('next'), '/onboarding?tab=accounts');
});

test('webSessionURL joins with & when the base already has a query', () => {
  const url = webSessionURL('https://prmpt.cash/s/abc?x=1', '/onboarding');
  assert.equal(url, 'https://prmpt.cash/s/abc?x=1&next=%2Fonboarding');
  assert.equal(new URL(url).searchParams.get('next'), '/onboarding');
});

test('onboard without a token says to log in first, and does not crash', async (t) => {
  const home = scratchHome(t);
  const res = await prmpt(['onboard'], home);

  assert.notEqual(res.code, 0);
  assert.match(res.stderr + res.stdout, /prmpt login/);
});

test('help documents the onboard command', async (t) => {
  const home = scratchHome(t);
  const res = await prmpt(['help'], home);

  assert.equal(res.code, 0);
  assert.match(res.stdout, /^\s+onboard\s/m);
  // The expiry is the thing that makes a second command necessary at all, so
  // the help has to say the link is short-lived.
  assert.match(res.stdout, /expires quickly|expires/i);
});

test('an unknown command is still refused', async (t) => {
  const home = scratchHome(t);
  const res = await prmpt(['onboarding'], home);

  // 'onboarding' is NOT an alias. Accepting near-misses silently would make
  // the real command's name unlearnable.
  assert.notEqual(res.code, 0);
  assert.match(res.stderr + res.stdout, /unknown command/);
});
