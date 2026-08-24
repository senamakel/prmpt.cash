// prmpt -- the hook enrolling itself.
//
// An install with no token used to be inert forever: the only way in was a
// browser visit and a pasted code. Now the first unauthenticated turn detaches
// a `prmpt login` child, which creates a wallet and signs in, and the turn after
// it serves normally.
//
// The property that actually matters is that the turn itself is unaffected: no
// output, exit 0, and no waiting on the child.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { decodeBase58 } from '../hooks/lib/base58.mjs';
import {
  assertSilentSuccess,
  baseEnv,
  decision,
  runHook,
  stubServer,
  tmpDir,
  LONG_TURN,
} from './helpers.mjs';

const ENROLLED_TOKEN = 'eyJ.enrolled.TOKEN';

/** Answer siwsChallenge/siwsVerify for real, and serveAd with a decision. */
function siwsHandler(state) {
  return (body) => {
    const query = body?.query ?? '';
    if (query.includes('siwsChallenge')) {
      const nonce = crypto.randomBytes(8).toString('hex');
      const message = `stub wants you to sign in with your Solana account:\n${body.variables.wallet}\n\nNonce: ${nonce}`;
      state.challenges.set(nonce, { wallet: body.variables.wallet, message });
      return { data: { siwsChallenge: { wallet: body.variables.wallet, nonce, message, expiresAt: null } } };
    }
    if (query.includes('siwsVerify')) {
      const challenge = state.challenges.get(body.variables.nonce);
      state.challenges.delete(body.variables.nonce);
      const spki = Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(decodeBase58(body.variables.wallet)),
      ]);
      const ok = challenge && crypto.verify(
        null,
        Buffer.from(challenge.message, 'utf8'),
        crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }),
        Buffer.from(decodeBase58(body.variables.signature)),
      );
      if (!ok) return { errors: [{ message: 'auth: signature does not verify' }] };
      state.enrolled.push(body.variables.wallet);
      return {
        data: {
          siwsVerify: {
            token: ENROLLED_TOKEN,
            expiresAt: '2099-01-01T00:00:00Z',
            publisher: { installId: 'enrolled-install', solanaWallet: body.variables.wallet },
          },
        },
      };
    }
    return decision();
  };
}

/** Poll for `file` to appear. The enrolling child is detached, so nothing to await. */
async function waitForFile(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function payload(over = {}) {
  return JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: LONG_TURN, ...over });
}

test('an unauthenticated turn enrols in the background and stays silent', async () => {
  const state = { challenges: new Map(), enrolled: [] };
  const server = await stubServer(siwsHandler(state));
  const home = tmpDir('prmpt-enrol-');
  const configDir = path.join(home, '.config', 'prmpt');

  try {
    const env = baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url });
    const res = await runHook({ env, stdin: payload() });

    // The turn is the thing that must not change: exit 0, nothing printed.
    assertSilentSuccess(res, 'unauthenticated turn');
    // And it did not wait for the child. Two round trips would blow this budget.
    assert.ok(res.ms < 1500, `enrolment must not be on the turn's clock (took ${res.ms}ms)`);

    assert.equal(await waitForFile(path.join(configDir, 'config.json')), true,
      'the detached child should have written a config');

    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert.equal(config.token, ENROLLED_TOKEN);
    assert.equal(config.installId, 'enrolled-install');

    const wallet = JSON.parse(fs.readFileSync(path.join(configDir, 'wallet.json'), 'utf8'));
    assert.equal(wallet.address, config.solanaWallet);
    assert.equal(state.enrolled, state.enrolled.length && state.enrolled);
    assert.deepEqual(state.enrolled, [wallet.address]);

    // The key the child created for an unattended user is still 0600.
    assert.equal(fs.statSync(path.join(configDir, 'wallet.json')).mode & 0o777, 0o600);
  } finally {
    await server.close();
  }
});

test('a second unauthenticated turn does not enrol again', async () => {
  // Each turn is a fresh process, so the only thing stopping an offline machine
  // spawning a child every single turn is the on-disk attempt marker.
  const state = { challenges: new Map(), enrolled: [] };
  const server = await stubServer(() => ({ errors: [{ message: 'nope' }] }));
  const home = tmpDir('prmpt-enrol-twice-');
  const configDir = path.join(home, '.config', 'prmpt');

  try {
    const env = baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url });
    await runHook({ env, stdin: payload() });
    assert.equal(await waitForFile(path.join(configDir, '.enrol-attempt')), true);
    const first = fs.readFileSync(path.join(configDir, '.enrol-attempt'), 'utf8');

    // The marker is written BEFORE the child is spawned, so its existence does
    // not mean the child has finished failing. Wait for its request to land, or
    // the snapshot below races it and counts it against the second turn.
    const deadline = Date.now() + 10000;
    while (server.requests.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(server.requests.length > 0, 'the first child should have reached the server');

    const before = server.requests.length;
    const res = await runHook({ env, stdin: payload() });
    assertSilentSuccess(res, 'second unauthenticated turn');
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(fs.readFileSync(path.join(configDir, '.enrol-attempt'), 'utf8'), first,
      'the attempt marker should not be rewritten inside the retry window');
    assert.equal(server.requests.length, before,
      'a second child should not have been spawned');
  } finally {
    await server.close();
    void state;
  }
});

test('PRMPT_NO_AUTO_ENROL=1 keeps the plugin from creating anything', async () => {
  const server = await stubServer(() => decision());
  const home = tmpDir('prmpt-enrol-off-');
  try {
    const env = baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url, PRMPT_NO_AUTO_ENROL: '1' });
    const res = await runHook({ env, stdin: payload() });
    assertSilentSuccess(res, 'opted out');
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(fs.existsSync(path.join(home, '.config', 'prmpt', 'wallet.json')), false);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('PRMPT_DISABLED=1 wins over enrolment', async () => {
  const server = await stubServer(() => decision());
  const home = tmpDir('prmpt-enrol-disabled-');
  try {
    const env = baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url, PRMPT_DISABLED: '1' });
    const res = await runHook({ env, stdin: payload() });
    assertSilentSuccess(res, 'disabled');
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(fs.existsSync(path.join(home, '.config', 'prmpt')), false,
      'an opted-out install should have nothing created for it at all');
  } finally {
    await server.close();
  }
});

test('an already-linked install serves as before and never enrols', async () => {
  const server = await stubServer(() => decision());
  const home = tmpDir('prmpt-enrol-linked-');
  const configDir = path.join(home, '.config', 'prmpt');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ token: 'existing-token', installId: 'existing' }),
  );

  try {
    const env = baseEnv({ HOME: home, PRMPT_ENDPOINT: server.url });
    const res = await runHook({ env, stdin: payload() });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /Sponsored/);
    assert.equal(fs.existsSync(path.join(configDir, 'wallet.json')), false,
      'an install linked by dashboard code must not have a local key created for it');
    assert.equal(server.requests.length, 1);
    assert.ok(server.requests[0].body.query.includes('serveAd'));
  } finally {
    await server.close();
  }
});
