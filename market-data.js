// Shared provider boundary. Missing/invalid numbers stay null, never become zero.
const MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets";
export const BTC_BENCHMARK_ID = "bitcoin";
export const MARKET_REQUEST = "zmetrics:get-markets";
export const MARKET_UPDATED = "zmetrics:markets-updated";

export function createMarketQuery(currency, ids) {
  if (!["usd", "eur"].includes(currency) || !Array.isArray(ids) ||
      ids.some(id => typeof id !== "string" || !id.trim() || id.includes(","))) {
    throw new Error("Invalid market query");
  }
  return { currency, ids: [...new Set(ids)].sort() };
}

function queryKey(query) {
  return JSON.stringify([query.currency, query.ids]);
}

export function normalizeMarkets(markets, query, fetchedAt, requestOrder = fetchedAt) {
  if (!Array.isArray(markets)) throw new Error("Invalid market response");
  const finite = value => Number.isFinite(value) ? value : null;
  const rows = markets.filter(market => market && query.ids.includes(market.id));
  return {
    currency: query.currency,
    requestedIds: [...query.ids],
    fetchedAt,
    requestOrder,
    markets: Object.fromEntries(rows.map(market => {
      const updatedAt = typeof market.last_updated === "string"
        ? Date.parse(market.last_updated) : NaN;
      return [market.id, {
        id: market.id,
        image: typeof market.image === "string" ? market.image : null,
        price: finite(market.current_price),
        marketCap: finite(market.market_cap),
        // Prefer the change in the requested quote currency (not the USD fallback).
        change24h: finite(market.price_change_percentage_24h_in_currency) ??
          finite(market.price_change_percentage_24h),
        volume24h: finite(market.total_volume),
        updatedAt: Number.isFinite(updatedAt) ? Math.min(updatedAt, fetchedAt) : null
      }];
    }))
  };
}

export function snapshotCovers(snapshot, query) {
  return snapshot?.currency === query.currency &&
    query.ids.every(id => snapshot.requestedIds.includes(id));
}

export function marketFreshness(snapshot, ids) {
  if (!snapshot) return null;
  const timestamps = ids.flatMap(id => {
    const market = snapshot.markets[id];
    return market?.price != null ? [market.updatedAt ?? snapshot.fetchedAt] : [];
  });
  // The table must not appear newer than its oldest available quote.
  return timestamps.length ? Math.min(...timestamps) : null;
}

// One service in the existing worker shares identical in-flight requests and a
// small memory-only cache across both views. No polling or storage is added here.
export function createMarketDataService({
  fetchImpl = fetch, now = Date.now, cacheMs = 55000, timeoutMs = 15000,
  onSnapshot = () => {}
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  let lastRequestOrder = 0;
  return {
    load(currency, ids, force = false) {
      const query = createMarketQuery(currency, ids);
      if (!query.ids.length) return Promise.reject(new Error("No assets selected"));
      // Benchmark-only data travels in the same request/cache. The view's query
      // and saved selection remain unchanged; an empty watchlist never fetches.
      if (!query.ids.includes(BTC_BENCHMARK_ID)) {
        query.ids.push(BTC_BENCHMARK_ID);
        query.ids.sort();
      }
      const key = queryKey(query);
      if (inFlight.has(key)) return inFlight.get(key);
      // Below the 60s UI interval so a regular poll isn't skipped due to jitter.
      if (!force) {
        const shared = [...cache.values()].filter(snapshot => {
          const age = now() - snapshot.fetchedAt;
          return snapshotCovers(snapshot, query) && age >= 0 && age < cacheMs;
        }).sort((a, b) => b.requestOrder - a.requestOrder)[0];
        if (shared) return Promise.resolve(shared);
      }
      const operation = (async () => {
        // A logical ordering stamp, separate from freshness. Break ties for
        // requests starting in the same millisecond, including different ID sets.
        const requestOrder = Math.max(now(), lastRequestOrder + 1);
        lastRequestOrder = requestOrder;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const params = new URLSearchParams({
            vs_currency: query.currency, ids: query.ids.join(","),
            price_change_percentage: "24h", per_page: "250"
          });
          const response = await fetchImpl(`${MARKETS_URL}?${params}`, { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const snapshot = normalizeMarkets(await response.json(), query, now(), requestOrder);
          cache.delete(key);
          cache.set(key, snapshot);
          if (cache.size > 8) cache.delete(cache.keys().next().value);
          // A closed UI must not turn an otherwise successful fetch into an error.
          try { onSnapshot(snapshot); } catch {}
          return snapshot;
        } finally {
          clearTimeout(timer);
        }
      })();
      inFlight.set(key, operation);
      const cleanup = () => inFlight.delete(key);
      operation.then(cleanup, cleanup);
      return operation;
    }
  };
}

// UI state: responses only apply to the current quote currency/selection.
// Keeping this independent of the DOM makes race handling directly testable.
export function createMarketDataView({ request, onChange = () => {} }) {
  let query = createMarketQuery("usd", []);
  let revision = 0;
  let snapshot = null;
  let error = null;
  let pending = null;
  const accept = next => {
    if (!query.ids.length || !snapshotCovers(next, query) ||
        (snapshot && (next.requestOrder < snapshot.requestOrder ||
          (next.requestOrder === snapshot.requestOrder && next.fetchedAt < snapshot.fetchedAt)))) return false;
    snapshot = next;
    error = null;
    onChange();
    return true;
  };
  return {
    get snapshot() { return snapshot; },
    get error() { return error; },
    get needsData() { return !snapshotCovers(snapshot, query); },
    setQuery(currency, ids) {
      const next = createMarketQuery(currency, ids);
      if (queryKey(next) === queryKey(query)) return;
      query = next;
      revision++;
      error = null;
      if (snapshot?.currency !== query.currency || !query.ids.length) snapshot = null;
      onChange();
    },
    accept,
    refresh(force = false) {
      if (!query.ids.length) return Promise.resolve();
      if (pending?.revision === revision) return pending.promise;
      const requestedRevision = revision;
      const requestedQuery = query;
      const previousSnapshot = snapshot;
      const operation = Promise.resolve().then(() => request(requestedQuery.currency, requestedQuery.ids, force))
        .then(next => {
          if (requestedRevision === revision) accept(next);
        }, err => {
          // A late failure must not replace a newer successful broadcast.
          if (requestedRevision === revision && snapshot === previousSnapshot) {
            error = err;
            onChange();
          }
        });
      pending = { revision: requestedRevision, promise: operation };
      operation.then(() => {
        if (pending?.promise === operation) pending = null;
      });
      return operation;
    }
  };
}
