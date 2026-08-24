// prmpt -- install code shape.
//
// Its own module so both entry points (hooks/link.mjs and bin/prmpt.mjs) can
// validate a pasted code without importing a file that runs a program on import.

// Crockford-ish base32: the code alphabet the backend mints from, which omits
// every character that gets misread off a screen -- no I, L, O, U, 0 or 1.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;

/**
 * Normalise a pasted code the same way the backend does before hashing it.
 *
 * Case, hyphens and stray spaces are all discarded, so a code typed by hand
 * still matches the one that was minted. This has to agree with
 * NormalizeInstallCode in backend/internal/auth/install_code.go or a perfectly
 * correct code fails to redeem.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw.trim().toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

/**
 * Client-side shape check.
 *
 * Catches a truncated paste before spending the code on a round trip. Whether
 * the code is real is the backend's call, and a wrong one is single-use there
 * too -- so it is worth not sending obvious garbage.
 */
export function validateCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return 'the code is empty, or contains none of the code alphabet';
  if (code.length !== CODE_LENGTH) {
    return `an install code is ${CODE_LENGTH} characters, got ${code.length}`;
  }
  return null;
}
