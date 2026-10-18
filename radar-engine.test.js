import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWatchlist, RADAR_DEFAULTS } from "./radar-engine.js";
import { createMarketQuery, normalizeMarkets, createMarketDataService } from "./market-data.js";

const NOW = Date.parse("2026-10-08T12:00:00Z");
function snapshot(changes, currency = "usd") {
  return normalizeMarkets(Object.entries(changes).map(([id, change24h]) => ({
    id, current_price: 10, price_change_percentage_24h_in_currency: change24h,
    last_updated: new Date(NOW - 1000).toISOString()
  })), createMarketQuery(currency, Object.keys(changes)), NOW);
}
const analyze = (changes, ids, thresholds = {}) => analyzeWatchlist(snapshot(changes), ids, { now: NOW, thresholds });
const types = result => result.observations.map(observation => observation.type);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("equal-weight calculations exclude hidden BTC, deduplicate IDs and exclude self from peer averages", () => {
  const result = analyze({ bitcoin: 2, a: 10, b: -2, c: 1 }, ["c", "b", "a", "a"]);
  near(result.summary.averageChange24h, 3);
  assert.equal(result.summary.assetCount, 3);
  assert.equal(result.summary.scope, "eligible-assets");
  assert.equal(result.coverage.selectedCount, 3);
  assert.deepEqual(result.assets.map(asset => asset.id), ["a", "b", "c"]);
  assert.equal(result.assets[0].btcGapPp, 8);
  assert.equal(result.assets[0].peersAverage24h, -0.5);
  assert.equal(result.assets[0].peersGapPp, 10.5);
  assert.deepEqual(result.summary.strongest, { ids: ["a"], change24h: 10 });
  assert.deepEqual(result.summary.weakest, { ids: ["b"], change24h: -2 });
  assert.equal(result.summary.spreadPp, 12);
});

test("explicitly selected BTC gets exactly one equal weight and never a BTC self-comparison", () => {
  const result = analyze({ bitcoin: 2, a: 10, b: -2 }, ["bitcoin", "bitcoin", "a", "b"]);
  near(result.summary.averageChange24h, 10 / 3);
  assert.equal(result.assets.find(asset => asset.id === "bitcoin").btcGapPp, null);
  assert.equal(result.assets.find(asset => asset.id === "bitcoin").peersAverage24h, 4);
  assert.ok(!result.observations.some(observation => observation.type === "btc-relative" && observation.assetId === "bitcoin"));
});

test("BTC performance is a signed pp gap, not a mislabeled relative pair return", () => {
  const result = analyze({ bitcoin: 10, a: 20 }, ["a"]);
  assert.deepEqual(result.observations[0], {
    type: "btc-relative", assetId: "a", relevance: 2.5, direction: "outperforming",
    change24h: 20, btcChange24h: 10, gapPp: 10
  });
  const down = analyze({ bitcoin: -2, a: -8 }, ["a"]);
  assert.equal(down.observations[0].direction, "underperforming");
  assert.equal(down.observations[0].gapPp, -6);
  assert.equal(analyze({ bitcoin: -10, a: -5 }, ["a"]).observations[0].direction, "outperforming");
});

test("BTC signal threshold is inclusive without rounding subthreshold values upwards", () => {
  assert.deepEqual(types(analyze({ bitcoin: 1, a: 5 }, ["a"])), ["btc-relative"]);
  assert.equal(analyze({ bitcoin: 1, a: 4.999999 }, ["a"]).status, "quiet");
  assert.deepEqual(types(analyze({ bitcoin: 1, a: -3 }, ["a"])), ["btc-relative"]);
});

test("peer divergence requires two peers and uses an inclusive 5 pp threshold", () => {
  const result = analyze({ a: 5, b: 0, c: 0 }, ["a", "b", "c"]);
  assert.deepEqual(types(result), ["peer-divergence"]);
  assert.equal(result.observations[0].gapPp, 5);
  assert.equal(result.observations[0].peerCount, 2);
  assert.equal(analyze({ a: 4.999999, b: 0, c: 0 }, ["a", "b", "c"]).status, "quiet");
  const small = analyze({ a: 5, b: 0 }, ["a", "b"]);
  assert.ok(small.assets.every(asset => asset.peersAverage24h === null));
  assert.ok(!types(small).includes("peer-divergence"));
  const negative = analyze({ a: -5, b: 0, c: 0 }, ["a", "b", "c"]);
  assert.deepEqual(types(negative), ["peer-divergence"]);
  assert.equal(negative.observations[0].direction, "below");
  assert.equal(negative.observations[0].gapPp, -5);
});

test("both unique strongest and weakest signals are supported; relative ranks do not imply a positive return", () => {
  const strongest = analyze({ a: 3, b: -3, c: -1, d: -1 }, ["a", "b", "c", "d"]);
  assert.deepEqual(types(strongest), ["strongest-performer"]);
  assert.equal(strongest.observations[0].assetId, "a");
  const weakest = analyze({ a: -3, b: 3, c: 1, d: 1 }, ["a", "b", "c", "d"]);
  assert.deepEqual(types(weakest), ["weakest-performer"]);
  assert.equal(weakest.observations[0].assetId, "a");
  const allNegative = analyze({ a: -1, b: -7 }, ["a", "b"], { watchlistMovePercent: 100 });
  assert.deepEqual(types(allNegative), ["strongest-performer"]);
  assert.equal(allNegative.observations[0].change24h, -1);
});

test("rankings require meaningful spread and deviation, and report ties without inventing a unique leader", () => {
  assert.equal(analyze({ a: 2.99, b: -3 }, ["a", "b"]).observations.length, 0);
  assert.deepEqual(types(analyze({ a: 3, b: -3 }, ["a", "b"])), ["strongest-performer"]);
  assert.equal(analyze({ a: 3, b: -3, c: 0 }, ["a", "b", "c"], { performerGapPp: 3.01 }).observations.length, 0);
  const tied = analyze({ a: 3, b: 3, c: -3, d: -3 }, ["d", "c", "b", "a"]);
  assert.deepEqual(tied.summary.strongest.ids, ["a", "b"]);
  assert.deepEqual(tied.summary.weakest.ids, ["c", "d"]);
  assert.equal(tied.observations.length, 0);
});

test("broad movement uses equal-weight mean plus breadth, with positive and negative directions", () => {
  const up = analyze({ bitcoin: 3, a: 3, b: 3, c: 3 }, ["a", "b", "c"]);
  assert.deepEqual(types(up), ["watchlist-move"]);
  assert.equal(up.observations[0].averageChange24h, 3);
  assert.equal(up.observations[0].breadth, 1);
  assert.equal(up.observations[0].direction, "up");
  const down = analyze({ bitcoin: -3, a: -3, b: -3, c: -3 }, ["a", "b", "c"]);
  assert.equal(down.observations[0].direction, "down");
  assert.equal(analyze({ bitcoin: 2.99999, a: 2.99999, b: 2.99999, c: 2.99999 }, ["a", "b", "c"]).status, "quiet");
  const mixed = analyze({ a: 5, b: 5, c: -1 }, ["a", "b", "c"]);
  assert.ok(types(mixed).includes("watchlist-move"));
  assert.equal(mixed.observations.find(observation => observation.type === "watchlist-move").breadth, 2 / 3);
  assert.ok(!types(analyze({ a: 5, b: 5, c: -1 }, ["a", "b", "c"], { minDirectionalBreadth: 1 })).includes("watchlist-move"));
});

test("one outlier does not generate repetitive peer effects or pretend the whole watchlist moved", () => {
  const result = analyze({ bitcoin: 0, a: 20, b: 0, c: 0, d: 0 }, ["a", "b", "c", "d"]);
  assert.deepEqual(types(result), ["btc-relative"]);
  assert.equal(result.observations[0].assetId, "a");
  near(result.summary.averageChange24h, 5);
  const tinyPeers = analyze({ bitcoin: 0, a: 20, b: 0.01, c: 0.01 }, ["a", "b", "c"]);
  assert.deepEqual(types(tinyPeers), ["btc-relative"]);
});

test("two-asset BTC comparisons do not also describe the same pair with a mirrored ranking", () => {
  const result = analyze({ bitcoin: 10, a: 0 }, ["bitcoin", "a"]);
  assert.deepEqual(types(result), ["btc-relative"]);
  assert.deepEqual(result.summary.strongest.ids, ["bitcoin"]);
  assert.deepEqual(result.summary.weakest.ids, ["a"]);
});

test("selection can emit three useful nonduplicate facts, ranked by relevance, but never more", () => {
  const result = analyze({ bitcoin: 20, a: 16, b: 4, c: 4 }, ["a", "b", "c"]);
  assert.deepEqual(types(result), ["btc-relative", "watchlist-move", "peer-divergence"]);
  assert.equal(result.observations[0].assetId, "b");
  assert.equal(result.observations[2].assetId, "a");
  assert.equal(result.observations.length, 3);
  assert.ok(result.observations.every((observation, index) => index === 0 || result.observations[index - 1].relevance >= observation.relevance));
  assert.deepEqual(analyze({ bitcoin: 20, a: 16, b: 4, c: 4 }, ["a", "b", "c"], { maxObservations: 1 }).observations, result.observations.slice(0, 1));
});

test("flat or small movement returns quiet rather than filling three slots", () => {
  for (const changes of [{ bitcoin: 0, a: 0, b: 0, c: 0 }, { bitcoin: 0.3, a: 1, b: -0.2, c: 0.1 }]) {
    const result = analyze(changes, ["a", "b", "c"]);
    assert.equal(result.status, "quiet");
    assert.deepEqual(result.observations, []);
  }
});

test("empty, invalid and BTC-only watchlists are safe; single assets only get BTC comparisons", () => {
  const data = { bitcoin: 10, a: 15 };
  for (const ids of [[], null, undefined, [null, "", "a,b", 5]]) {
    assert.equal(analyze(data, ids).status, "empty");
  }
  const btc = analyze(data, ["bitcoin"]);
  assert.equal(btc.status, "quiet");
  assert.deepEqual(btc.observations, []);
  const single = analyze(data, ["a"]);
  assert.deepEqual(types(single), ["btc-relative"]);
  assert.equal(single.assets[0].peersGapPp, null);
  assert.equal(analyze({ a: 10 }, ["a"]).status, "insufficient-data");
});

test("partial coverage suppresses whole-watchlist claims but allows independent BTC facts", () => {
  const result = analyze({ bitcoin: 0, a: 10, b: 10 }, ["a", "b", "missing"]);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.excluded, [{ id: "missing", reason: "missing-market" }]);
  assert.equal(result.summary.averageChange24h, 10);
  assert.equal(result.summary.assetCount, 2);
  assert.deepEqual(types(result), ["btc-relative"]);
  assert.ok(result.assets.every(asset => asset.peersGapPp === null));
  assert.equal(analyze({ bitcoin: 0, a: 0 }, ["a", "missing"]).status, "insufficient-data");
});

test("provider freshness is required; recent fetching must not rejuvenate old or undated quotes", () => {
  const data = snapshot({ bitcoin: 0, a: 10, b: 0, c: 0 });
  data.markets.a.updatedAt = NOW - RADAR_DEFAULTS.maxDataAgeMs - 1;
  const result = analyzeWatchlist(data, ["a", "b", "c"], { now: NOW });
  assert.deepEqual(result.coverage.excluded, [{ id: "a", reason: "stale-market" }]);
  assert.equal(result.status, "insufficient-data");
  assert.deepEqual(result.observations, []);
  for (const value of [null, undefined, NaN, Infinity, -1, NOW + 1]) {
    data.markets.a.updatedAt = value;
    assert.equal(analyzeWatchlist(data, ["a"], { now: NOW }).coverage.excluded[0].reason, "invalid-timestamp");
  }
});

test("age boundaries are inclusive and both snapshot and benchmark ages are checked", () => {
  const data = snapshot({ bitcoin: 0, a: 10 });
  data.fetchedAt = NOW - RADAR_DEFAULTS.maxDataAgeMs;
  data.markets.a.updatedAt = data.markets.bitcoin.updatedAt = data.fetchedAt;
  assert.deepEqual(types(analyzeWatchlist(data, ["a"], { now: NOW })), ["btc-relative"]);
  const expired = analyzeWatchlist(data, ["a"], { now: NOW + 1 });
  assert.equal(expired.coverage.excluded[0].reason, "stale-snapshot");
  assert.equal(expired.coverage.benchmark.reason, "stale-snapshot");
  data.fetchedAt = NOW;
  data.markets.a.updatedAt = NOW;
  data.markets.bitcoin.updatedAt = NOW - RADAR_DEFAULTS.maxDataAgeMs - 1;
  const noBtc = analyzeWatchlist(data, ["a"], { now: NOW });
  assert.equal(noBtc.coverage.benchmark.reason, "stale-market");
  assert.equal(noBtc.assets[0].btcGapPp, null);
  assert.equal(noBtc.status, "insufficient-data");
});

test("large quote timestamp skew suppresses group comparisons and misaligned BTC comparisons", () => {
  const data = snapshot({ bitcoin: 0, a: 0, b: 0, c: 0 });
  data.markets.a.updatedAt = NOW;
  data.markets.b.updatedAt = NOW - RADAR_DEFAULTS.maxQuoteSkewMs - 1;
  const result = analyzeWatchlist(data, ["a", "b", "c"], { now: NOW });
  assert.equal(result.coverage.coherent, false);
  assert.equal(result.summary.averageChange24h, null);
  assert.equal(result.summary.strongest, null);
  assert.equal(result.status, "insufficient-data");
  data.markets.bitcoin.updatedAt = NOW;
  assert.equal(analyzeWatchlist(data, ["b"], { now: NOW }).assets[0].btcGapPp, null);
  data.markets.b.updatedAt = NOW - RADAR_DEFAULTS.maxQuoteSkewMs;
  data.markets.b.change24h = 10;
  assert.equal(analyzeWatchlist(data, ["b"], { now: NOW }).assets[0].btcGapPp, 10);
});

test("missing benchmark does not invent BTC data or suppress other valid watchlist signals", () => {
  const result = analyze({ a: 4, b: 4, c: 4 }, ["a", "b", "c"]);
  assert.equal(result.coverage.benchmark.reason, "missing-market");
  assert.deepEqual(types(result), ["watchlist-move"]);
  assert.ok(result.assets.every(asset => asset.btcGapPp === null));
});

test("malformed snapshots, wrong currencies and future fetch timestamps return explicit exclusions", () => {
  for (const data of [null, undefined, {}, { ...snapshot({ a: 0 }), currency: "gbp" },
    { ...snapshot({ a: 0 }), markets: [] }, { ...snapshot({ a: 0 }), fetchedAt: Infinity },
    { ...snapshot({ a: 0 }), fetchedAt: -1 }, { ...snapshot({ a: 0 }), fetchedAt: NOW + 1 }]) {
    const result = analyzeWatchlist(data, ["a"], { now: NOW });
    assert.equal(result.status, "insufficient-data");
    assert.equal(result.currency, null);
    assert.deepEqual(result.coverage.excluded, [{ id: "a", reason: "invalid-snapshot" }]);
  }
});

test("missing, malformed, nonfinite and impossible percentage values cannot produce signals", () => {
  for (const value of [null, undefined, "10", NaN, Infinity, -Infinity, -100.01]) {
    const result = analyze({ bitcoin: 0, a: value }, ["a"]);
    assert.equal(result.status, "insufficient-data");
    assert.equal(result.coverage.excluded[0].reason, "invalid-change");
    assert.deepEqual(result.observations, []);
  }
  assert.equal(analyze({ bitcoin: 0, a: -100 }, ["a"]).assets[0].change24h, -100);
  assert.equal(analyze({ bitcoin: -100, a: 0 }, ["a"]).assets[0].btcGapPp, 100);
  const data = snapshot({ a: 10 });
  data.markets.a.id = "wrong";
  assert.equal(analyzeWatchlist(data, ["a"], { now: NOW }).coverage.excluded[0].reason, "missing-market");
});

test("extreme finite values do not leak Infinity or NaN into the output", () => {
  const result = analyze({ bitcoin: 0, a: Number.MAX_VALUE, b: Number.MAX_VALUE, c: -100 }, ["a", "b", "c"]);
  const walk = value => {
    if (typeof value === "number") assert.ok(Number.isFinite(value));
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(result);
  assert.ok(result.observations.length <= 3);
});

test("explicit time and threshold overrides are validated instead of silently accepting configuration mistakes", () => {
  const data = snapshot({ bitcoin: 0, a: 5 });
  for (const now of [undefined, NaN, Infinity, -1, "now"]) {
    assert.throws(() => analyzeWatchlist(data, ["a"], { now }), /valid explicit now/);
  }
  for (const thresholds of [null, [], { typo: 2 }, { btcRelativePp: NaN }, { maxDataAgeMs: 0 },
    { minDirectionalBreadth: 1.01 }, { minPeerAssets: 2 }, { minMoveAssets: 1 },
    { minMoveAssets: 2.5 }, { maxObservations: 4 }, { maxObservations: 1.5 }]) {
    assert.throws(() => analyzeWatchlist(data, ["a"], { now: NOW, thresholds }), /Invalid Radar thresholds/);
  }
  assert.equal(analyzeWatchlist(data, ["a"], { now: NOW, thresholds: { btcRelativePp: 6 } }).status, "quiet");
  assert.ok(Object.isFrozen(RADAR_DEFAULTS));
});

test("minimum counts and timing limits can be conservatively raised without altering arithmetic", () => {
  const result = analyze({ a: 5, b: 0, c: 0 }, ["a", "b", "c"], { minPeerAssets: 4 });
  assert.ok(!types(result).includes("peer-divergence"));
  near(result.summary.averageChange24h, 5 / 3);
  assert.equal(analyze({ a: 3, b: 3, c: 3 }, ["a", "b", "c"], { minMoveAssets: 4 }).observations.length, 0);
  const data = snapshot({ bitcoin: 0, a: 5 });
  const future = NOW + 6 * 60 * 1000;
  assert.equal(analyzeWatchlist(data, ["a"], { now: future }).status, "insufficient-data");
  assert.deepEqual(types(analyzeWatchlist(data, ["a"], { now: future, thresholds: { maxDataAgeMs: 7 * 60 * 1000 } })), ["btc-relative"]);
});

test("output is deterministic across ID/map order and never mutates caller data", () => {
  const data = snapshot({ bitcoin: 20, a: 16, b: 4, c: 4 });
  const before = structuredClone(data);
  Object.freeze(data);
  Object.values(data.markets).forEach(Object.freeze);
  Object.freeze(data.markets);
  const ids = Object.freeze(["c", "b", "a"]);
  const thresholds = Object.freeze({ maxObservations: 3 });
  const first = analyzeWatchlist(data, ids, { now: NOW, thresholds });
  const reversed = snapshot({ c: 4, b: 4, a: 16, bitcoin: 20 });
  assert.deepEqual(first, analyzeWatchlist(reversed, ["a", "b", "c", "a"], { now: NOW }));
  assert.deepEqual(data, before);
  assert.deepEqual(ids, ["c", "b", "a"]);
});

test("selection invariants hold across varied deterministic watchlists", () => {
  let seed = 123456;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sample = 0; sample < 200; sample++) {
    const count = 1 + next() % 8;
    const changes = { bitcoin: (next() % 4001 - 2000) / 100 };
    const ids = Array.from({ length: count }, (_, index) => `coin-${index}`);
    ids.forEach(id => { changes[id] = (next() % 8001 - 4000) / 100; });
    if (sample % 2 === 0) ids.push("bitcoin");
    const result = analyze(changes, ids);
    assert.deepEqual(result, analyze(changes, [...ids].reverse()));
    assert.ok(result.observations.length <= 3);
    const mentioned = result.observations.filter(observation => observation.assetId).map(observation => observation.assetId);
    assert.equal(new Set(mentioned).size, mentioned.length);
    const families = result.observations.map(observation => observation.type.endsWith("-performer") ? "performer" : observation.type);
    assert.equal(new Set(families).size, families.length);
    assert.ok(result.observations.every(observation => !observation.assetId || ids.includes(observation.assetId)));
    near(result.summary.averageChange24h, ids.reduce((sum, id) => sum + changes[id], 0) / ids.length);
  }
});

test("engine ignores inherited market entries and handles prototype-like selected IDs safely", () => {
  const data = snapshot({ bitcoin: 0 });
  Object.setPrototypeOf(data.markets, { impostor: { id: "impostor", change24h: 99, updatedAt: NOW } });
  const result = analyzeWatchlist(data, ["impostor", "__proto__"], { now: NOW });
  assert.ok(result.coverage.excluded.every(row => row.reason === "missing-market"));
  assert.deepEqual(result.observations, []);
});

test("normalized EUR and USD snapshots both support same-currency analysis without conversion or extra fetching", () => {
  const usd = snapshot({ bitcoin: 2, a: 7 });
  const eur = snapshot({ bitcoin: -1, a: 4 }, "eur");
  assert.equal(analyzeWatchlist(usd, ["a"], { now: NOW }).assets[0].btcGapPp, 5);
  const result = analyzeWatchlist(eur, ["a"], { now: NOW });
  assert.equal(result.currency, "eur");
  assert.equal(result.assets[0].btcGapPp, 5);
});

test("shared fetching includes hidden BTC once in the same request; engine makes no network or storage calls", async (t) => {
  const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; });
  globalThis.fetch = () => { throw new Error("Radar must not fetch"); };
  globalThis.chrome = new Proxy({}, { get() { throw new Error("Radar must not use Chrome APIs"); } });
  const requests = [];
  const ids = Object.freeze(["a", "b", "c"]);
  const service = createMarketDataService({ now: () => NOW, fetchImpl: async url => {
    requests.push(url);
    const query = new URL(url).searchParams;
    assert.equal(query.get("vs_currency"), "eur");
    assert.equal(query.get("ids"), "a,b,bitcoin,c");
    return { ok: true, json: async () => ["a", "b", "c", "bitcoin"].map(id => ({
      id, current_price: 10, price_change_percentage_24h_in_currency: id === "bitcoin" ? 0 : 1,
      last_updated: new Date(NOW).toISOString()
    })) };
  } });
  const [one, two] = await Promise.all([service.load("eur", ids), service.load("eur", ["c", "b", "a"])]);
  assert.equal(one, two);
  const result = analyzeWatchlist(one, ids, { now: NOW });
  assert.equal(result.coverage.benchmark.id, "bitcoin");
  assert.deepEqual(result.assets.map(asset => asset.id), [...ids]);
  assert.equal(result.summary.averageChange24h, 1);
  assert.equal(requests.length, 1);
  assert.equal(await service.load("eur", ids), one);
  await assert.rejects(service.load("eur", []), /No assets/);
  assert.equal(requests.length, 1);
});
