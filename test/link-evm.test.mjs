// Backfilling a Base address onto an install that predates two-chain payouts.
//
// Every publisher created before ERC-20 payouts moved to Base has proven only a
// Solana address, so anything owed in USDC — the default — parks unsendable.
// Self-enrolment cannot fix it: that fires only when there is NO token, and
// these installs have one. Hence this path, and hence these tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { needsEvmLink, linkEvmInBackground } from '../hooks/lib/link-evm.mjs';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-linkevm-'));
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

const LINKED = {
  token: 'a-token',
  solanaWallet: 'CJZsdW6RgwBxpN4M84RGm3MFzzBruCHL8SARz93Wm62M',
  endpoint: 'http://127.0.0.1:1',
};

test('needsEvmLink only fires for a linked install with no Base address', () => {
  assert.equal(needsEvmLink(LINKED), true);

  // Already linked: nothing to do, on every turn forever.
  assert.equal(needsEvmLink({ ...LINKED, evmWallet: '0xabc' }), false);
  // No token: that is enrolment's job, and doing both would race.
  assert.equal(needsEvmLink({ ...LINKED, token: '' }), false);
  // No recorded wallet: we cannot tell whose account this is, so we must not
  // attach an address to it.
  assert.equal(needsEvmLink({ ...LINKED, solanaWallet: undefined }), false);
  assert.equal(needsEvmLink(undefined), false);
});

test('it refuses when the key here is not the account it would link to', async () => {
  const home = tempHome();
  const { saveWallet, generateMnemonicWallet } = await import('../hooks/lib/wallet.mjs');

  // A dashboard-code install: a valid token for a wallet held somewhere else,
  // and a different key sitting on this machine. Linking would attach an
  // address we control to an account we do not — the exact thing proving a
  // wallet exists to prevent — so it must decline rather than "help".
  saveWallet(generateMnemonicWallet());
  assert.equal(linkEvmInBackground({ ...LINKED, solanaWallet: 'SomeoneElsesWalletAddress1111111111111111111' }), false);

  fs.rmSync(home, { recursive: true, force: true });
});

test('it does nothing when there is no wallet on this machine at all', async () => {
  const home = tempHome();
  // An install-code install with the key deliberately kept off the box.
  assert.equal(linkEvmInBackground(LINKED), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('it attempts once, then rate limits itself', async () => {
  const home = tempHome();
  const { saveWallet, walletFromMnemonic } = await import('../hooks/lib/wallet.mjs');

  // A phrase-backed install whose local key IS the account's identity.
  const wallet = walletFromMnemonic(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  saveWallet(wallet);
  const config = { ...LINKED, solanaWallet: wallet.address };

  // The first call spawns (the CLI it detaches will fail against a dead
  // endpoint, which is fine and silent); the second is refused by the marker.
  // Without that marker every turn of an offline machine would spawn a child
  // forever, because each turn is a fresh process with no memory of the last.
  const first = linkEvmInBackground(config);
  const second = linkEvmInBackground(config);
  assert.equal(first, true);
  assert.equal(second, false, 'a second attempt inside the window must be refused');
  assert.equal(fs.existsSync(path.join(home, 'prmpt', '.evm-link-attempt')), true);

  fs.rmSync(home, { recursive: true, force: true });
});

test('PRMPT_NO_AUTO_ENROL=1 opts out of this too', async () => {
  const home = tempHome();
  const { saveWallet, walletFromMnemonic } = await import('../hooks/lib/wallet.mjs');
  const wallet = walletFromMnemonic(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  saveWallet(wallet);

  process.env.PRMPT_NO_AUTO_ENROL = '1';
  try {
    // Somebody who opted out of a key being created for them has equally opted
    // out of one being registered for them.
    assert.equal(linkEvmInBackground({ ...LINKED, solanaWallet: wallet.address }), false);
  } finally {
    delete process.env.PRMPT_NO_AUTO_ENROL;
  }
  fs.rmSync(home, { recursive: true, force: true });
});
