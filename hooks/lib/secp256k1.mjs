// prmpt -- secp256k1, BIP-32 and EIP-191, for the Base side of the wallet.
//
// Solana is ed25519 and node:crypto signs that natively. Base is secp256k1
// over keccak-hashed messages, and node:crypto will not do it: `crypto.sign`
// hashes with SHA-2 internally and offers no way to hand it a keccak digest,
// so the ECDSA arithmetic has to happen here.
//
// What is NOT hand-rolled is the elliptic curve itself. Every point
// multiplication goes through `crypto.createECDH('secp256k1')` -- OpenSSL's
// constant-time implementation -- by setting a scalar as a private key and
// reading back the public key, which is exactly k*G. The only arithmetic below
// is modular add, multiply and invert on BigInts, which is checkable by eye.
// A hand-written double-and-add ladder in a file that touches live keys is the
// kind of thing that leaks a secret through timing and looks fine in tests.
//
// RFC 6979 deterministic nonces, for the usual reason: an ECDSA nonce that
// repeats across two signatures publishes the private key, and a nonce drawn
// from a weak source has done exactly that in the wild more than once.

import crypto from 'node:crypto';

import { keccak256 } from './keccak.mjs';

/** Order of the secp256k1 group. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** BIP-44 path for Ethereum and every EVM chain, Base included: m/44'/60'/0'/0/0. */
export const ETH_PATH = "m/44'/60'/0'/0/0";

const HARDENED = 0x80000000;

// --- small modular helpers --------------------------------------------------

const mod = (a, m) => ((a % m) + m) % m;

/** Modular inverse by the extended Euclidean algorithm. */
function invMod(a, m) {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error('prmpt: value is not invertible');
  return mod(old_s, m);
}

const toBigInt = (buf) => BigInt('0x' + Buffer.from(buf).toString('hex'));

/** A scalar as exactly 32 bytes. Short-hex truncation here is a wrong key. */
function to32(value) {
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
}

// --- curve, via OpenSSL -----------------------------------------------------

/**
 * k*G, as a 65 byte uncompressed point (0x04 || X || Y).
 *
 * `setPrivateKey` rejects a scalar that is zero or >= the group order, which
 * is the validity check BIP-32 requires anyway.
 */
function pointFromScalar(scalar, compressed = false) {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(to32(scalar));
  return ecdh.getPublicKey(null, compressed ? 'compressed' : 'uncompressed');
}

/** True when a scalar is a usable secp256k1 private key. */
export function isValidPrivateKey(scalar) {
  return scalar > 0n && scalar < N;
}

// --- BIP-32 -----------------------------------------------------------------

/**
 * The BIP-32 master key for a seed.
 *
 * `"Bitcoin seed"` is the literal HMAC key the spec names, on every chain that
 * uses BIP-32 -- it is not a placeholder to be swapped for something
 * Base-flavoured, and changing it derives a different, incompatible wallet.
 */
function masterKey(seed) {
  const I = crypto.createHmac('sha512', Buffer.from('Bitcoin seed', 'utf8')).update(Buffer.from(seed)).digest();
  const key = toBigInt(I.subarray(0, 32));
  if (!isValidPrivateKey(key)) {
    // Probability ~2^-127. Handled anyway: the alternative is deriving from a
    // key of zero.
    throw new Error('prmpt: this seed produces an invalid BIP-32 master key; generate a new phrase');
  }
  return { key, chainCode: I.subarray(32) };
}

/** One CKDpriv step. Hardened indices use the private key, normal ones the point. */
function deriveChild(parent, index) {
  const data = Buffer.alloc(37);
  if (index >= HARDENED) {
    data[0] = 0x00;
    to32(parent.key).copy(data, 1);
  } else {
    pointFromScalar(parent.key, true).copy(data, 0);
  }
  data.writeUInt32BE(index >>> 0, 33);

  const I = crypto.createHmac('sha512', parent.chainCode).update(data).digest();
  const tweak = toBigInt(I.subarray(0, 32));
  if (tweak >= N) {
    throw new Error('prmpt: BIP-32 derivation produced an out-of-range key; use the next index');
  }
  const key = mod(tweak + parent.key, N);
  if (key === 0n) {
    throw new Error('prmpt: BIP-32 derivation produced a zero key; use the next index');
  }
  return { key, chainCode: I.subarray(32) };
}

/** Parse `m/44'/60'/0'/0/0` into an index list. Accepts both `'` and `h`. */
export function parsePath(path) {
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

/** Derive a private key from a BIP-39 seed along a BIP-32 path. */
export function derivePrivateKey(seed, path = ETH_PATH) {
  let node = masterKey(seed);
  for (const index of parsePath(path)) node = deriveChild(node, index);
  return to32(node.key);
}

// --- addresses --------------------------------------------------------------

/**
 * The EIP-55 mixed-case checksum form of a 0x address.
 *
 * Not cosmetic: it is the only thing standing between a mistyped address and a
 * transfer into nowhere, and every wallet and explorer displays it, so an
 * all-lower-case address looks wrong to anyone comparing.
 */
export function toChecksumAddress(address) {
  const raw = String(address).trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(raw)) {
    throw new Error(`prmpt: "${address}" is not a 20 byte hex address`);
  }
  const hash = keccak256(raw).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out += Number.parseInt(hash[i], 16) >= 8 ? raw[i].toUpperCase() : raw[i];
  }
  return out;
}

/** The address for a private key: last 20 bytes of keccak256 of the bare public point. */
export function addressFromPrivateKey(privateKey) {
  const point = pointFromScalar(toBigInt(privateKey));
  return toChecksumAddress(keccak256(point.subarray(1)).subarray(-20).toString('hex'));
}

/** The compressed public key, for anything that wants to verify without the address. */
export function publicKeyFromPrivateKey(privateKey) {
  return pointFromScalar(toBigInt(privateKey), true);
}

// --- signing ----------------------------------------------------------------

/** RFC 6979 deterministic nonce, HMAC-SHA256, as used by every Ethereum signer. */
function deterministicNonce(privateKey, digest) {
  const h1 = Buffer.from(digest);
  const x = Buffer.from(privateKey);
  let V = Buffer.alloc(32, 0x01);
  let K = Buffer.alloc(32, 0x00);

  // bits2octets: the digest reduced mod n, re-serialised to 32 bytes.
  const h1Reduced = to32(mod(toBigInt(h1), N));

  const hmac = (key, ...parts) => {
    const h = crypto.createHmac('sha256', key);
    for (const p of parts) h.update(p);
    return h.digest();
  };

  K = hmac(K, V, Buffer.from([0x00]), x, h1Reduced);
  V = hmac(K, V);
  K = hmac(K, V, Buffer.from([0x01]), x, h1Reduced);
  V = hmac(K, V);

  for (;;) {
    V = hmac(K, V);
    const k = toBigInt(V);
    if (isValidPrivateKey(k)) return k;
    K = hmac(K, V, Buffer.from([0x00]));
    V = hmac(K, V);
  }
}

/**
 * Sign a 32 byte digest, returning { r, s, v } with an Ethereum recovery id.
 *
 * Two details that are easy to get wrong and expensive to notice:
 *
 *  - `s` is normalised to the lower half of the order. Both halves verify, but
 *    high-s signatures are non-canonical and rejected by Ethereum's own
 *    homestead rules; flipping s also flips the recovery parity, which is why
 *    the two happen together below.
 *  - the recovery id is computed from the nonce point, not guessed. Getting it
 *    wrong yields a signature that recovers to a real but different address,
 *    so verification fails with no hint as to why.
 */
export function signDigest(privateKey, digest) {
  const d = toBigInt(privateKey);
  const z = toBigInt(digest);
  const k = deterministicNonce(privateKey, digest);

  const point = pointFromScalar(k);
  const x = toBigInt(point.subarray(1, 33));
  const yIsOdd = (point[64] & 1) === 1;

  const r = mod(x, N);
  if (r === 0n) throw new Error('prmpt: degenerate ECDSA nonce');

  let s = mod(invMod(k, N) * mod(z + r * d, N), N);
  if (s === 0n) throw new Error('prmpt: degenerate ECDSA signature');

  let recovery = (yIsOdd ? 1 : 0) | (x >= N ? 2 : 0);
  if (s > N / 2n) {
    s = N - s;
    recovery ^= 1;
  }

  return { r: to32(r), s: to32(s), recovery, v: 27 + recovery };
}

/**
 * The EIP-191 `personal_sign` digest: keccak256 of the length-prefixed message.
 *
 * The prefix is what stops a signed login challenge from also being a valid
 * transaction -- a raw keccak of arbitrary bytes could be either.
 */
export function personalSignDigest(message) {
  const body = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  return keccak256(
    Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8'), body]),
  );
}

/** Sign a message the way a browser wallet's `personal_sign` would: 0x r||s||v. */
export function personalSign(privateKey, message) {
  const { r, s, v } = signDigest(privateKey, personalSignDigest(message));
  return `0x${r.toString('hex')}${s.toString('hex')}${v.toString(16).padStart(2, '0')}`;
}
