// prmpt -- wallet sign-in.
//
// One function, shared by the `prmpt login` command and the hook's background
// self-enrolment, so the two can never drift into signing slightly different
// things.

import { ensureWallet } from './wallet.mjs';
import { siwsChallenge, siwsVerify } from './api.mjs';
import { writeConfig, resolveInstallId } from './config.mjs';

/**
 * Prove the local wallet to the backend and persist the resulting JWT.
 *
 * First sign-in IS signup: the backend creates the publisher behind an unseen
 * wallet, exactly as it does for a browser. So this one call takes a machine
 * from "no account at all" to "earning", with no dashboard visit.
 *
 * The signature covers `challenge.message` verbatim -- see the note on
 * SIWS_CHALLENGE in api.mjs for why that matters.
 */
export async function loginWithWallet({ endpoint, timeoutMs = 15000 } = {}) {
  const { wallet, created } = ensureWallet();

  const challenge = await siwsChallenge({ endpoint, wallet: wallet.address, timeoutMs });
  // The backend canonicalises the address it echoes back. Sign for the wallet
  // it says it minted the nonce for, and refuse outright if that is not us --
  // a challenge for another address is not ours to sign.
  if (challenge.wallet !== wallet.address) {
    throw new Error(
      `prmpt: the challenge is for ${challenge.wallet}, not ${wallet.address}`,
    );
  }

  const result = await siwsVerify({
    endpoint,
    wallet: wallet.address,
    nonce: challenge.nonce,
    signature: wallet.sign(challenge.message),
    timeoutMs,
  });

  const installId = result.installId || resolveInstallId();
  const file = writeConfig({
    installId,
    token: result.token,
    endpoint,
    solanaWallet: result.solanaWallet ?? wallet.address,
    // Any retired API key from an install predating JWT auth goes now, rather
    // than sitting on disk as a dead credential forever.
    apiKey: undefined,
  });

  return {
    wallet,
    walletCreated: created,
    token: result.token,
    expiresAt: result.expiresAt,
    installId,
    endpoint,
    configFile: file,
  };
}
