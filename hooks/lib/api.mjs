// adengine -- the backend GraphQL client.
//
// Two callers: the end-of-turn hook (serveAd) and the register CLI
// (registerPublisher). serveAd never throws: it resolves to null on any
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

const REGISTER_PUBLISHER = `mutation RegisterPublisher($solanaWallet: String!) {
  registerPublisher(solanaWallet: $solanaWallet) {
    installId
    apiKey
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
async function graphql({ endpoint, apiKey, query, variables, timeoutMs = 1500 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'adengine-plugin/0.1.0',
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Drain so the socket can be reused/closed rather than left dangling.
      await res.text().catch(() => {});
      const err = new Error(`adengine: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    if (json && Array.isArray(json.errors) && json.errors.length > 0) {
      const err = new Error(json.errors[0]?.message || 'adengine: GraphQL error');
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
      apiKey: config.apiKey,
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
 * Register a publisher wallet and mint an API key.
 *
 * Unlike serveAd this one throws, because the register CLI is interactive and
 * the operator needs to see why it failed.
 */
export async function registerPublisher({ endpoint, solanaWallet, timeoutMs = 15000 }) {
  const data = await graphql({
    endpoint,
    query: REGISTER_PUBLISHER,
    variables: { solanaWallet },
    timeoutMs,
  });

  // Tolerate either a flat payload or one nested under `publisher`.
  const node = data?.registerPublisher;
  if (!node || typeof node !== 'object') {
    throw new Error('adengine: registerPublisher returned no data');
  }
  const installId = node.installId ?? node.publisher?.installId;
  const apiKey = node.apiKey ?? node.key;
  if (typeof apiKey !== 'string' || !apiKey) {
    throw new Error('adengine: registerPublisher returned no API key');
  }
  return { installId: typeof installId === 'string' ? installId : null, apiKey };
}
