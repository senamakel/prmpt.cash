// prmpt -- SIWS sign-in, end to end against a stub backend.
//
// The stub is deliberately strict: it verifies the ed25519 signature against the
// exact message it minted, exactly as backend/internal/auth/siws.go does, and
// consumes the nonce before checking anything. A client that rebuilt the message
// locally, or base64'd the signature, fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { decodeBase58 } from '../hooks/lib/base58.mjs';

const TOKEN = 'header.eyJ0eXAiOiJwdWJsaXNoZXIifQ.signature';

/** A GraphQL endpoint that speaks just enough SIWS to be worth signing for. */
function startStub({ onVerify = () => {} } = {}) {
  const nonces = new Map();
  const seen = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { query, variables } = JSON.parse(body);
      const reply = (data) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data }));
      };
      const fail = (message) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message }] }));
      };

      if (query.includes('siwsChallenge')) {
        const nonce = crypto.randomBytes(16).toString('hex');
        // Shaped like the real one, including the parts a client cannot know:
        // the domain, the chain id and the issued-at all come from the server.
        const message = [
          'prmpt.cash wants you to sign in with your Solana account:',
          variables.wallet,
          '',
          'Sign in to your prmpt publisher account. This proves you own this wallet.',
          '',
          'URI: https://prmpt.cash',
          'Version: 1',
          'Chain ID: solana:mainnet',
          `Nonce: ${nonce}`,
          `Issued At: ${new Date().toISOString()}`,
        ].join('\n');
        nonces.set(nonce, { wallet: variables.wallet, message });
        seen.push({ op: 'challenge', wallet: variables.wallet });
        return reply({ siwsChallenge: { wallet: variables.wallet, nonce, message, expiresAt: null } });
      }

      if (query.includes('siwsVerify')) {
        seen.push({ op: 'verify', wallet: variables.wallet });
        // Consumed before verification, like the backend's FindOneAndDelete.
        const challenge = nonces.get(variables.nonce);
        nonces.delete(variables.nonce);
        if (!challenge || challenge.wallet !== variables.wallet) {
          return fail('auth: signature does not verify');
        }
        const spki = Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'),
          Buffer.from(decodeBase58(variables.wallet)),
        ]);
        const ok = crypto.verify(
          null,
          Buffer.from(challenge.message, 'utf8'),
          crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }),
          Buffer.from(decodeBase58(variables.signature)),
        );
        if (!ok) return fail('auth: signature does not verify');
        onVerify(variables);
        return reply({
          siwsVerify: {
            token: TOKEN,
            expiresAt: '2099-01-01T00:00:00Z',
            publisher: { installId: 'install-from-server', solanaWallet: variables.wallet },
          },
        });
      }

      return fail(`unexpected operation: ${query.slice(0, 40)}`);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}/graphql`,
        seen,
        nonces,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-login-'));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    const suffix = `?t=${encodeURIComponent(dir)}`;
    return await fn({
      login: await import(`../hooks/lib/login.mjs${suffix}`),
      wallet: await import(`../hooks/lib/wallet.mjs${suffix}`),
      config: await import(`../hooks/lib/config.mjs${suffix}`),
      dir,
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('login creates a wallet, proves it, and stores the token', async () => {
  const stub = await startStub();
  try {
    await withTempHome(async ({ login, wallet: walletLib, config }) => {
      const result = await login.loginWithWallet({ endpoint: stub.endpoint });

      assert.equal(result.walletCreated, true);
      assert.equal(result.token, TOKEN);
      assert.equal(result.installId, 'install-from-server');
      assert.equal(result.wallet.address, walletLib.loadWallet().address);

      const stored = config.readStoredConfig();
      assert.equal(stored.token, TOKEN);
      assert.equal(stored.solanaWallet, result.wallet.address);
      assert.equal(stored.endpoint, stub.endpoint);
      // A retired API key must not survive a successful sign-in.
      assert.equal('apiKey' in stored, false);

      assert.equal(fs.statSync(config.configPath()).mode & 0o777, 0o600);
      assert.deepEqual(stub.seen.map((s) => s.op), ['challenge', 'verify']);
    });
  } finally {
    await stub.close();
  }
});

test('signing in twice reuses the same wallet', async () => {
  const stub = await startStub();
  try {
    await withTempHome(async ({ login }) => {
      const first = await login.loginWithWallet({ endpoint: stub.endpoint });
      const second = await login.loginWithWallet({ endpoint: stub.endpoint });
      assert.equal(second.walletCreated, false);
      assert.equal(second.wallet.address, first.wallet.address);
    });
  } finally {
    await stub.close();
  }
});

test('each login signs a fresh single-use nonce', async () => {
  const stub = await startStub();
  try {
    await withTempHome(async ({ login }) => {
      await login.loginWithWallet({ endpoint: stub.endpoint });
      await login.loginWithWallet({ endpoint: stub.endpoint });
      // Both challenges were consumed; nothing replayable is left behind.
      assert.equal(stub.nonces.size, 0);
      assert.equal(stub.seen.filter((s) => s.op === 'verify').length, 2);
    });
  } finally {
    await stub.close();
  }
});

test('a challenge minted for another wallet is refused unsigned', async () => {
  // Guards the check in loginWithWallet: the plugin must not sign a message
  // naming an address it does not control, whatever the server says.
  let verified = false;
  const stub = await startStub({ onVerify: () => { verified = true; } });
  try {
    await withTempHome(async ({ login, wallet: walletLib }) => {
      walletLib.ensureWallet();
      const original = global.fetch;
      global.fetch = async (url, init) => {
        const response = await original(url, init);
        const body = JSON.parse(await response.text());
        if (body.data?.siwsChallenge) {
          body.data.siwsChallenge.wallet = '11111111111111111111111111111111';
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      try {
        await assert.rejects(
          login.loginWithWallet({ endpoint: stub.endpoint }),
          /the challenge is for/,
        );
      } finally {
        global.fetch = original;
      }
      assert.equal(verified, false);
    });
  } finally {
    await stub.close();
  }
});

test('a rejected signature surfaces the backend error', async () => {
  const stub = await startStub();
  try {
    await withTempHome(async ({ login, config }) => {
      const original = global.fetch;
      global.fetch = async (url, init) => {
        const parsed = JSON.parse(init.body);
        if (parsed.query.includes('siwsVerify')) {
          parsed.variables.signature = '11111111111111111111111111111111';
        }
        return original(url, { ...init, body: JSON.stringify(parsed) });
      };
      try {
        await assert.rejects(
          login.loginWithWallet({ endpoint: stub.endpoint }),
          /signature does not verify/,
        );
      } finally {
        global.fetch = original;
      }
      // Nothing was written: a failed sign-in must not leave a half-linked config.
      assert.equal(config.readStoredConfig().token, undefined);
    });
  } finally {
    await stub.close();
  }
});
