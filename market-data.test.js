import test from "node:test";
import assert from "node:assert/strict";
import {
  createMarketQuery, normalizeMarkets, marketFreshness, snapshotCovers,
  createMarketDataService, createMarketDataView
} from "./market-data.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = markets => ({ ok: true, json: async () => markets });
const quote = (currency = "usd", ids = ["bitcoin"], fetchedAt = 1000, price = 10) =>
  normalizeMarkets(ids.map(id => ({ id, current_price: price })), createMarketQuery(currency, ids), fetchedAt);

test("market queries are order independent, deduplicated and restricted to supported currencies", () => {
  assert.deepEqual(createMarketQuery("eur", ["solana", "bitcoin", "solana"]), { currency: "eur", ids: ["bitcoin", "solana"] });
  for (const [currency, ids] of [["gbp", ["bitcoin"]], ["usd", null], ["usd", [null]], ["usd", [""]], ["usd", ["btc,eth"]]]) {
    assert.throws(() => createMarketQuery(currency, ids), /Invalid market query/);
  }
});

test("normalization preserves signs, zeroes, quote-currency changes and provider freshness", () => {
  const snapshot = normalizeMarkets([{
    id: "bitcoin", image: "https://assets.coingecko.com/bitcoin.png", current_price: 0, market_cap: 12, total_volume: 0,
    price_change_percentage_24h: 4, price_change_percentage_24h_in_currency: -2.3,
    last_updated: "2026-10-08T10:00:00Z", extra: "not retained"
  }, null, {}, { id: "unrequested", current_price: 20 }], createMarketQuery("eur", ["bitcoin"]), Date.parse("2026-10-08T10:01:00Z"));
  assert.deepEqual(snapshot.markets.bitcoin, {
    id: "bitcoin", image: "https://assets.coingecko.com/bitcoin.png", price: 0, marketCap: 12, volume24h: 0, change24h: -2.3,
    updatedAt: Date.parse("2026-10-08T10:00:00Z")
  });
  assert.deepEqual(Object.keys(snapshot.markets), ["bitcoin"]);
  assert.equal(snapshot.currency, "eur");
  assert.equal(snapshotCovers(snapshot, createMarketQuery("usd", ["bitcoin"])), false);
});

test("normalization never turns missing or nonfinite data into zero; handles invalid/future provider times", () => {
  const query = createMarketQuery("usd", ["a", "b"]);
  const snapshot = normalizeMarkets([
    { id: "a", current_price: "1", market_cap: Infinity, total_volume: NaN,
      price_change_percentage_24h_in_currency: NaN, price_change_percentage_24h: -3, last_updated: "bad" },
    { id: "b", last_updated: "2026-10-08T11:00:00Z" }
  ], query, 1000);
  assert.deepEqual(snapshot.markets.a, { id: "a", image: null, price: null, marketCap: null, volume24h: null, change24h: -3, updatedAt: null });
  assert.equal(snapshot.markets.b.updatedAt, 1000);
  assert.equal(snapshot.markets.b.change24h, null);
  assert.throws(() => normalizeMarkets({ error: "rate limit" }, query, 1000), /Invalid market response/);
});

test("freshness is the oldest visible provider quote, not render time; missing quotes have no freshness", () => {
  const snapshot = quote("usd", ["bitcoin", "ethereum"], 1000);
  snapshot.markets.bitcoin.updatedAt = 200;
  snapshot.markets.ethereum.updatedAt = 500;
  assert.equal(marketFreshness(snapshot, ["ethereum", "bitcoin"]), 200);
  assert.equal(marketFreshness(snapshot, ["ethereum"]), 500);
  assert.equal(marketFreshness(snapshot, ["missing"]), null);
  assert.equal(marketFreshness(null, ["bitcoin"]), null);
  assert.equal(marketFreshness(quote(), ["bitcoin"]), 1000);
});

test("shared service coalesces concurrent requests and reuses a fresh superset across surfaces", async () => {
  const pending = deferred();
  const requests = [];
  const service = createMarketDataService({ fetchImpl: (url, options) => { requests.push({ url, options }); return pending.promise; }, now: () => 1000 });
  const a = service.load("usd", ["bitcoin", "ethereum"]);
  const b = service.load("usd", ["ethereum", "bitcoin", "bitcoin"], true);
  assert.equal(a, b);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get("vs_currency"), "usd");
  assert.equal(url.searchParams.get("ids"), "bitcoin,ethereum");
  assert.equal(url.searchParams.get("price_change_percentage"), "24h");
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  pending.resolve(response([{ id: "bitcoin", current_price: 10 }]));
  const snapshot = await a;
  assert.equal(await service.load("usd", ["bitcoin"]), snapshot);
  assert.equal(requests.length, 1);
});

test("cache freshness is based on actual fetch completion; forced refresh and other currency fetch independently", async () => {
  let clock = 1000, calls = 0;
  const service = createMarketDataService({ fetchImpl: async () => { calls++; clock += 100; return response([{ id: "bitcoin", current_price: calls }]); }, now: () => clock, cacheMs: 500 });
  const first = await service.load("usd", ["bitcoin"]);
  assert.equal(first.fetchedAt, 1100);
  assert.equal(await service.load("usd", ["bitcoin"]), first);
  await service.load("usd", ["bitcoin"], true);
  await service.load("eur", ["bitcoin"]);
  clock += 501;
  await service.load("usd", ["bitcoin"]);
  assert.equal(calls, 4);
});

test("HTTP, JSON and malformed-response failures do not poison cache or block subsequent retries", async () => {
  let mode = "ok", clock = 1000, calls = 0;
  const service = createMarketDataService({ now: () => clock, fetchImpl: async () => {
    calls++;
    if (mode === "http") return { ok: false, status: 429 };
    if (mode === "json") return { ok: true, json: async () => { throw new Error("Invalid JSON"); } };
    return response(mode === "malformed" ? {} : [{ id: "bitcoin", current_price: calls }]);
  } });
  const first = await service.load("usd", ["bitcoin"]);
  for (const failure of ["http", "json", "malformed"]) {
    mode = failure;
    await assert.rejects(service.load("usd", ["bitcoin"], true));
    assert.equal(await service.load("usd", ["bitcoin"]), first);
  }
  mode = "ok";
  clock++;
  assert.notEqual(await service.load("usd", ["bitcoin"], true), first);
  assert.equal(calls, 5);
});

test("hung requests are aborted and can be retried", async () => {
  const service = createMarketDataService({ timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
  }) });
  await assert.rejects(service.load("usd", ["bitcoin"]), /Aborted/);
  await assert.rejects(service.load("usd", ["bitcoin"]), /Aborted/);
});

test("bounded cache and closed-view broadcast errors cannot break fetching", async () => {
  let calls = 0;
  const service = createMarketDataService({ fetchImpl: async () => { calls++; return response([]); }, now: () => 1000,
    onSnapshot: () => { throw new Error("UI closed"); } });
  for (let index = 0; index < 9; index++) await service.load("usd", [`coin-${index}`]);
  await service.load("usd", ["coin-0"]);
  assert.equal(calls, 10);
  await assert.rejects(service.load("usd", []), /No assets/);
});

test("USD/EUR/USD switching rejects old successes and errors, even when the final query matches again", async () => {
  const calls = [];
  const view = createMarketDataView({ request: (currency, ids) => { const pending = deferred(); calls.push({ currency, ids, pending }); return pending.promise; } });
  view.setQuery("usd", ["bitcoin"]);
  const usdOld = view.refresh();
  view.setQuery("eur", ["bitcoin"]);
  const eur = view.refresh();
  view.setQuery("usd", ["bitcoin"]);
  const usdNew = view.refresh();
  await Promise.resolve();
  assert.deepEqual(calls.map(call => call.currency), ["usd", "eur", "usd"]);
  calls[2].pending.resolve(quote("usd", ["bitcoin"], 3000, 30));
  await usdNew;
  calls[0].pending.resolve(quote("usd", ["bitcoin"], 1000, 10));
  calls[1].pending.reject(new Error("EUR failed"));
  await Promise.all([usdOld, eur]);
  assert.equal(view.snapshot.markets.bitcoin.price, 30);
  assert.equal(view.error, null);
});

test("switching currency hides old prices immediately; disabled assets cannot resurrect an empty watchlist", async () => {
  const view = createMarketDataView({ request: async () => quote() });
  view.setQuery("usd", ["bitcoin"]);
  await view.refresh();
  view.setQuery("eur", ["bitcoin"]);
  assert.equal(view.snapshot, null);
  assert.equal(view.accept(quote()), false);
  view.setQuery("usd", []);
  assert.equal(view.accept(quote()), false);
  assert.equal(await view.refresh(), undefined);
});

test("partial quotes remain useful when enabling an asset, but an old subset response cannot satisfy the new query", async () => {
  const view = createMarketDataView({ request: async () => quote() });
  view.setQuery("usd", ["bitcoin"]);
  await view.refresh();
  view.setQuery("usd", ["bitcoin", "ethereum"]);
  assert.equal(view.needsData, true);
  assert.equal(view.snapshot.markets.bitcoin.price, 10);
  assert.equal(view.accept(quote()), false);
  assert.equal(view.accept(quote("usd", ["bitcoin", "ethereum"], 2000)), true);
  assert.equal(view.needsData, false);
});

test("reorders and removal preserve freshness and quotes without requesting data", async () => {
  let calls = 0;
  const view = createMarketDataView({ request: async () => { calls++; return quote("usd", ["bitcoin", "ethereum"]); } });
  view.setQuery("usd", ["bitcoin", "ethereum"]);
  await view.refresh();
  const snapshot = view.snapshot;
  view.setQuery("usd", ["ethereum", "bitcoin"]);
  view.setQuery("usd", ["ethereum"]);
  assert.equal(view.needsData, false);
  assert.equal(view.snapshot, snapshot);
  assert.equal(marketFreshness(view.snapshot, ["ethereum"]), 1000);
  assert.equal(calls, 1);
});

test("same-query overlap is coalesced and refresh failure preserves the last successful snapshot", async () => {
  const pending = deferred();
  let calls = 0;
  const view = createMarketDataView({ request: () => { calls++; return pending.promise; } });
  view.setQuery("usd", ["bitcoin"]);
  const first = view.refresh();
  assert.equal(view.refresh(true), first);
  view.accept(quote());
  pending.reject(new Error("offline"));
  await first;
  // A success received during the request takes precedence over its later error.
  assert.equal(view.error, null);
  const failed = createMarketDataView({ request: async () => { throw new Error("offline"); } });
  failed.setQuery("usd", ["bitcoin"]);
  const snapshot = quote();
  failed.accept(snapshot);
  await failed.refresh();
  assert.equal(failed.snapshot, snapshot);
  assert.match(failed.error.message, /offline/);
  assert.equal(calls, 1);
});

test("both surfaces receive successful refreshes, rejecting older or wrong-currency broadcasts", async () => {
  const views = [];
  let price = 10, clock = 1000, calls = 0;
  const service = createMarketDataService({ now: () => clock,
    fetchImpl: async () => { calls++; return response([{ id: "bitcoin", current_price: price }]); },
    onSnapshot: snapshot => views.forEach(view => view.accept(snapshot)) });
  for (let index = 0; index < 2; index++) {
    const view = createMarketDataView({ request: (...args) => service.load(...args) });
    view.setQuery("usd", ["bitcoin"]);
    views.push(view);
  }
  await Promise.all(views.map(view => view.refresh()));
  assert.equal(calls, 1);
  clock = 2000;
  price = 20;
  await views[0].refresh(true);
  for (const view of views) {
    assert.equal(view.snapshot.markets.bitcoin.price, 20);
    assert.equal(view.accept(quote("usd", ["bitcoin"], 1000)), false);
    assert.equal(view.accept(quote("eur", ["bitcoin"], 3000)), false);
    assert.equal(view.snapshot.fetchedAt, 2000);
  }
  assert.equal(calls, 2);
});

test("a slower old superset broadcast cannot overwrite a more recently requested subset", () => {
  const view = createMarketDataView({ request: async () => quote() });
  view.setQuery("usd", ["bitcoin"]);
  const latest = normalizeMarkets([{ id: "bitcoin", current_price: 20 }], createMarketQuery("usd", ["bitcoin"]), 3000, 2000);
  const slowOld = normalizeMarkets([{ id: "bitcoin", current_price: 10 }], createMarketQuery("usd", ["bitcoin", "ethereum"]), 4000, 1000);
  assert.equal(view.accept(latest), true);
  assert.equal(view.accept(slowOld), false);
  assert.equal(view.snapshot.markets.bitcoin.price, 20);
});

test("cache returns the newest covering query, not an older exact-query entry", async () => {
  let clock = 1000, price = 10;
  const service = createMarketDataService({ now: () => clock, fetchImpl: async url => response(
    new URL(url).searchParams.get("ids").split(",").map(id => ({ id, current_price: price }))) });
  await service.load("usd", ["bitcoin"]);
  clock = 2000;
  price = 20;
  await service.load("usd", ["bitcoin", "ethereum"]);
  assert.equal((await service.load("usd", ["bitcoin"])).markets.bitcoin.price, 20);
});

test("simultaneous different queries have a strict order even when the clock has millisecond ties", async () => {
  const old = deferred(), latest = deferred();
  const view = createMarketDataView({ request: async () => quote() });
  view.setQuery("usd", ["bitcoin"]);
  const service = createMarketDataService({ now: () => 1000,
    fetchImpl: url => new URL(url).searchParams.get("ids").includes("ethereum") ? old.promise : latest.promise,
    onSnapshot: snapshot => view.accept(snapshot) });
  const first = service.load("usd", ["bitcoin", "ethereum"]);
  const second = service.load("usd", ["bitcoin"]);
  latest.resolve(response([{ id: "bitcoin", current_price: 20 }]));
  await second;
  old.resolve(response([{ id: "bitcoin", current_price: 10 }]));
  await first;
  assert.equal(view.snapshot.markets.bitcoin.price, 20);
  assert.equal((await service.load("usd", ["bitcoin"])).markets.bitcoin.price, 20);
});
