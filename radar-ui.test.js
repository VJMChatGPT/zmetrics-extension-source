import test from "node:test";
import assert from "node:assert/strict";
import { buildRadarPresentation, nextRadarExpiry, radarSeenKey, createRadarSeenState } from "./radar-ui.js";
import { createMarketQuery, normalizeMarkets } from "./market-data.js";

const NOW = 1800000000000;
const coins = ids => ids.map(id => ({ id, symbol: id.toUpperCase() }));
function data(changes) {
  return normalizeMarkets(Object.entries(changes).map(([id, change]) => ({
    id, current_price: 10, price_change_percentage_24h_in_currency: change,
    last_updated: new Date(NOW - 1000).toISOString()
  })), createMarketQuery("usd", Object.keys(changes)), NOW);
}
const present = (changes, ids, options = {}) => buildRadarPresentation({ snapshot: data(changes), coins: coins(ids), now: NOW, ...options });

test("presentation distinguishes empty, loading, failed and quiet states", () => {
  assert.equal(present({}, []).status, "empty");
  assert.equal(buildRadarPresentation({ snapshot: null, coins: coins(["a"]), now: NOW }).status, "loading");
  assert.equal(present({ bitcoin: 0, a: 0 }, ["a"], { loading: true }).status, "loading");
  assert.equal(present({ bitcoin: 0, a: 0 }, ["a"], { error: new Error("offline") }).status, "error");
  const quiet = present({ bitcoin: 0, a: 1, b: 0, c: -1 }, ["a", "b", "c"]);
  assert.equal(quiet.status, "quiet");
  assert.equal(quiet.observations.length, 0);
  assert.match(quiet.message, /No notable differences/);
});

test("BTC text differentiates percentage points from asset returns, including negative outperformance", () => {
  const up = present({ bitcoin: -10, a: -5 }, ["a"]);
  assert.equal(up.observations[0].headline, "A outpaces BTC");
  assert.equal(up.observations[0].metric, "+5.00 pp");
  assert.match(up.observations[0].metricLabel, /percentage points/);
  assert.equal(up.observations[0].detail, "24h: A -5.00% · BTC -10.00%");
  const down = present({ bitcoin: 1, a: -5 }, ["a"]);
  assert.equal(down.observations[0].headline, "A trails BTC");
  assert.equal(down.observations[0].metric, "-6.00 pp");
  assert.equal(down.observations[0].tone, "down");
});

test("all supported observation types have accurate compact copy", () => {
  const peer = present({ a: -5, b: 0, c: 0 }, ["a", "b", "c"]);
  assert.equal(peer.observations[0].headline, "A below peers");
  assert.equal(peer.observations[0].metric, "-5.00 pp");
  assert.equal(peer.observations[0].detail, "Other assets’ equal-weight 24h avg: 0.00%");
  const leader = present({ a: -1, b: -7 }, ["a", "b"]);
  assert.equal(leader.observations[0].headline, "A leads watchlist");
  assert.equal(leader.observations[0].metric, "-1.00%");
  assert.equal(leader.observations[0].detail, "Watchlist equal-weight 24h avg: -4.00%");
  assert.equal(leader.observations[0].tone, "down");
  const weak = present({ a: -3, b: 3, c: 1, d: 1 }, ["a", "b", "c", "d"]);
  assert.equal(weak.observations[0].headline, "A trails watchlist");
  const broad = present({ bitcoin: -3, a: -3, b: -3, c: -3 }, ["a", "b", "c"]);
  assert.equal(broad.observations[0].headline, "Watchlist average");
  assert.equal(broad.observations[0].metric, "-3.00%");
  assert.equal(broad.observations[0].detail, "Equal-weight 24h average · 3 assets");
});

test("partial, missing, incoherent and stale data are not described as a quiet market", () => {
  assert.equal(present({ bitcoin: 0, a: 0 }, ["a", "missing"]).status, "insufficient-data");
  const stale = present({ bitcoin: 0, a: 10 }, ["a"], { now: NOW + 5 * 60000 + 1 });
  assert.equal(stale.status, "stale");
  assert.equal(stale.observations.length, 0);
  const partial = present({ bitcoin: 0, a: 10 }, ["a", "missing"]);
  assert.equal(partial.status, "observations");
  assert.match(partial.note, /Some assets lack fresh data/);
  assert.equal(partial.observations.length, 1);
  const noBtc = present({ a: 4, b: 4, c: 4 }, ["a", "b", "c"]);
  assert.equal(noBtc.note, "BTC comparison unavailable.");
});

test("presentation preserves the engine's top-three ordering and does not mutate snapshots", () => {
  const snapshot = data({ bitcoin: 20, a: 16, b: 4, c: 4 });
  const before = structuredClone(snapshot);
  const result = buildRadarPresentation({ snapshot, coins: coins(["a", "b", "c"]), now: NOW });
  assert.equal(result.observations.length, 3);
  assert.equal(result.observations[0].headline, "B trails BTC");
  assert.equal(result.observations[1].headline, "Watchlist average");
  assert.equal(result.observations[1].metric, "+8.00%");
  assert.equal(result.observations[2].headline, "A above peers");
  assert.deepEqual(snapshot, before);
});

test("coin labels are plain text and no HTML strings or external requests are constructed", () => {
  const result = buildRadarPresentation({ snapshot: data({ bitcoin: 0, a: 10 }),
    coins: [{ id: "a", symbol: '<img src=x onerror="bad()">' }], now: NOW });
  assert.equal(result.observations[0].headline, '<img src=x onerror="bad()"> outpaces BTC');
  const fallback = buildRadarPresentation({ snapshot: data({ bitcoin: 0, a: 10 }), coins: [{ id: "a" }], now: NOW });
  assert.equal(fallback.observations[0].headline, "a outpaces BTC");
});

test("every metric has explicit financial units and accessible context without repeating it in the headline", () => {
  const result = present({ bitcoin: 20, a: 16, b: 4, c: 4 }, ["a", "b", "c"]);
  for (const observation of result.observations) {
    assert.match(observation.metric, /^[+-]\d+\.\d{2}( pp|%)$/);
    assert.match(observation.metricLabel, /24h/);
    assert.doesNotMatch(observation.headline, /%| pp/);
    assert.match(observation.detail, /24h/);
  }
  assert.match(result.observations[1].metricLabel, /not portfolio return/);
});

test("expiry follows the oldest relevant quote plus the inclusive age boundary, not repaint time", () => {
  const snapshot = data({ bitcoin: 0, a: 10, unselected: 3 });
  snapshot.markets.unselected.updatedAt = NOW - 200000;
  assert.equal(nextRadarExpiry(snapshot, coins(["a"]), NOW), NOW - 1000 + 300000 + 1);
  snapshot.markets.bitcoin.updatedAt = NOW - 2000;
  assert.equal(nextRadarExpiry(snapshot, coins(["a"]), NOW), NOW - 2000 + 300000 + 1);
  assert.equal(nextRadarExpiry(snapshot, [], NOW), null);
  assert.equal(nextRadarExpiry(null, coins(["a"]), NOW), null);
  assert.equal(nextRadarExpiry(snapshot, coins(["a"]), NOW + 300001), null);
});

test("seen keys identify semantic signals, not timestamps, numbers, symbols or currency", () => {
  const first = present({ bitcoin: 0, a: 10 }, ["a"]).observations[0].seenKey;
  assert.equal(first, present({ bitcoin: 1, a: 12 }, ["a"]).observations[0].seenKey);
  assert.notEqual(first, present({ bitcoin: 0, a: -10 }, ["a"]).observations[0].seenKey);
  assert.notEqual(first, present({ bitcoin: 0, b: 10 }, ["b"]).observations[0].seenKey);
  const snapshot = data({ bitcoin: 0, a: 10 });
  snapshot.currency = "eur";
  assert.equal(first, buildRadarPresentation({ snapshot, coins: [{ id: "a", symbol: "RENAMED" }], now: NOW }).observations[0].seenKey);
  assert.notEqual(radarSeenKey({ type: "strongest-performer", assetId: "a", change24h: 2 }),
    radarSeenKey({ type: "strongest-performer", assetId: "a", change24h: -2 }));
});

const settleSeen = () => new Promise(resolve => setImmediate(resolve));
test("local read-state survives reopening, ignores unchanged refreshes and only acknowledges visible observations", async () => {
  const stored = {}, writes = [], reads = [];
  let unread;
  const create = () => createRadarSeenState({
    read: async keys => { reads.push(keys); return { ...stored }; },
    write: async values => { writes.push(values); Object.assign(stored, values); },
    onChange: values => { unread = values; }
  });
  const a = radarSeenKey({ type: "btc-relative", assetId: "a", direction: "outperforming" });
  const b = radarSeenKey({ type: "peer-divergence", assetId: "b", direction: "below" });
  const first = create();
  first.update([a, b]);
  await settleSeen();
  assert.deepEqual(unread, [a, b]);
  assert.equal(writes.length, 0);
  first.update([a, b], [a]); // Only the main observation is exposed.
  await settleSeen();
  assert.deepEqual(unread, [b]);
  assert.deepEqual(Object.keys(stored), [a]);
  first.update([a, b], [a, b]);
  await settleSeen();
  assert.deepEqual(unread, []);
  first.update([b, a]);
  first.update([]); // Error/stale/quiet cannot create or clear persistent flags.
  first.update([a, b]);
  await settleSeen();
  assert.equal(writes.length, 2);
  assert.equal(reads.length, 1);
  const reopened = create();
  reopened.update([a, b]);
  await settleSeen();
  assert.deepEqual(unread, []);
  assert.equal(writes.length, 2);
});

test("late reads, simultaneous surfaces and local changes do not resurrect seen signals", async () => {
  const a = radarSeenKey({ type: "watchlist-move", direction: "up" });
  let finish, unread;
  const writes = [];
  const state = createRadarSeenState({ read: () => new Promise(resolve => { finish = resolve; }),
    write: async values => writes.push(values), onChange: value => { unread = value; } });
  state.update([a]); await settleSeen();
  state.receive({ [a]: { newValue: true } }); // Another surface viewed it.
  finish({}); await settleSeen(); // Older storage read must not undo that.
  assert.deepEqual(unread, []);
  state.update([a], [a]); await settleSeen();
  assert.equal(writes.length, 0);
  const late = createRadarSeenState({ read: () => new Promise(resolve => { finish = resolve; }),
    write: async values => writes.push(values), onChange: value => { unread = value; } });
  late.update([a], [a]); await settleSeen();
  late.update([]); // Data became stale while reading local state.
  finish({}); await settleSeen();
  assert.deepEqual(unread, []);
  assert.equal(writes.length, 0);
});

test("read-state failures suppress notification uncertainty without breaking Radar", async () => {
  const a = radarSeenKey({ type: "watchlist-move", direction: "down" });
  let unread;
  for (const failRead of [true, false]) {
    const state = createRadarSeenState({
      read: async () => { if (failRead) throw new Error("unavailable"); return {}; },
      write: async () => { throw new Error("unavailable"); },
      onChange: value => { unread = value; }
    });
    state.update([a], [a]); await settleSeen();
    assert.deepEqual(unread, []);
    assert.doesNotThrow(() => state.update([a]));
    assert.deepEqual(unread, []);
  }
});
