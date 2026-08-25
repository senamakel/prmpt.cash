// prmpt -- BIP-39 mnemonics.
//
// One seed phrase is the whole point of this module. An install needs a key on
// two chains that agree on nothing: Solana signs with ed25519 over base58
// addresses, Base signs with secp256k1 over keccak addresses. Handing a user
// two unrelated secrets to back up is how one of them gets lost, so both are
// derived from a single 12-word phrase they can write on paper.
//
// Zero dependencies: BIP-39 is SHA-256 for the checksum and PBKDF2-HMAC-SHA512
// for the seed, and node:crypto has both.
//
// The phrase IS the money. Everything here is deliberately strict -- a
// checksum that does not verify is refused rather than "mostly working",
// because a mnemonic with a typo derives a perfectly valid address that the
// user has never seen and can never reach.

import crypto from 'node:crypto';

import { WORDLIST, WORD_INDEX } from './wordlist-en.mjs';

/** Entropy sizes BIP-39 allows, in bytes, keyed by word count. */
const ENTROPY_BYTES = { 12: 16, 15: 20, 18: 24, 21: 28, 24: 32 };

/** 12 words is 128 bits. Past the reach of anything, and short enough to write down. */
export const DEFAULT_WORD_COUNT = 12;

/**
 * Generate a mnemonic from the OS CSPRNG.
 *
 * `crypto.randomBytes` and nothing else: a mnemonic seeded from anything
 * weaker is a wallet somebody else can also derive.
 */
export function generateMnemonic(words = DEFAULT_WORD_COUNT) {
  const bytes = ENTROPY_BYTES[words];
  if (!bytes) {
    throw new Error(`prmpt: a mnemonic is 12, 15, 18, 21 or 24 words, not ${words}`);
  }
  return entropyToMnemonic(crypto.randomBytes(bytes));
}

/**
 * Encode entropy as a mnemonic.
 *
 * The bits are entropy || first (bits/32) bits of SHA-256(entropy), chopped
 * into 11-bit words. Done over a bit string rather than with shifts because
 * the boundary arithmetic is where implementations of this quietly go wrong,
 * and correctness matters more here than a few microseconds once per install.
 */
export function entropyToMnemonic(entropy) {
  const buf = Buffer.from(entropy);
  if (!Object.values(ENTROPY_BYTES).includes(buf.length)) {
    throw new Error(`prmpt: BIP-39 entropy is 16, 20, 24, 28 or 32 bytes, got ${buf.length}`);
  }

  const checksum = crypto.createHash('sha256').update(buf).digest();
  const checksumBits = (buf.length * 8) / 32;

  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  bits += [...checksum].map((b) => b.toString(2).padStart(8, '0')).join('').slice(0, checksumBits);

  const out = [];
  for (let i = 0; i < bits.length; i += 11) {
    out.push(WORDLIST[Number.parseInt(bits.slice(i, i + 11), 2)]);
  }
  return out.join(' ');
}

/**
 * Decode a mnemonic back to its entropy, verifying the checksum.
 *
 * Throws on anything that is not a well-formed, checksum-valid English
 * mnemonic. The error says which word is wrong where it can, because the
 * alternative -- "invalid mnemonic" against 12 words the user hand-copied --
 * is a miserable thing to debug with money on the line.
 */
export function mnemonicToEntropy(mnemonic) {
  const words = normalizeMnemonic(mnemonic).split(' ').filter(Boolean);
  const bytes = ENTROPY_BYTES[words.length];
  if (!bytes) {
    throw new Error(
      `prmpt: a seed phrase is 12, 15, 18, 21 or 24 words; this one has ${words.length}`,
    );
  }

  let bits = '';
  for (const [i, word] of words.entries()) {
    const index = WORD_INDEX.get(word);
    if (index === undefined) {
      throw new Error(`prmpt: "${word}" (word ${i + 1}) is not in the BIP-39 English wordlist`);
    }
    bits += index.toString(2).padStart(11, '0');
  }

  const checksumBits = (bytes * 8) / 32;
  const entropyBits = bits.slice(0, bytes * 8);
  const entropy = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) {
    entropy[i] = Number.parseInt(entropyBits.slice(i * 8, i * 8 + 8), 2);
  }

  const expected = [...crypto.createHash('sha256').update(entropy).digest()]
    .map((b) => b.toString(2).padStart(8, '0'))
    .join('')
    .slice(0, checksumBits);
  if (bits.slice(bytes * 8) !== expected) {
    throw new Error(
      'prmpt: that seed phrase fails its checksum. The words are all real, so this is ' +
      'almost always one word mistyped or two words swapped -- check it against your backup.',
    );
  }
  return entropy;
}

/** True when `mnemonic` is a well-formed, checksum-valid English mnemonic. */
export function validateMnemonic(mnemonic) {
  try {
    mnemonicToEntropy(mnemonic);
    return true;
  } catch {
    return false;
  }
}

/**
 * The 64 byte BIP-39 seed: PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic".
 *
 * Note that this does NOT verify the checksum, exactly as the spec says: any
 * string is a valid input to the KDF. Callers that accept a phrase from a
 * human go through `mnemonicToEntropy` first; callers replaying their own
 * stored phrase do not need to.
 *
 * The passphrase (BIP-39 "25th word") is supported because wallets people
 * import from may use one, but prmpt never sets one itself -- a passphrase
 * that is not written down next to the phrase is a second thing to lose.
 */
export function mnemonicToSeed(mnemonic, passphrase = '') {
  return crypto.pbkdf2Sync(
    Buffer.from(normalizeMnemonic(mnemonic), 'utf8'),
    Buffer.from(`mnemonic${passphrase.normalize('NFKD')}`, 'utf8'),
    2048,
    64,
    'sha512',
  );
}

/**
 * Canonical form: NFKD, lower case, single-spaced.
 *
 * NFKD is required by the spec and is not cosmetic -- a phrase pasted out of a
 * document may carry composed characters that hash differently, which would
 * derive a different seed from what looks like the same words.
 */
export function normalizeMnemonic(mnemonic) {
  return String(mnemonic ?? '')
    .normalize('NFKD')
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .join(' ');
}
