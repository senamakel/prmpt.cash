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

// --- the installer's hand-off ------------------------------------------------
//
// `prmpt login` finishes by minting a signed-in link. The installer does NOT
// want that: the code is single-use and lives two minutes, and there are still
// agents to wire and a screen of output to print before anybody is reading. So
// it passes --no-onboard and runs `prmpt onboard` itself at the very end.
//
// Both halves are pinned here, because the failure mode is silent either way: a
// login that stops minting the link leaves every hand-installed user with no
// route to onboarding, and an installer that still gets one minted early hands
// out a link that is already dead.

import crypto from 'node:crypto';
import http from 'node:http';
import { decodeBase58 } from '../hooks/lib/base58.mjs';

/**
 * Just enough backend to complete a SIWS login and mint a web session.
 *
 * The signature is verified for real, against the exact message this stub
 * minted -- a client that rebuilt the message locally would fail here, which is
 * the property test/login.test.mjs exists to hold. `evmChallenge` is left
 * unhandled on purpose: the Base link is best-effort and a login must survive
 * its failure, so the unhappy path is the one exercised.
 */
function startAuthStub() {
  const nonces = new Map();
  const seen = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { query, variables } = JSON.parse(body);
      const send = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (query.includes('siwsChallenge')) {
        const nonce = crypto.randomBytes(16).toString('hex');
        const message = [
          'prmpt.cash wants you to sign in with your Solana account:',
          variables.wallet,
          '',
          'Sign in to your prmpt publisher account.',
          '',
          'URI: https://prmpt.cash',
          'Version: 1',
          'Chain ID: solana:mainnet',
          `Nonce: ${nonce}`,
          `Issued At: ${new Date().toISOString()}`,
        ].join('\n');
        nonces.set(nonce, { wallet: variables.wallet, message });
        seen.push('challenge');
        return send({ data: { siwsChallenge: { wallet: variables.wallet, nonce, message, expiresAt: null } } });
      }

      if (query.includes('siwsVerify')) {
        seen.push('verify');
        const challenge = nonces.get(variables.nonce);
        nonces.delete(variables.nonce);
        const spki = Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'),
          Buffer.from(decodeBase58(variables.wallet)),
        ]);
        const ok = challenge && crypto.verify(
          null,
          Buffer.from(challenge.message, 'utf8'),
          crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }),
          Buffer.from(decodeBase58(variables.signature)),
        );
        if (!ok) return send({ errors: [{ message: 'auth: signature does not verify' }] });
        return send({
          data: {
            siwsVerify: {
              token: 'header.eyJ0eXAiOiJwdWJsaXNoZXIifQ.signature',
              expiresAt: '2099-01-01T00:00:00Z',
              publisher: { installId: 'install-from-server', solanaWallet: variables.wallet },
            },
          },
        });
      }

      if (query.includes('createWebSession')) {
        seen.push('webSession');
        return send({ data: { createWebSession: { code: 'abc', url: 'https://prmpt.cash/s/abc', expiresAt: null } } });
      }

      seen.push('other');
      return send({ errors: [{ message: 'unsupported in this stub' }] });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}/graphql`,
        seen,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('login --no-onboard signs in and mints no session code', async (t) => {
  const home = scratchHome(t);
  const stub = await startAuthStub();
  t.after(() => stub.close());

  const res = await prmpt(['login', '--endpoint', stub.endpoint, '--no-onboard'], home);

  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /prmpt: linked\./);
  // The point of the flag: a code minted here would be dead by the time the
  // installer stopped printing.
  assert.ok(!stub.seen.includes('webSession'), stub.seen.join(','));
  assert.ok(!res.stdout.includes('/s/'), res.stdout);
});

test('login on its own still ends by handing over an onboarding link', async (t) => {
  const home = scratchHome(t);
  const stub = await startAuthStub();
  t.after(() => stub.close());

  // --no-open so the test never launches a browser; the link is still printed.
  const res = await prmpt(['login', '--endpoint', stub.endpoint, '--no-open'], home);

  assert.equal(res.code, 0, res.stderr);
  assert.ok(stub.seen.includes('webSession'), stub.seen.join(','));
  assert.match(res.stdout, /https:\/\/prmpt\.cash\/s\/abc\?next=%2Fonboarding/);
});
