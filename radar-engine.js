import { BTC_BENCHMARK_ID } from "./market-data.js";

// Product heuristics, NOT historical/statistical anomaly thresholds. Units and
// selection rules are documented in RADAR_ENGINE.md. All calculations are local.
export const RADAR_DEFAULTS = Object.freeze({
  maxDataAgeMs: 5 * 60 * 1000,
  maxQuoteSkewMs: 2 * 60 * 1000,
  btcRelativePp: 4,
  peerDivergencePp: 5,
  performerSpreadPp: 6,
  performerGapPp: 2,
  watchlistMovePercent: 3,
  breadthMovePercent: 1,
  minDirectionalBreadth: 2 / 3,
  minPeerAssets: 3,
  minMoveAssets: 3,
  maxObservations: 3
});

function settings(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) ||
      Object.keys(overrides).some(key => !Object.hasOwn(RADAR_DEFAULTS, key))) {
    throw new TypeError("Invalid Radar thresholds");
  }
  const config = { ...RADAR_DEFAULTS, ...overrides };
  if (Object.values(config).some(value => !Number.isFinite(value) || value <= 0) ||
      config.minDirectionalBreadth > 1 ||
      !Number.isInteger(config.minPeerAssets) || config.minPeerAssets < 3 ||
      !Number.isInteger(config.minMoveAssets) || config.minMoveAssets < 2 ||
      !Number.isInteger(config.maxObservations) || config.maxObservations > 3) {
    throw new RangeError("Invalid Radar thresholds");
  }
  return config;
}

const finite = value => Number.isFinite(value) ? value : null;
// Divide before summing to avoid overflowing a sum of otherwise finite returns.
const average = values => values.length
  ? finite(values.reduce((sum, value) => sum + value / values.length, 0)) : null;
const difference = (a, b) => a === null || b === null ? null : finite(a - b);
const alphabetical = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function readAsset(snapshot, id, now, config, snapshotIssue) {
  if (snapshotIssue) return { id, reason: snapshotIssue };
  const market = Object.hasOwn(snapshot.markets, id) ? snapshot.markets[id] : null;
  if (!market || market.id !== id) return { id, reason: "missing-market" };
  if (!Number.isFinite(market.change24h) || market.change24h < -100) {
    return { id, reason: "invalid-change" };
  }
  // Stricter than the price UI: fetching recently does not establish provider
  // freshness when last_updated is absent. Do not guess for Radar comparisons.
  if (!Number.isFinite(market.updatedAt) || market.updatedAt < 0 || market.updatedAt > snapshot.fetchedAt) {
    return { id, reason: "invalid-timestamp" };
  }
  if (now - market.updatedAt > config.maxDataAgeMs) return { id, reason: "stale-market" };
  return { id, change24h: market.change24h, updatedAt: market.updatedAt };
}

/**
 * Pure Stage 2 entry point. `now` is REQUIRED (epoch milliseconds), so identical
 * inputs always produce identical output. Pass only enabled watchlist IDs; BTC
 * in snapshot.markets is not treated as selected unless it is in watchlistIds.
 * Output is structured facts, not UI copy, predictions or trading advice.
 */
export function analyzeWatchlist(snapshot, watchlistIds, { now, thresholds = {} } = {}) {
  if (!Number.isFinite(now) || now < 0) throw new RangeError("Radar requires a valid explicit now");
  const config = settings(thresholds);
  const ids = [...new Set((Array.isArray(watchlistIds) ? watchlistIds : [])
    .filter(id => typeof id === "string" && id.trim() && !id.includes(",")))].sort();
  let snapshotIssue = null;
  if (!snapshot || !["usd", "eur"].includes(snapshot.currency) ||
      !snapshot.markets || typeof snapshot.markets !== "object" || Array.isArray(snapshot.markets) ||
      !Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt < 0 || snapshot.fetchedAt > now) {
    snapshotIssue = "invalid-snapshot";
  } else if (now - snapshot.fetchedAt > config.maxDataAgeMs) {
    snapshotIssue = "stale-snapshot";
  }
  const rows = ids.map(id => readAsset(snapshot, id, now, config, snapshotIssue));
  const eligible = rows.filter(row => !row.reason);
  const benchmark = readAsset(snapshot, BTC_BENCHMARK_ID, now, config, snapshotIssue);
  const complete = eligible.length === ids.length;
  const times = eligible.map(row => row.updatedAt);
  const coherent = times.length > 0 && Math.max(...times) - Math.min(...times) <= config.maxQuoteSkewMs;
  const changes = eligible.map(row => row.change24h);
  const mean = coherent ? average(changes) : null;
  const highest = coherent ? Math.max(...changes) : null;
  const lowest = coherent ? Math.min(...changes) : null;
  const strongest = highest === null ? null : { ids: eligible.filter(row => row.change24h === highest).map(row => row.id), change24h: highest };
  const weakest = lowest === null ? null : { ids: eligible.filter(row => row.change24h === lowest).map(row => row.id), change24h: lowest };
  const spreadPp = difference(highest, lowest);
  const assets = eligible.map(row => {
    const peers = eligible.filter(peer => peer.id !== row.id);
    const peersAverage24h = coherent && complete && eligible.length >= config.minPeerAssets
      ? average(peers.map(peer => peer.change24h)) : null;
    const btcComparable = row.id !== BTC_BENCHMARK_ID && !benchmark.reason &&
      Math.abs(row.updatedAt - benchmark.updatedAt) <= config.maxQuoteSkewMs;
    return {
      ...row,
      btcGapPp: btcComparable ? difference(row.change24h, benchmark.change24h) : null,
      peersAverage24h,
      peersGapPp: difference(row.change24h, peersAverage24h)
    };
  });

  const candidates = [];
  function add(type, family, assetId, relevance, facts) {
    if (!Number.isFinite(relevance)) return;
    candidates.push({ type, family, assetId, relevance, ...facts });
  }
  for (const asset of assets) {
    if (asset.btcGapPp !== null && Math.abs(asset.btcGapPp) >= config.btcRelativePp) {
      add("btc-relative", "btc-relative", asset.id, Math.abs(asset.btcGapPp) / config.btcRelativePp, {
        direction: asset.btcGapPp > 0 ? "outperforming" : "underperforming",
        change24h: asset.change24h, btcChange24h: benchmark.change24h, gapPp: asset.btcGapPp
      });
    }
    if (asset.peersGapPp !== null && Math.abs(asset.peersGapPp) >= config.peerDivergencePp) {
      add("peer-divergence", "peer-divergence", asset.id, Math.abs(asset.peersGapPp) / config.peerDivergencePp, {
        direction: asset.peersGapPp > 0 ? "above" : "below",
        change24h: asset.change24h, peersAverage24h: asset.peersAverage24h,
        gapPp: asset.peersGapPp, peerCount: assets.length - 1
      });
    }
  }
  const rankingRepeatsBtcPair = assets.length === 2 && ids.includes(BTC_BENCHMARK_ID) &&
    candidates.some(candidate => candidate.type === "btc-relative");
  if (!rankingRepeatsBtcPair && complete && coherent && assets.length >= 2 && spreadPp !== null && spreadPp >= config.performerSpreadPp && mean !== null) {
    for (const [type, performer] of [["strongest-performer", strongest], ["weakest-performer", weakest]]) {
      const gapPp = difference(performer.change24h, mean);
      if (performer.ids.length === 1 && gapPp !== null && Math.abs(gapPp) >= config.performerGapPp) {
        // Don't prefer a ranking merely because its admission threshold is lower.
        add(type, "performer", performer.ids[0], Math.abs(gapPp) / Math.max(config.btcRelativePp, config.peerDivergencePp), {
          change24h: performer.change24h, averageChange24h: mean, gapPp, spreadPp, assetCount: assets.length
        });
      }
    }
  }
  if (complete && coherent && assets.length >= config.minMoveAssets && mean !== null && Math.abs(mean) >= config.watchlistMovePercent) {
    const aligned = assets.filter(asset => mean > 0
      ? asset.change24h >= config.breadthMovePercent : asset.change24h <= -config.breadthMovePercent).length;
    const breadth = aligned / assets.length;
    if (breadth >= config.minDirectionalBreadth) {
      add("watchlist-move", "watchlist-move", null, Math.abs(mean) / config.watchlistMovePercent * breadth, {
        direction: mean > 0 ? "up" : "down", averageChange24h: mean, assetCount: assets.length, breadth
      });
    }
  }

  const priority = ["peer-divergence", "btc-relative", "watchlist-move", "strongest-performer", "weakest-performer"];
  candidates.sort((a, b) => b.relevance - a.relevance || priority.indexOf(a.type) - priority.indexOf(b.type) ||
    alphabetical(a.assetId || "", b.assetId || ""));
  const families = new Set(), mentionedAssets = new Set(), observations = [];
  // Pick the best candidate per family BEFORE cross-family de-duplication. Do
  // not replace a suppressed outlier with a weaker observation about its peers.
  for (const candidate of candidates) {
    if (families.has(candidate.family)) continue;
    families.add(candidate.family);
    if (candidate.assetId && mentionedAssets.has(candidate.assetId)) continue;
    if (candidate.assetId) mentionedAssets.add(candidate.assetId);
    const { family, ...observation } = candidate;
    observations.push(observation);
    if (observations.length === config.maxObservations) break;
  }
  let status = "quiet";
  if (!ids.length) status = "empty";
  else if (observations.length) status = "observations";
  else if (!complete || !coherent || (assets.length === 1 && assets[0].id !== BTC_BENCHMARK_ID && assets[0].btcGapPp === null)) {
    status = "insufficient-data";
  }
  return {
    status,
    currency: snapshotIssue === "invalid-snapshot" ? null : snapshot.currency,
    coverage: {
      selectedCount: ids.length, eligibleCount: assets.length, complete, coherent,
      excluded: rows.filter(row => row.reason), benchmark
    },
    // This summary describes ELIGIBLE assets only. Whole-watchlist signals above
    // additionally require complete coverage, so missing losers cannot be hidden.
    summary: { scope: "eligible-assets", assetCount: assets.length, averageChange24h: mean, strongest, weakest, spreadPp },
    assets,
    observations
  };
}
