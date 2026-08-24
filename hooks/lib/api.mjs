// prmpt -- the backend GraphQL client.
//
// Two callers: the end-of-turn hook (serveAd) and the link CLI
// (exchangeInstallCode). serveAd never throws: it resolves to null on any
// failure at all, because a failed ad request must be indistinguishable from
// "no ad matched".

const SERVE_AD = `mutation ServeAd($input: TurnContextInput!) {
  serveAd(input: $input) {
    requestId
    headline
    body
    clickUrl
  }
}`;

// A terminal cannot open a wallet prompt, so the plugin does not sign anything.
// The wallet is proven once in the dashboard, which mints a one-off code; this
// exchanges that code for the plugin's own long-lived token.
//
// installId lives on the nested `publisher`, not on the payload. Asking for it
// at the top level is a VALIDATION error, so the request fails with HTTP 422
// before a response body exists -- which the tolerant parsing below can do
// nothing about, because it never runs.
const EXCHANGE_INSTALL_CODE = `mutation ExchangeInstallCode($code: String!) {
  exchangeInstallCode(code: $code) {
    token
    expiresAt
    publisher {
      installId
      solanaWallet
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
      'user-agent': 'prmpt-plugin/0.1.0',
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
 * Redeem a one-off install code for this install's own token.
 *
 * Unlike serveAd this one throws, because the link CLI is interactive and the
 * publisher needs to see why it failed. The code is single-use: a failure here
 * means going back to the dashboard for a fresh one.
 */
export async function exchangeInstallCode({ endpoint, code, timeoutMs = 15000 }) {
  const data = await graphql({
    endpoint,
    query: EXCHANGE_INSTALL_CODE,
    variables: { code },
    timeoutMs,
  });

  const node = data?.exchangeInstallCode;
  if (!node || typeof node !== 'object') {
    throw new Error('prmpt: exchangeInstallCode returned no data');
  }
  const token = node.token;
  if (typeof token !== 'string' || !token) {
    throw new Error('prmpt: exchangeInstallCode returned no token');
  }
  return {
    token,
    expiresAt: typeof node.expiresAt === 'string' ? node.expiresAt : null,
    installId: node.publisher?.installId ?? null,
    solanaWallet: node.publisher?.solanaWallet ?? null,
  };
}
