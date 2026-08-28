// prmpt -- the backend GraphQL client.
//
// Used by the end-of-turn hook and the interactive wallet/dashboard commands.
// serveAd never throws: it resolves to null on any failure at all, because a
// failed ad request must be indistinguishable from "no ad matched".

import { currentVersion } from './version.mjs';

const SERVE_AD = `mutation ServeAd($input: TurnContextInput!) {
  serveAd(input: $input) {
    requestId
    headline
    body
    clickUrl
  }
}`;

// The status-line surface bills on RENDER, not on the serve.
//
// A decision fetched at the start of a turn may never be shown -- the turn can
// end before the status line repaints, or the user can have the slot expire
// under them -- so the serve alone is not an impression. The renderer records
// what it actually drew and this mutation reports the batch, always from a
// detached child and never from the render path.
const CONFIRM_IMPRESSIONS = `mutation ConfirmImpressions($requestIds: [ID!]!) {
  confirmImpressions(requestIds: $requestIds)
}`;

// Sign-In With Solana, the two halves of one round trip.
//
// The signature must cover the server's `message` BYTE FOR BYTE. Rebuilding
// the text client-side from its visible parts is the classic way to fail this:
// the domain, the chain id and the issued-at timestamp all come from server
// configuration, and a single character of drift verifies against nothing.
const SIWS_CHALLENGE = `mutation SiwsChallenge($wallet: String!) {
  siwsChallenge(wallet: $wallet) {
    wallet
    nonce
    message
    expiresAt
  }
}`;

// Sign-In With Ethereum, for the Base half of the wallet.
//
// This is a LINK, not a login: the user is already authenticated by the
// SIWS pair above, and this attaches the second address they hold. Which is why
// linkEvmWallet needs the token and evmChallenge does not.
const EVM_CHALLENGE = `mutation EvmChallenge($address: String!) {
  evmChallenge(address: $address) {
    address
    nonce
    message
    expiresAt
  }
}`;

const LINK_EVM_WALLET = `mutation LinkEvmWallet($address: String!, $nonce: String!, $signature: String!) {
  linkEvmWallet(address: $address, nonce: $nonce, signature: $signature) {
    installId
    solanaWallet
    evmWallet
    payoutToken
    payoutChain
  }
}`;

// The dashboard route out of the terminal: mint a one-off code and open it.
//
// The plugin proves its locally held wallet and hands a short-lived code to the
// browser, so the dashboard can open without moving the key.
const CREATE_WEB_SESSION = `mutation CreateWebSession {
  createWebSession {
    code
    url
    expiresAt
  }
}`;

const SIWS_VERIFY = `mutation SiwsVerify($wallet: String!, $nonce: String!, $signature: String!) {
  siwsVerify(wallet: $wallet, nonce: $nonce, signature: $signature) {
    token
    expiresAt
    user {
      installId
      solanaWallet
      evmWallet
      payoutToken
      payoutChain
    }
  }
}`;

/**
 * One GraphQL POST with a hard deadline.
 *
 * The AbortController is the only timeout that matters: fetch's own socket
 * timeouts are far too generous for something sitting in the user's turn
 * latency. The timer is unref'd so a resolved request never keeps the process
 * alive waiting for it.
 */
async function graphql({ endpoint, token, query, variables, timeoutMs = 1500 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': `prmpt-plugin/${currentVersion()}`,
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Drain so the socket can be reused/closed rather than left dangling.
      await res.text().catch(() => {});
      const err = new Error(`prmpt: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    if (json && Array.isArray(json.errors) && json.errors.length > 0) {
      const err = new Error(json.errors[0]?.message || 'prmpt: GraphQL error');
      err.graphQLErrors = json.errors;
      throw err;
    }
    return json?.data ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** Derive http://host/c/{requestId} from the GraphQL endpoint. */
function fallbackClickUrl(endpoint, requestId) {
  try {
    return new URL(`/c/${encodeURIComponent(requestId)}`, endpoint).toString();
  } catch {
    return null;
  }
}

/**
 * Ask the backend for an ad for this turn.
 *
 * Resolves to a normalised decision or to null. Never rejects, never logs, and
 * never lets an error escape into the user's session -- that is the entire
 * contract this function exists to uphold.
 */
export async function serveAd(config, input) {
  try {
    const data = await graphql({
      endpoint: config.endpoint,
      token: config.token,
      query: SERVE_AD,
      variables: { input },
      timeoutMs: config.timeoutMs,
    });

    const ad = data?.serveAd;
    if (!ad || typeof ad !== 'object') return null;

    const headline = typeof ad.headline === 'string' ? ad.headline.trim() : '';
    const requestId = typeof ad.requestId === 'string' ? ad.requestId.trim() : '';
    if (!headline || !requestId) return null;

    const clickUrl =
      (typeof ad.clickUrl === 'string' && ad.clickUrl.trim()) ||
      fallbackClickUrl(config.endpoint, requestId);
    if (!clickUrl) return null;

    return {
      requestId,
      headline,
      body: typeof ad.body === 'string' ? ad.body.trim() : '',
      clickUrl,
    };
  } catch {
    // Timeout, connection refused, bad JSON, GraphQL error, anything: no ad.
    return null;
  }
}

/**
 * Report the impressions that have actually been rendered.
 *
 * Resolves to the number the backend accepted, or null on any failure at all --
 * the caller keeps the ids and retries on a later turn, so a flush that fails
 * costs nothing but a delay. Never rejects: this runs in a detached child with
 * nowhere to report to.
 */
export async function confirmImpressions(config, requestIds) {
  if (!Array.isArray(requestIds) || requestIds.length === 0) return 0;
  try {
    const data = await graphql({
      endpoint: config.endpoint,
      token: config.token,
      query: CONFIRM_IMPRESSIONS,
      variables: { requestIds },
      timeoutMs: config.timeoutMs,
    });
    const n = data?.confirmImpressions;
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

/**
 * Ask for a one-time SIWE challenge over an EVM address.
 *
 * Anonymous, like its Solana counterpart: minting a challenge proves nothing.
 */
export async function evmChallenge({ endpoint, address, timeoutMs = 15000 }) {
  const data = await graphql({
    endpoint,
    query: EVM_CHALLENGE,
    variables: { address },
    timeoutMs,
  });

  const node = data?.evmChallenge;
  if (!node || typeof node.message !== 'string' || typeof node.nonce !== 'string') {
    throw new Error('prmpt: evmChallenge returned no challenge');
  }
  return {
    address: typeof node.address === 'string' ? node.address : address,
    nonce: node.nonce,
    message: node.message,
    expiresAt: typeof node.expiresAt === 'string' ? node.expiresAt : null,
  };
}

/**
 * Attach the proven Base address to this install's user account.
 *
 * Needs the user token: the backend takes the account from the token and
 * never from the address, so this can only ever link to us.
 */
export async function linkEvmWallet({ endpoint, token, address, nonce, signature, timeoutMs = 15000 }) {
  const data = await graphql({
    endpoint,
    token,
    query: LINK_EVM_WALLET,
    variables: { address, nonce, signature },
    timeoutMs,
  });

  const node = data?.linkEvmWallet;
  if (!node || typeof node !== 'object') {
    throw new Error('prmpt: linkEvmWallet returned no user');
  }
  return {
    installId: node.installId ?? null,
    solanaWallet: node.solanaWallet ?? null,
    evmWallet: node.evmWallet ?? null,
    payoutToken: node.payoutToken ?? null,
    payoutChain: node.payoutChain ?? null,
  };
}

/** Mint a one-off code that opens the dashboard as this install's user. */
export async function createWebSession({ endpoint, token, timeoutMs = 15000 }) {
  const data = await graphql({ endpoint, token, query: CREATE_WEB_SESSION, timeoutMs });

  const node = data?.createWebSession;
  if (!node || typeof node.url !== 'string' || !node.url) {
    throw new Error('prmpt: createWebSession returned no url');
  }
  return {
    code: typeof node.code === 'string' ? node.code : null,
    url: node.url,
    expiresAt: typeof node.expiresAt === 'string' ? node.expiresAt : null,
  };
}

/**
 * Ask for a one-time SIWS challenge to sign.
 *
 * Throws because every caller is a person running a command and waiting for
 * it, so a failure has to be legible.
 */
export async function siwsChallenge({ endpoint, wallet, timeoutMs = 15000 }) {
  const data = await graphql({
    endpoint,
    query: SIWS_CHALLENGE,
    variables: { wallet },
    timeoutMs,
  });

  const node = data?.siwsChallenge;
  if (!node || typeof node.message !== 'string' || typeof node.nonce !== 'string') {
    throw new Error('prmpt: siwsChallenge returned no challenge');
  }
  return {
    wallet: typeof node.wallet === 'string' ? node.wallet : wallet,
    nonce: node.nonce,
    message: node.message,
    expiresAt: typeof node.expiresAt === 'string' ? node.expiresAt : null,
  };
}

/**
 * Hand back the signature and take the user JWT.
 *
 * The nonce is consumed by the backend before the signature is even checked, so
 * a failure here burns the challenge. Retrying means minting a fresh one, which
 * is why the login command runs both halves rather than exposing them apart.
 */
export async function siwsVerify({ endpoint, wallet, nonce, signature, timeoutMs = 15000 }) {
  const data = await graphql({
    endpoint,
    query: SIWS_VERIFY,
    variables: { wallet, nonce, signature },
    timeoutMs,
  });

  const node = data?.siwsVerify;
  if (!node || typeof node.token !== 'string' || !node.token) {
    throw new Error('prmpt: siwsVerify returned no token');
  }
  return {
    token: node.token,
    expiresAt: typeof node.expiresAt === 'string' ? node.expiresAt : null,
    installId: node.user?.installId ?? null,
    solanaWallet: node.user?.solanaWallet ?? null,
    evmWallet: node.user?.evmWallet ?? null,
    payoutToken: node.user?.payoutToken ?? null,
    payoutChain: node.user?.payoutChain ?? null,
  };
}
