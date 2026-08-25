// prmpt -- wallet, base58 and keystore.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodeBase58, decodeBase58, isSolanaAddress } from '../hooks/lib/base58.mjs';

/** Point XDG_CONFIG_HOME at a scratch dir for the duration of `fn`. */
async function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-wallet-'));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    // Fresh module instances so configDir() is re-resolved against the new env.
    const wallet = await import(`../hooks/lib/wallet.mjs?t=${dir}`);
    return await fn(wallet, dir);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('base58 round-trips arbitrary bytes', () => {
  for (let i = 0; i < 200; i++) {
    const bytes = crypto.randomBytes(1 + (i % 40));
    assert.deepEqual(Buffer.from(decodeBase58(encodeBase58(bytes))), bytes);
  }
});

test('base58 preserves leading zero bytes', () => {
  // The failure this guards: a key whose first byte is 0x00 encodes one
  // character short unless leading zeros are carried as leading '1's, and then
  // decodes to a different, shorter key.
  const bytes = Buffer.concat([Buffer.alloc(3), crypto.randomBytes(29)]);
  const encoded = encodeBase58(bytes);
  assert.equal(encoded.slice(0, 3), '111');
  assert.deepEqual(Buffer.from(decodeBase58(encoded)), bytes);
});

test('base58 matches known Solana values', () => {
  // The all-zero 32 byte key is the Solana system program address.
  assert.equal(encodeBase58(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.equal(decodeBase58('11111111111111111111111111111111').length, 32);
});

test('base58 rejects characters outside the alphabet', () => {
  for (const bad of ['0', 'O', 'I', 'l', '+', '/', 'abc def']) {
    assert.throws(() => decodeBase58(bad.length === 1 ? `1${bad}` : bad), /invalid base58/);
  }
});

test('isSolanaAddress accepts 32-byte keys and nothing else', () => {
  assert.equal(isSolanaAddress('11111111111111111111111111111111'), true);
  assert.equal(isSolanaAddress('too-short'), false);
  assert.equal(isSolanaAddress(''), false);
  assert.equal(isSolanaAddress(null), false);
});

test('a generated wallet has a valid address and verifiable signatures', async () => {
  await withTempHome(async ({ generateWallet }) => {
    const wallet = generateWallet();
    assert.equal(isSolanaAddress(wallet.address), true);
    assert.equal(decodeBase58(wallet.address).length, 32);
    assert.deepEqual(Buffer.from(decodeBase58(wallet.address)), Buffer.from(wallet.publicKey));

    // Verify with an independently-built key object, so this checks the
    // signature rather than just that sign() agreed with itself.
    const message = 'prmpt.cash wants you to sign in with your Solana account:\n…';
    const signature = Buffer.from(decodeBase58(wallet.sign(message)));
    assert.equal(signature.length, 64);

    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(wallet.publicKey),
    ]);
    const publicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    assert.equal(crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, signature), true);
    // And that it is bound to the message.
    assert.equal(
      crypto.verify(null, Buffer.from(`${message}!`, 'utf8'), publicKey, signature),
      false,
    );
  });
});

test('the 64-byte export re-imports to the same wallet', async () => {
  await withTempHome(async ({ generateWallet, walletFromSecret }) => {
    const wallet = generateWallet();
    const restored = walletFromSecret(wallet.secretKey);
    assert.equal(restored.address, wallet.address);
    assert.deepEqual(Buffer.from(restored.seed), Buffer.from(wallet.seed));
  });
});

test('a bare 32-byte seed and a solana-keygen array import identically', async () => {
  await withTempHome(async ({ generateWallet, walletFromSecret }) => {
    const wallet = generateWallet();
    const fromSeed = walletFromSecret(encodeBase58(wallet.seed));
    const fromJson = walletFromSecret(
      JSON.stringify(Array.from(Buffer.concat([
        Buffer.from(wallet.seed),
        Buffer.from(wallet.publicKey),
      ]))),
    );
    assert.equal(fromSeed.address, wallet.address);
    assert.equal(fromJson.address, wallet.address);
  });
});

test('a secret key whose halves disagree is rejected', async () => {
  await withTempHome(async ({ generateWallet, walletFromSecret }) => {
    const a = generateWallet();
    const b = generateWallet();
    const frankenstein = Buffer.concat([Buffer.from(a.seed), Buffer.from(b.publicKey)]);
    assert.throws(
      () => walletFromSecret(encodeBase58(frankenstein)),
      /internally inconsistent/,
    );
  });
});

test('malformed secrets fail with a legible message', async () => {
  await withTempHome(async ({ walletFromSecret }) => {
    assert.throws(() => walletFromSecret(''), /no secret key/);
    assert.throws(() => walletFromSecret('abc'), /32 or 64 bytes/);
    assert.throws(() => walletFromSecret('[1,2,'), /does not parse/);
    assert.throws(() => walletFromSecret('[1,2,999]'), /array of byte values/);
    assert.throws(() => walletFromSecret('[1,2,3]'), /32 or 64 bytes/);
  });
});

test('the keystore is written 0600 inside a 0700 directory', async () => {
  await withTempHome(async ({ ensureWallet, walletPath }) => {
    const { wallet, created } = ensureWallet();
    assert.equal(created, true);

    const file = walletPath();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.address, wallet.address);
    assert.equal(stored.imported, false);
    assert.ok(stored.createdAt);
  });
});

test('ensureWallet is idempotent -- it never replaces an existing key', async () => {
  await withTempHome(async ({ ensureWallet }) => {
    const first = ensureWallet();
    const second = ensureWallet();
    assert.equal(second.created, false);
    assert.equal(second.wallet.address, first.wallet.address);
    assert.equal(second.wallet.sign('x'), first.wallet.sign('x'));
  });
});

test('the wallet file lives beside config.json, not inside it', async () => {
  await withTempHome(async ({ ensureWallet, walletPath }) => {
    ensureWallet();
    assert.equal(path.basename(walletPath()), 'wallet.json');
    // config.json is rewritten by every writeConfig caller; the key must not be
    // in the blast radius of that, nor in a file people paste into bug reports.
    assert.equal(fs.existsSync(path.join(path.dirname(walletPath()), 'config.json')), false);
  });
});

test('a corrupt keystore is reported, not silently replaced', async () => {
  await withTempHome(async ({ ensureWallet, loadWallet, walletPath }) => {
    ensureWallet();
    fs.writeFileSync(walletPath(), 'not json at all');
    assert.throws(() => loadWallet(), /not valid JSON/);
  });
});

test('a hand-edited address is flagged but the key still wins', async () => {
  await withTempHome(async ({ ensureWallet, loadWallet, walletPath }) => {
    const { wallet } = ensureWallet();
    const stored = JSON.parse(fs.readFileSync(walletPath(), 'utf8'));
    stored.address = '11111111111111111111111111111111';
    fs.writeFileSync(walletPath(), JSON.stringify(stored));

    const loaded = loadWallet();
    assert.equal(loaded.address, wallet.address);
    assert.equal(loaded.addressMismatch, '11111111111111111111111111111111');
  });
});

test('loadWallet returns null when there is no wallet', async () => {
  await withTempHome(async ({ loadWallet }) => {
    assert.equal(loadWallet(), null);
  });
});
