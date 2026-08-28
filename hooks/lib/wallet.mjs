// prmpt -- the local Solana wallet.
//
// The plugin owns a keypair. That is the whole point of this module: a terminal
// cannot open a browser wallet prompt, so until now linking an install meant
// going to the dashboard, proving a wallet there and pasting back a one-off
// code. A key the plugin generates itself can sign the SIWS challenge directly,
// which makes `prmpt login` a single non-interactive command and makes first
// run self-service.
//
// What that trades away is worth stating plainly, because it is a real
// trade-off and not an implementation detail: a generated key lives in
// cleartext at mode 0600 under the user's home directory. It is a hot wallet
// holding ad revenue, not a vault. Anyone who can read the file can sign as the
// user and, once the key ever holds funds, move them. Someone who wants
// payouts landing in a wallet they already control should `prmpt wallet import`
// instead -- and someone who wants the key to never touch this machine should
// keep using the dashboard install-code flow, which still works unchanged.
//
// Since the engine pays on two chains, the key material starts one level
// further back: a wallet created here is a BIP-39 seed phrase, and the Solana
// key below is derived from it at the standard m/44'/501'/0'/0'. The Base key
// comes off the same phrase in evm.mjs. One phrase is one thing to back up,
// and it imports cleanly into Phantom, Solflare or MetaMask, so the generated
// wallet is a real wallet rather than a hostage.
//
// Raw-key wallets are still first class: `prmpt wallet import` of a bare
// secret, and every install created before phrases existed, load and sign
// exactly as they did. A raw key cannot derive anything, so those installs get
// a separately generated Base key -- see evm.mjs.
//
// Zero dependencies: ed25519 is native in node:crypto (Node 18+), and base58
// lives next door.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { configDir } from './config.mjs';
import { encodeBase58, decodeBase58 } from './base58.mjs';
import { generateMnemonic, mnemonicToSeed, normalizeMnemonic, validateMnemonic } from './bip39.mjs';
import { deriveEd25519Seed, SOLANA_PATH } from './slip10.mjs';

/** PKCS#8 PrivateKeyInfo header for an ed25519 key, followed by the 32 byte seed. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** ~/.config/prmpt/wallet.json -- deliberately NOT config.json. */
export function walletPath() {
  return path.join(configDir(), 'wallet.json');
}

/**
 * Why the secret lives in its own file rather than in config.json:
 *
 * config.json is merged and rewritten by every `writeConfig` caller and is the
 * file a confused user is most likely to paste into a bug report. Keeping the
 * key out of it means `prmpt status` can dump the config verbatim, and means a
 * corrupted config never takes the key -- the only unrecoverable thing here --
 * down with it.
 */

// --- key material -----------------------------------------------------------

/** Raw 32 byte public key from a Node KeyObject. */
function rawPublicKey(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return Uint8Array.from(der.subarray(der.length - 32));
}

/** Raw 32 byte seed from a Node private KeyObject. */
function rawSeed(privateKey) {
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return Uint8Array.from(der.subarray(der.length - 32));
}

/** Rebuild a private KeyObject from a bare 32 byte seed. */
function privateKeyFromSeed(seed) {
  if (seed.length !== 32) {
    throw new Error(`prmpt: an ed25519 seed is 32 bytes, got ${seed.length}`);
  }
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * A wallet: the seed, the derived address, and a signer.
 *
 * `secretKey` is the 64 byte seed||publicKey form, base58 encoded -- what
 * Phantom, Solflare and `solana-keygen` all mean by "private key". Exporting
 * that exact shape is what makes the generated wallet portable rather than a
 * one-way trip into this plugin.
 */
function walletFromSeed(seed) {
  const privateKey = privateKeyFromSeed(seed);
  const publicKey = crypto.createPublicKey(privateKey);
  const pub = rawPublicKey(publicKey);

  const secretBytes = new Uint8Array(64);
  secretBytes.set(seed, 0);
  secretBytes.set(pub, 32);

  return {
    address: encodeBase58(pub),
    publicKey: pub,
    seed: Uint8Array.from(seed),
    secretKey: encodeBase58(secretBytes),
    /** Sign bytes or a UTF-8 string, returning a base58 ed25519 signature. */
    sign(message) {
      const data = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
      return encodeBase58(crypto.sign(null, data, privateKey));
    },
  };
}

/**
 * The Solana wallet held by a seed phrase.
 *
 * The returned wallet carries `mnemonic` so callers can persist the phrase
 * rather than the derived key -- the phrase is the thing worth keeping, and
 * storing the derived key alongside it would create two sources of truth that
 * can disagree.
 */
export function walletFromMnemonic(mnemonic, { path = SOLANA_PATH } = {}) {
  const phrase = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(phrase)) {
    // Re-derive the specific complaint rather than saying "invalid": the
    // caller has usually just typed twelve words by hand.
    throw new Error(
      'prmpt: that is not a valid BIP-39 seed phrase. ' +
      'Check the word count and spelling against your backup.',
    );
  }
  const wallet = walletFromSeed(deriveEd25519Seed(mnemonicToSeed(phrase), path));
  wallet.mnemonic = phrase;
  wallet.derivationPath = path;
  return wallet;
}

/** Generate a brand new seed-phrase wallet. This is what a fresh install gets. */
export function generateMnemonicWallet() {
  return walletFromMnemonic(generateMnemonic());
}

/**
 * Generate a bare keypair with no phrase behind it.
 *
 * Kept for callers that explicitly want a one-off key, and for the tests. New
 * installs go through `generateMnemonicWallet` instead: a key with no phrase
 * can only be backed up as an opaque base58 blob, and cannot derive the Base
 * side of the wallet.
 */
export function generateWallet() {
  return walletFromSeed(crypto.randomBytes(32));
}

/**
 * Import a wallet from whatever the user has in hand.
 *
 * Accepted, because these are the three things people actually paste:
 *   - base58, 64 bytes (Phantom / Solflare "export private key")
 *   - base58, 32 bytes (a bare seed)
 *   - a JSON array of 64 or 32 numbers (`solana-keygen` / id.json)
 *
 * A 64 byte input carries its own public key, so the derived one is checked
 * against it. Skipping that check would silently accept a key whose two halves
 * disagree and produce an address the user has never seen -- payouts would go
 * somewhere real and unrecoverable.
 */
export function walletFromSecret(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('prmpt: no secret key given');

  let bytes;
  if (text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('prmpt: that looks like a JSON key array but does not parse');
    }
    if (!Array.isArray(parsed) || parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error('prmpt: a JSON key file must be an array of byte values');
    }
    bytes = Uint8Array.from(parsed);
  } else {
    bytes = decodeBase58(text);
  }

  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error(`prmpt: a Solana secret key is 32 or 64 bytes, got ${bytes.length}`);
  }

  const wallet = walletFromSeed(bytes.subarray(0, 32));
  if (bytes.length === 64) {
    const claimed = bytes.subarray(32);
    const mismatch = wallet.publicKey.length !== claimed.length ||
      wallet.publicKey.some((b, i) => b !== claimed[i]);
    if (mismatch) {
      throw new Error(
        'prmpt: this secret key is internally inconsistent -- its public half does not ' +
        'match its seed. Re-export it from your wallet rather than reassembling it by hand.',
      );
    }
  }
  return wallet;
}

// --- the keystore -----------------------------------------------------------

/** Read the stored wallet, or null when there is none. Throws on a corrupt file. */
export function loadWallet() {
  let raw;
  try {
    raw = fs.readFileSync(walletPath(), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `prmpt: ${walletPath()} is not valid JSON. It holds the only copy of your key -- ` +
      'move it aside rather than deleting it, then create or import a wallet.',
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`prmpt: ${walletPath()} is not a wallet file`);
  }

  // A phrase, when there is one, is authoritative over any key stored beside
  // it: the derived key is a cache of the phrase and not the other way round.
  let wallet;
  if (typeof parsed.mnemonic === 'string' && parsed.mnemonic.trim()) {
    wallet = walletFromMnemonic(parsed.mnemonic, {
      path: typeof parsed.derivationPath === 'string' && parsed.derivationPath
        ? parsed.derivationPath
        : SOLANA_PATH,
    });
  } else if (typeof parsed.secretKey === 'string' && parsed.secretKey) {
    wallet = walletFromSecret(parsed.secretKey);
  } else {
    throw new Error(`prmpt: ${walletPath()} has neither a mnemonic nor a secretKey`);
  }
  // A stored address that disagrees with the key means the file was edited by
  // hand. Trust the key -- it is the thing that can actually sign -- but say so.
  if (typeof parsed.address === 'string' && parsed.address && parsed.address !== wallet.address) {
    wallet.addressMismatch = parsed.address;
  }
  wallet.createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : null;
  wallet.imported = parsed.imported === true;
  return wallet;
}

/**
 * Persist a wallet at mode 0600 in a 0700 directory.
 *
 * Written to a temp file in the same directory and renamed, so an interrupted
 * write cannot leave a truncated keystore where a working one used to be. The
 * temp file is created 0600 from the start -- writing it world-readable and
 * chmod'ing after leaves a window in which the key is readable.
 */
export function saveWallet(wallet, { imported = false } = {}) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const file = walletPath();
  const tmp = path.join(dir, `.wallet.json.${process.pid}.tmp`);
  // The phrase is written first and the key alongside it, because a user who
  // opens this file looking for something to back up should find the phrase.
  // The key stays even for a phrase wallet: it costs nothing, and it means an
  // install whose derivation this plugin later changes can still be recovered
  // by hand from the file it already had.
  const body = JSON.stringify(
    {
      address: wallet.address,
      mnemonic: wallet.mnemonic ?? undefined,
      derivationPath: wallet.mnemonic ? (wallet.derivationPath ?? SOLANA_PATH) : undefined,
      secretKey: wallet.secretKey,
      imported,
      createdAt: wallet.createdAt ?? new Date().toISOString(),
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
  // rename preserves the temp file's mode, but an existing target replaced on a
  // filesystem that behaves differently is worth being explicit about.
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * The wallet, creating and persisting one on first use.
 *
 * A wallet created here is always phrase-backed, so the Base key derives from
 * the same backup. An existing wallet is returned untouched whatever shape it
 * is in -- upgrading a raw key in place is impossible (there is no phrase that
 * derives it) and silently replacing one would abandon its earnings.
 */
export function ensureWallet() {
  const existing = loadWallet();
  if (existing) return { wallet: existing, created: false };
  const wallet = generateMnemonicWallet();
  saveWallet(wallet);
  return { wallet, created: true };
}
