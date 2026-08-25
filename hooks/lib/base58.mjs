// prmpt -- base58 (Bitcoin/Solana alphabet).
//
// A Solana address is the base58 encoding of a 32 byte ed25519 public key, and
// the SIWS signature goes back to the backend base58 too. The plugin ships with
// no dependencies, so both directions live here.
//
// Correctness note: leading zero bytes carry no value in the big-integer form,
// so they are encoded separately as leading '1's and counted back on decode.
// Drop that and a key whose first byte is 0x00 -- roughly one in 256 -- encodes
// to an address one character short, which base58-decodes to the wrong key.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const INDEX = new Map();
for (let i = 0; i < ALPHABET.length; i++) INDEX.set(ALPHABET[i], i);

/** Encode bytes as base58. */
export function encodeBase58(bytes) {
  const input = Uint8Array.from(bytes);
  if (input.length === 0) return '';

  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === 0) leadingZeros++;

  let value = 0n;
  for (const byte of input) value = value * 256n + BigInt(byte);

  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  return '1'.repeat(leadingZeros) + out;
}

/** Decode base58 to bytes. Throws on any character outside the alphabet. */
export function decodeBase58(text) {
  if (typeof text !== 'string' || text.length === 0) return new Uint8Array(0);

  let value = 0n;
  for (const ch of text) {
    const digit = INDEX.get(ch);
    if (digit === undefined) throw new Error(`prmpt: invalid base58 character ${JSON.stringify(ch)}`);
    value = value * 58n + BigInt(digit);
  }

  const body = [];
  while (value > 0n) {
    body.push(Number(value & 0xffn));
    value >>= 8n;
  }
  body.reverse();

  let leadingZeros = 0;
  while (leadingZeros < text.length && text[leadingZeros] === '1') leadingZeros++;

  const out = new Uint8Array(leadingZeros + body.length);
  out.set(body, leadingZeros);
  return out;
}

/** True when `text` is a syntactically valid Solana address (32 bytes of base58). */
export function isSolanaAddress(text) {
  try {
    return decodeBase58(String(text ?? '').trim()).length === 32;
  } catch {
    return false;
  }
}
