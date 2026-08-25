// prmpt -- the Base wallet.
//
// Every ERC-20 payout settles on Base, so an install needs an EVM address
// alongside its Solana one. Where that address comes from depends on what the
// install already has, and the two cases are deliberately different:
//
//   phrase wallet   the Base key is DERIVED from the same seed phrase at
//                   m/44'/60'/0'/0/0 and stored nowhere at all. There is
//                   nothing extra to back up and nothing extra to lose.
//
//   raw-key wallet  installs that predate seed phrases, and anything adopted
//                   with `prmpt wallet import`, hold a bare ed25519 key. No
//                   phrase exists behind it, so no EVM key can be derived from
//                   it; one is generated once and persisted in evm.json.
//
// The second case is why this file has a keystore at all. Deriving a secp256k1
// key from an ed25519 secret would "work" -- it would produce a deterministic
// address needing no new file -- and it is exactly the kind of invention that
// makes a wallet unrecoverable by any other tool. A generated key that lives in
// a file the user can export is worse-looking and better.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { configDir } from './config.mjs';
import { mnemonicToSeed } from './bip39.mjs';
import {
  derivePrivateKey,
  addressFromPrivateKey,
  isValidPrivateKey,
  personalSign,
  ETH_PATH,
} from './secp256k1.mjs';

/** ~/.config/prmpt/evm.json -- only ever written for a raw-key install. */
export function evmWalletPath() {
  return path.join(configDir(), 'evm.json');
}

/** Wrap a 32 byte secp256k1 key as an addressable, signing wallet. */
function evmWalletFromPrivateKey(privateKey, extra = {}) {
  const key = Buffer.from(privateKey);
  if (key.length !== 32) {
    throw new Error(`prmpt: a secp256k1 private key is 32 bytes, got ${key.length}`);
  }
  if (!isValidPrivateKey(BigInt('0x' + key.toString('hex')))) {
    throw new Error('prmpt: that is not a valid secp256k1 private key');
  }
  return {
    address: addressFromPrivateKey(key),
    privateKey: key,
    secretKey: `0x${key.toString('hex')}`,
    /** Sign a message the way a browser wallet's personal_sign would. */
    sign(message) {
      return personalSign(key, message);
    },
    ...extra,
  };
}

/** The Base wallet a seed phrase holds. Deterministic; nothing is stored. */
export function evmWalletFromMnemonic(mnemonic, { path: derivation = ETH_PATH } = {}) {
  const wallet = evmWalletFromPrivateKey(derivePrivateKey(mnemonicToSeed(mnemonic), derivation), {
    derived: true,
    derivationPath: derivation,
  });
  return wallet;
}

/**
 * Adopt an existing EVM key.
 *
 * Accepts the one shape people actually paste: 32 bytes of hex, with or
 * without the 0x. A mnemonic goes through `evmWalletFromMnemonic` instead.
 */
export function evmWalletFromSecret(raw) {
  const text = String(raw ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(text)) {
    throw new Error('prmpt: an EVM private key is 64 hex characters (32 bytes), optionally 0x-prefixed');
  }
  return evmWalletFromPrivateKey(Buffer.from(text, 'hex'), { derived: false });
}

/** Read evm.json, or null when there is none. Throws on a corrupt file. */
export function loadStoredEvmWallet() {
  let raw;
  try {
    raw = fs.readFileSync(evmWalletPath(), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `prmpt: ${evmWalletPath()} is not valid JSON. It holds the only copy of your Base ` +
      'key -- move it aside rather than deleting it.',
    );
  }
  if (!parsed || typeof parsed.secretKey !== 'string' || !parsed.secretKey) {
    throw new Error(`prmpt: ${evmWalletPath()} has no secretKey`);
  }

  const wallet = evmWalletFromSecret(parsed.secretKey);
  if (typeof parsed.address === 'string' && parsed.address &&
      parsed.address.toLowerCase() !== wallet.address.toLowerCase()) {
    wallet.addressMismatch = parsed.address;
  }
  wallet.createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : null;
  return wallet;
}

/**
 * Persist an EVM key at 0600, via a same-directory temp file and a rename, so
 * an interrupted write cannot replace a working keystore with a truncated one.
 */
export function saveEvmWallet(wallet) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const file = evmWalletPath();
  const tmp = path.join(dir, `.evm.json.${process.pid}.tmp`);
  const body = JSON.stringify(
    {
      address: wallet.address,
      secretKey: wallet.secretKey,
      createdAt: wallet.createdAt ?? new Date().toISOString(),
      note: 'Generated because this install has no seed phrase to derive from. Back it up.',
    },
    null,
    2,
  );

  fs.writeFileSync(tmp, `${body}\n`, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * The Base wallet for a given Solana wallet, creating one only if it must.
 *
 * Pass the wallet `loadWallet()` returned. A phrase-backed one derives and
 * writes nothing; a raw-key one reuses evm.json or generates it on first call.
 * Returns `{ wallet, created, stored }` -- `stored` says whether the key lives
 * in a file the user has to back up separately.
 */
export function ensureEvmWallet(solanaWallet) {
  const found = peekEvmWallet(solanaWallet);
  if (found) return found;

  // 32 random bytes are a valid key with overwhelming probability; the loop
  // covers the vanishing case of a draw at or above the group order, which
  // would otherwise throw on an install that did nothing wrong.
  let wallet;
  for (;;) {
    try {
      wallet = evmWalletFromPrivateKey(crypto.randomBytes(32), { derived: false });
      break;
    } catch { /* redraw */ }
  }
  saveEvmWallet(wallet);
  return { wallet, created: true, stored: true };
}

/**
 * The Base wallet, WITHOUT creating one. Null when this install has none yet.
 *
 * Display commands use this rather than `ensureEvmWallet`, so that looking at
 * your wallet does not silently mint a key file. That distinction only matters
 * for raw-key installs -- a phrase-backed one derives its Base key and writes
 * nothing either way -- but "reading is read-only" is worth keeping true, and a
 * key that appears because somebody ran a print command is a key nobody knows
 * they need to back up.
 */
export function peekEvmWallet(solanaWallet) {
  if (solanaWallet?.mnemonic) {
    return { wallet: evmWalletFromMnemonic(solanaWallet.mnemonic), created: false, stored: false };
  }
  const existing = loadStoredEvmWallet();
  if (existing) return { wallet: existing, created: false, stored: true };
  return null;
}
