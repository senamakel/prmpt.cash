// register.mjs -- the one part of the plugin that is allowed to be loud.
//
// HOME and XDG_CONFIG_HOME are pointed at a throwaway directory in every test,
// so a developer's real ~/.config/adengine/config.json is never touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REGISTER, baseEnv, run, stubServer, tmpDir } from './helpers.mjs';

const GOOD_WALLET = '4Nd1mHb6QpJqRZ3nT8vKxYwsFgLpA2cDeUvWxYzAbCd';
const MINTED_KEY = 'ak_live_ThisIsTheMintedApiKeySecretValue';

function cfgPath(home) {
  return path.join(home, '.config', 'adengine', 'config.json');
}

async function register(args, { home = tmpDir('adengine-reg-'), handler } = {}) {
  const server = await stubServer(handler ?? (() => ({
    data: { registerPublisher: { installId: 'inst_42', apiKey: MINTED_KEY } },
  })));
  try {
    const res = await run(REGISTER, {
      args,
      env: baseEnv({ HOME: home, ADENGINE_ENDPOINT: server.url }),
    });
    return { res, home, server };
  } finally {
    await server.close();
  }
}

test('sanity: GOOD_WALLET is inside the accepted length window', () => {
  assert.ok(GOOD_WALLET.length >= 32 && GOOD_WALLET.length <= 44, `len ${GOOD_WALLET.length}`);
});

test('no argument prints usage and exits 2 without contacting the backend', async () => {
  const { res, server, home } = await register([]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage: node hooks\/register\.mjs/);
  assert.equal(server.requests.length, 0);
  assert.ok(!fs.existsSync(cfgPath(home)));
});

test('--help exits 0', async () => {
  const { res } = await register(['--help']);
  assert.equal(res.code, 0);
  assert.match(res.stderr, /usage:/);
});

for (const [label, wallet, pattern] of [
  ['too short', '4Nd1mHb6QpJqRZ3nT8vKxYwsFgLpA', /32-44 characters/],
  ['too long', '4Nd1mHb6QpJqRZ3nT8vKxYwsFgLpA2cDeUvWxYzAbCdEfGhJk', /32-44 characters/],
  ['non-base58 (contains 0)', '4Nd1mHb6QpJqRZ3nT8vKxYwsFgLpA2cDeUvWxYzAb0d', /base58/],
  ['non-base58 (contains O)', '4Nd1mHb6QpJqRZ3nT8vKxYwsFgLpA2cDeUvWxYzAbOd', /base58/],
  ['non-base58 (contains l)', '4Nd1mHb6QpJqRZ3nT8vKxYwsFgLpA2cDeUvWxYzAbld', /base58/],
  ['non-base58 (contains I)', '4Nd1mHb6QpJqRZ3nT8vKxYwsFgLpA2cDeUvWxYzAbId', /base58/],
  ['non-base58 (punctuation)', '4Nd1mHb6QpJqRZ3nT8vKxYwsFgLpA2cDeUvWxYzAb-d', /base58/],
]) {
  test(`rejects a wallet that is ${label}`, async () => {
    const { res, server, home } = await register([wallet]);
    assert.equal(res.code, 1, `expected exit 1 for ${label}`);
    assert.match(res.stderr, /invalid Solana wallet/);
    assert.match(res.stderr, pattern);
    assert.equal(res.stdout, '');
    assert.equal(server.requests.length, 0, 'an invalid wallet must never be sent');
    assert.ok(!fs.existsSync(cfgPath(home)), 'nothing should be written for an invalid wallet');
  });
}

test('a valid wallet writes config.json at mode 0600 in a 0700 directory', async () => {
  const { res, home, server } = await register([GOOD_WALLET]);

  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');

  const file = cfgPath(home);
  assert.ok(fs.existsSync(file), 'config.json should exist');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.apiKey, MINTED_KEY);
  assert.equal(cfg.installId, 'inst_42');
  assert.equal(cfg.solanaWallet, GOOD_WALLET);
  assert.equal(cfg.endpoint, server.url);

  // The wallet did reach the backend, as the registration mutation.
  assert.equal(server.requests[0].body.variables.solanaWallet, GOOD_WALLET);
});

test('the printed confirmation masks the key rather than echoing it', async () => {
  const { res } = await register([GOOD_WALLET]);

  assert.ok(!res.stdout.includes(MINTED_KEY), 'the full API key must never be printed');
  assert.ok(!res.stderr.includes(MINTED_KEY));
  assert.match(res.stdout, /api key:\s+ak_l\*+alue/);
  assert.match(res.stdout, /\(stored, not shown\)/);
  assert.ok(res.stdout.includes(GOOD_WALLET), 'the wallet is public and is shown');
  // Only the first and last four characters of the key ever appear.
  assert.ok(!res.stdout.includes(MINTED_KEY.slice(0, 8)));
});

test('an existing config.json is merged, not clobbered, and stays 0600', async () => {
  const home = tmpDir('adengine-reg-merge-');
  const file = cfgPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ keepMe: 'yes', apiKey: 'old' }), { mode: 0o644 });

  const { res } = await register([GOOD_WALLET], { home });
  assert.equal(res.code, 0, res.stderr);

  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.keepMe, 'yes');
  assert.equal(cfg.apiKey, MINTED_KEY);
  // writeFileSync's mode only applies on create, so the explicit chmod matters.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a backend failure is reported loudly and writes nothing', async () => {
  const { res, home } = await register([GOOD_WALLET], {
    handler: (_body, _req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"nope"}');
    },
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /registration failed/);
  assert.match(res.stderr, /endpoint was http/);
  assert.ok(!fs.existsSync(cfgPath(home)));
});

test('a response with no API key is an error, not a half-written config', async () => {
  const { res, home } = await register([GOOD_WALLET], {
    handler: () => ({ data: { registerPublisher: { installId: 'inst_42' } } }),
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no API key/);
  assert.ok(!fs.existsSync(cfgPath(home)));
});

test('a GraphQL errors response is reported', async () => {
  const { res } = await register([GOOD_WALLET], {
    handler: () => ({ data: null, errors: [{ message: 'wallet already registered' }] }),
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /wallet already registered/);
});

test('surrounding whitespace on the wallet is tolerated', async () => {
  const { res, home } = await register([`  ${GOOD_WALLET}  `]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath(home), 'utf8')).solanaWallet, GOOD_WALLET);
});
