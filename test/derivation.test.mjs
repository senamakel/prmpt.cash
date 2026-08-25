// Key derivation, pinned to published test vectors.
//
// Everything here derives money addresses, and every function in it was written
// from a spec rather than pulled from a library. A subtle bug in any of them
// produces a perfectly valid address that simply is not the user's -- payouts
// to it are real, irreversible, and land somewhere nobody holds a key for.
// Round-tripping our own code against itself would not catch that, so every
// assertion below is against a value published outside this repository.
//
// Sources:
//   BIP-39 seed          the Trezor reference vectors
//   m/44'/60'/0'/0/0     the canonical "abandon x11 about" address, which
//                        appears in the test suites of every major EVM library
//   EIP-55               the checksum examples in the EIP itself
//   SLIP-0010 ed25519    test vector 1 from the SLIP
//   keccak256            the original Keccak vectors (NOT SHA3-256, which
//                        differs by one padding byte and is what node:crypto
//                        would have given us)

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateMnemonic, mnemonicToSeed, validateMnemonic, entropyToMnemonic, mnemonicToEntropy } from '../hooks/lib/bip39.mjs';
import { deriveEd25519Seed } from '../hooks/lib/slip10.mjs';
import { derivePrivateKey, addressFromPrivateKey, toChecksumAddress, personalSign } from '../hooks/lib/secp256k1.mjs';
import { keccak256 } from '../hooks/lib/keccak.mjs';
import { walletFromMnemonic } from '../hooks/lib/wallet.mjs';
import { evmWalletFromMnemonic } from '../hooks/lib/evm.mjs';

/** The canonical all-zeros-entropy mnemonic. */
const REFERENCE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('keccak256 matches the original Keccak vectors, not SHA3-256', () => {
  assert.equal(
    keccak256('').toString('hex'),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
  assert.equal(
    keccak256('abc').toString('hex'),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
  // Longer than the 136 byte rate, so the sponge absorbs more than one block.
  assert.equal(keccak256('a'.repeat(200)).length, 32);
});

test('BIP-39 produces the reference seed', () => {
  assert.ok(validateMnemonic(REFERENCE));
  assert.equal(
    mnemonicToSeed(REFERENCE, 'TREZOR').toString('hex'),
    'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
  );
  // All-zero entropy IS the reference mnemonic, both ways.
  assert.equal(entropyToMnemonic(Buffer.alloc(16)), REFERENCE);
  assert.equal(mnemonicToEntropy(REFERENCE).toString('hex'), '00000000000000000000000000000000');
});

test('a mnemonic with a wrong word or a bad checksum is refused', () => {
  // Every word real, order wrong -- so only the checksum catches it. This is
  // the case that matters: a typo the user cannot see, which would otherwise
  // derive a valid address they have never had.
  assert.equal(
    validateMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about abandon'),
    false,
  );
  assert.equal(validateMnemonic(`${REFERENCE} extra`), false);
  assert.throws(() => mnemonicToEntropy('abandon abandon notaword abandon abandon abandon abandon abandon abandon abandon abandon about'), /notaword/);
});

test('generated mnemonics are 12 valid words and are not all the same', () => {
  const a = generateMnemonic();
  const b = generateMnemonic();
  assert.equal(a.split(' ').length, 12);
  assert.ok(validateMnemonic(a));
  assert.notEqual(a, b, 'a mnemonic drawn twice must not repeat');
});

test('SLIP-0010 ed25519 matches test vector 1', () => {
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  assert.equal(
    deriveEd25519Seed(seed, 'm').toString('hex'),
    '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
  );
  assert.equal(
    deriveEd25519Seed(seed, "m/0'").toString('hex'),
    '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
  );
});

test('ed25519 refuses unhardened derivation rather than inventing an answer', () => {
  // SLIP-0010 defines no public derivation for ed25519. Quietly hardening a
  // path segment the caller wrote unhardened would derive a different wallet
  // from the one they asked for.
  assert.throws(() => deriveEd25519Seed(Buffer.alloc(64), 'm/44/501'), /hardened/);
});

test("m/44'/60'/0'/0/0 derives the canonical reference address", () => {
  const key = derivePrivateKey(mnemonicToSeed(REFERENCE));
  assert.equal(key.toString('hex'), '1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727');
  assert.equal(addressFromPrivateKey(key), '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
});

test('EIP-55 checksums match the examples in the EIP', () => {
  assert.equal(
    toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'),
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  );
  assert.equal(
    toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'),
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  );
  assert.throws(() => toChecksumAddress('0xnothex'), /not a 20 byte hex address/);
});

test('personal_sign is deterministic, which is what makes it verifiable', () => {
  // RFC 6979 nonces: the same key over the same message must produce the same
  // 65 bytes every time. A random nonce here would still verify, but two
  // signatures sharing one would publish the private key -- and the backend's
  // TestPluginSignatureRecovers pins these exact bytes against go-ethereum.
  const key = derivePrivateKey(mnemonicToSeed(REFERENCE));
  const first = personalSign(key, 'prmpt login');
  assert.equal(first, personalSign(key, 'prmpt login'));
  assert.equal(
    first,
    '0xf53847d7b91f09e1836e0bb8eab0d283d7cbb26caf3beeacc750755e620cb9086e039d2f961233194892e9296753e235e48a8984dc7279acbdb201e35d9804b21b',
  );
  assert.notEqual(first, personalSign(key, 'prmpt login '));
});

test('one phrase gives both chains, and each is stable', () => {
  const solana = walletFromMnemonic(REFERENCE);
  const evm = evmWalletFromMnemonic(REFERENCE);

  assert.equal(evm.address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  assert.match(solana.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.equal(solana.mnemonic, REFERENCE);

  // Re-deriving must not drift.
  assert.equal(walletFromMnemonic(REFERENCE).address, solana.address);
  assert.equal(evmWalletFromMnemonic(REFERENCE).address, evm.address);

  // And the two chains must be genuinely different keys off the same phrase.
  assert.notEqual(solana.address, evm.address);
});
