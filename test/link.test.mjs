// link.mjs -- the one part of the plugin that is allowed to be loud.
//
// HOME and XDG_CONFIG_HOME are pointed at a throwaway directory in every test,
// so a developer's real ~/.config/prmpt/config.json is never touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LINK, baseEnv, run, stubServer, tmpDir } from './helpers.mjs';

const GOOD_CODE = 'K3H9F-2QPRS';
const WALLET = '4Nd1mHb6QpJqRZ3nT8vKxYwsFgLpA2cDeUvWxYzAbCd';
// Shaped like a real one: three dot-separated base64url segments.
const MINTED_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwdWJfNDIiLCJ0eXAiOiJwdWJsaXNoZXIifQ.SIGNATURE_MUST_NEVER_BE_PRINTED';

function cfgPath(home) {
  return path.join(home, '.config', 'prmpt', 'config.json');
}

function okHandler() {
  return {
    data: {
      exchangeInstallCode: {
        token: MINTED_TOKEN,
        expiresAt: '2026-09-23T12:00:00Z',
        publisher: { installId: 'inst_42', solanaWallet: WALLET },
      },
    },
  };
}

async function link(args, { home = tmpDir('prmpt-link-'), handler, env } = {}) {
  const server = await stubServer(handler ?? okHandler);
  try {
    const res = await run(LINK, {
      args,
      env: baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url, ...env }),
    });
    return { res, home, server };
  } finally {
    await server.close();
  }
}

test('no argument prints usage and exits 2 without contacting the backend', async () => {
  const { res, server, home } = await link([]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage: node hooks\/link\.mjs/);
  assert.equal(server.requests.length, 0);
  assert.ok(!fs.existsSync(cfgPath(home)));
});

test('--help exits 0', async () => {
  const { res } = await link(['--help']);
  assert.equal(res.code, 0);
  assert.match(res.stderr, /usage:/);
});

for (const [label, code] of [
  ['too short', 'K3H9F-2QP'],
  ['too long', 'K3H9F-2QPRSX'],
  // Every character here is outside the code alphabet, so normalising leaves
  // nothing at all — a different message from a wrong length.
  ['entirely outside the alphabet', 'oil-01ilo'],
]) {
  test(`rejects a code that is ${label}`, async () => {
    const { res, server, home } = await link([code]);
    assert.equal(res.code, 1, `expected exit 1 for ${label}`);
    assert.match(res.stderr, /invalid install code/);
    assert.equal(res.stdout, '');
    assert.equal(server.requests.length, 0, 'an invalid code must never be sent');
    assert.ok(!fs.existsSync(cfgPath(home)), 'nothing should be written for an invalid code');
  });
}

test('a valid code writes config.json at mode 0600 in a 0700 directory', async () => {
  const { res, home, server } = await link([GOOD_CODE]);

  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');

  const file = cfgPath(home);
  assert.ok(fs.existsSync(file), 'config.json should exist');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.token, MINTED_TOKEN);
  assert.equal(cfg.installId, 'inst_42');
  assert.equal(cfg.solanaWallet, WALLET);
  assert.equal(cfg.endpoint, server.url);

  // The code reached the backend NORMALISED — hyphen stripped, upper-cased —
  // which is what the server hashes. Sending it verbatim would fail to match.
  assert.equal(server.requests[0].body.variables.code, 'K3H9F2QPRS');
});

test('a lower-case, unhyphenated, space-padded code is the same code', async () => {
  const { res, home, server } = await link(['  k3h9f 2qprs  ']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(server.requests[0].body.variables.code, 'K3H9F2QPRS');
  assert.equal(JSON.parse(fs.readFileSync(cfgPath(home), 'utf8')).token, MINTED_TOKEN);
});

test('PRMPT_LOGIN_CODE is used when no argument is given', async () => {
  const { res, home, server } = await link([], { env: { PRMPT_LOGIN_CODE: GOOD_CODE } });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(server.requests[0].body.variables.code, 'K3H9F2QPRS');
  assert.equal(JSON.parse(fs.readFileSync(cfgPath(home), 'utf8')).token, MINTED_TOKEN);
});

test('the printed confirmation masks the token rather than echoing it', async () => {
  const { res } = await link([GOOD_CODE]);

  assert.ok(!res.stdout.includes(MINTED_TOKEN), 'the full token must never be printed');
  assert.ok(!res.stderr.includes(MINTED_TOKEN));
  assert.match(res.stdout, /token:\s+eyJhbG\*+/);
  assert.match(res.stdout, /\(stored, not shown\)/);
  // The signature is the part that makes a token usable, and the part most
  // likely to survive a naive truncation.
  assert.ok(!res.stdout.includes('SIGNATURE_MUST_NEVER_BE_PRINTED'));
  assert.ok(res.stdout.includes(WALLET), 'the wallet is public and is shown');
});

test('the confirmation says the token cannot be revoked', async () => {
  // The design has no revocation at all. A publisher who pastes their config
  // somewhere has to know that, and the CLI is the only place they will read it.
  const { res } = await link([GOOD_CODE]);
  assert.match(res.stdout, /cannot be revoked/);
});

test('a retired API key is dropped from an existing config rather than left behind', async () => {
  const home = tmpDir('prmpt-link-merge-');
  const file = cfgPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ keepMe: 'yes', apiKey: 'pub_retired' }), { mode: 0o644 });

  const { res } = await link([GOOD_CODE], { home });
  assert.equal(res.code, 0, res.stderr);

  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.keepMe, 'yes');
  assert.equal(cfg.token, MINTED_TOKEN);
  assert.ok(!('apiKey' in cfg), 'the retired API key must not be left on disk');
  // writeFileSync's mode only applies on create, so the explicit chmod matters.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a backend failure is reported loudly and writes nothing', async () => {
  const { res, home } = await link([GOOD_CODE], {
    handler: (_body, _req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"nope"}');
    },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /linking failed/);
  assert.match(res.stderr, /endpoint was http/);
  assert.ok(!fs.existsSync(cfgPath(home)));
});

test('a response with no token is an error, not a half-written config', async () => {
  const { res, home } = await link([GOOD_CODE], {
    handler: () => ({ data: { exchangeInstallCode: { publisher: { installId: 'inst_42' } } } }),
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no token/);
  assert.ok(!fs.existsSync(cfgPath(home)));
});

test('a GraphQL errors response is reported, with the single-use hint', async () => {
  const { res } = await link([GOOD_CODE], {
    handler: () => ({
      data: null,
      errors: [{ message: 'auth: invalid or expired install code' }],
    }),
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /invalid or expired install code/);
  assert.match(res.stderr, /work once and expire/);
});
