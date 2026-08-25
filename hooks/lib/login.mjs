// prmpt -- wallet sign-in.
//
// One function, shared by the `prmpt login` command and the hook's background
// self-enrolment, so the two can never drift into signing slightly different
// things.

import { ensureWallet } from './wallet.mjs';
import { ensureEvmWallet } from './evm.mjs';
import { siwsChallenge, siwsVerify, evmChallenge, linkEvmWallet } from './api.mjs';
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
 *
 * It then proves the BASE address as well, in the same command. Two chains
 * settle payouts now -- ERC-20s on Base, SOL and the Solana-only assets on
 * Solana -- so an install that proved only one of its two addresses can be paid
 * in roughly half the available currencies, including the default. Making that
 * a separate command the user has to know about would leave most installs
 * half-linked, so it happens here.
 *
 * The Base link is BEST EFFORT and never fails the login. Signing in is the
 * thing the user asked for and it has already succeeded by the time this runs;
 * a backend that has no Base support, or a transient failure on the second
 * round trip, must not throw away a token that was minted correctly. What it
 * costs is that the caller has to look at `evmWallet` to see whether the second
 * half landed -- which is why the result reports it.
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

  const { wallet: evm, created: evmCreated, stored: evmStored } = ensureEvmWallet(wallet);
  const link = await linkEvmAddress({ endpoint, token: result.token, evm, timeoutMs });

  const file = writeConfig({
    installId,
    token: result.token,
    endpoint,
    solanaWallet: result.solanaWallet ?? wallet.address,
    evmWallet: link.linked ? evm.address : undefined,
    payoutToken: link.payoutToken ?? result.payoutToken ?? undefined,
    payoutChain: link.payoutChain ?? result.payoutChain ?? undefined,
    // Any retired API key from an install predating JWT auth goes now, rather
    // than sitting on disk as a dead credential forever.
    apiKey: undefined,
  });

  return {
    wallet,
    walletCreated: created,
    evm,
    evmCreated,
    evmStored,
    evmLinked: link.linked,
    evmError: link.error,
    payoutToken: link.payoutToken ?? result.payoutToken ?? null,
    payoutChain: link.payoutChain ?? result.payoutChain ?? null,
    token: result.token,
    expiresAt: result.expiresAt,
    installId,
    endpoint,
    configFile: file,
  };
}

/**
 * Prove the Base address to a backend that already knows this publisher.
 *
 * Resolves rather than rejects on every failure, so the caller can report a
 * half-linked install without losing the login -- see loginWithWallet.
 */
async function linkEvmAddress({ endpoint, token, evm, timeoutMs }) {
  try {
    const challenge = await evmChallenge({ endpoint, address: evm.address, timeoutMs });
    // Sign for the address the server minted the nonce for, and refuse if that
    // is not us: a challenge for someone else's address is not ours to sign.
    if (challenge.address.toLowerCase() !== evm.address.toLowerCase()) {
      throw new Error(`the challenge is for ${challenge.address}, not ${evm.address}`);
    }
    const publisher = await linkEvmWallet({
      endpoint,
      token,
      address: evm.address,
      nonce: challenge.nonce,
      signature: evm.sign(challenge.message),
      timeoutMs,
    });
    return {
      linked: true,
      error: null,
      payoutToken: publisher.payoutToken,
      payoutChain: publisher.payoutChain,
    };
  } catch (err) {
    return { linked: false, error: err?.message ?? String(err), payoutToken: null, payoutChain: null };
  }
}
