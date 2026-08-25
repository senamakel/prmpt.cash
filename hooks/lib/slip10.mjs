// prmpt -- SLIP-0010 key derivation for ed25519 (the Solana half of the seed).
//
// BIP-32 is defined over secp256k1 and does not carry across to ed25519: there
// is no public-derivation analogue, because an ed25519 public key is not a
// simple scalar multiple of the private key the way a secp256k1 one is.
// SLIP-0010 is the spec that fills the gap, and its answer is that ed25519
// supports HARDENED DERIVATION ONLY.
//
// That is why the Solana path below ends in a hardened segment -- m/44'/501'/0'/0'
// and not the m/44'/60'/0'/0/0 shape used on the EVM side. Phantom, Solflare,
// Backpack and `solana-keygen recover` all use this path, so a phrase created
// here can be imported into any of them and shows the same address. That
// portability is the point: it is what makes the generated wallet a real
// wallet rather than a one-way trip into this plugin.

import crypto from 'node:crypto';

const HARDENED = 0x80000000;

/** The path every Solana wallet uses for the first account. Hardened throughout. */
export const SOLANA_PATH = "m/44'/501'/0'/0'";

/**
 * SLIP-0010 master node for a BIP-39 seed.
 *
 * `"ed25519 seed"` is the HMAC key the spec names for this curve -- the
 * secp256k1 tree uses `"Bitcoin seed"` instead, and swapping them derives a
 * different wallet from the same phrase.
 *
 * Unlike secp256k1 there is no validity check to make: every 32 byte string is
 * a valid ed25519 seed, so the retry loop the spec describes for other curves
 * cannot trigger here.
 */
function masterKey(seed) {
  const I = crypto.createHmac('sha512', Buffer.from('ed25519 seed', 'utf8'))
    .update(Buffer.from(seed))
    .digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

/** One hardened CKDpriv step: HMAC-SHA512(chainCode, 0x00 || key || ser32(index)). */
function deriveChild(parent, index) {
  if (index < HARDENED) {
    throw new Error(
      `prmpt: ed25519 supports hardened derivation only, so path segment ${index} must be ${index}'`,
    );
  }
  const data = Buffer.alloc(37);
  data[0] = 0x00;
  parent.key.copy(data, 1);
  data.writeUInt32BE(index >>> 0, 33);

  const I = crypto.createHmac('sha512', parent.chainCode).update(data).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

/** Parse a hardened-only path into indices. */
function parsePath(path) {
  const parts = String(path).trim().split('/');
  if (parts[0] !== 'm') throw new Error(`prmpt: a derivation path starts at m, got ${path}`);
  return parts.slice(1).filter(Boolean).map((part) => {
    const hardened = part.endsWith("'") || part.endsWith('h') || part.endsWith('H');
    const n = Number.parseInt(hardened ? part.slice(0, -1) : part, 10);
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED) {
      throw new Error(`prmpt: bad derivation path segment "${part}"`);
    }
    return hardened ? n + HARDENED : n;
  });
}

/**
 * Derive the 32 byte ed25519 seed at `path`.
 *
 * The result is a SEED, not an expanded key: Solana's "private key" is this
 * seed (optionally followed by the public key), and node:crypto builds a
 * signing key from it directly.
 */
export function deriveEd25519Seed(seed, path = SOLANA_PATH) {
  let node = masterKey(seed);
  for (const index of parsePath(path)) node = deriveChild(node, index);
  return Buffer.from(node.key);
}
