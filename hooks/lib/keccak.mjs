// prmpt -- keccak256.
//
// Ethereum hashes with original Keccak, not the SHA-3 that was standardised
// after it. The two differ in one byte of padding (0x01 vs 0x06) and produce
// completely different digests, so node:crypto's built-in 'sha3-256' is NOT a
// substitute -- using it would derive addresses that do not exist and produce
// signatures no node would accept. That single byte is the entire reason this
// file exists in a plugin that otherwise has no dependencies.
//
// BigInt lanes rather than split 32-bit halves: this runs a handful of times
// per install (an address, a login signature), never in the turn hot path, so
// the version that is easy to check against the spec is the right one.

const MASK64 = (1n << 64n) - 1n;

/** Round constants for Keccak-f[1600], iota step. */
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets for the rho step, indexed [x + 5*y]. */
const ROTC = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const rotl = (v, n) => n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64;

/** Keccak-f[1600] on 25 BigInt lanes, in place. */
function permute(s) {
  const C = new Array(5);
  const D = new Array(5);
  const B = new Array(25);

  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) s[i] ^= D[i % 5];

    // rho + pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROTC[x + 5 * y]);
      }
    }

    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        s[x + 5 * y] = B[x + 5 * y] ^ ((~B[((x + 1) % 5) + 5 * y] & MASK64) & B[((x + 2) % 5) + 5 * y]);
      }
    }

    // iota
    s[0] ^= RC[round];
  }
}

/**
 * keccak256 of a Buffer / Uint8Array / UTF-8 string, as a 32 byte Buffer.
 *
 * Rate is 136 bytes (1088 bits) and the pad is the original 0x01 .. 0x80 --
 * see the note at the top of this file.
 */
export function keccak256(input) {
  const data = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const RATE = 136;

  const padded = Buffer.alloc(Math.ceil((data.length + 1) / RATE) * RATE);
  data.copy(padded);
  padded[data.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const s = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      s[i] ^= padded.readBigUInt64LE(offset + i * 8);
    }
    permute(s);
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out;
}
